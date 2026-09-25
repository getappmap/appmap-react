import type {
  AppMap,
  ClassMapEntry,
  ClassEntry,
  Event,
  FunctionInfo,
  Metadata,
  PackageEntry,
  ParameterValue,
  ParameterProperty,
} from './types.js';
import { className, functionName, readDataProperty, safeStringify } from './stringify.js';
import { currentCallId } from './session.js';
import { isSensitiveName, redactHeaders, redactString, REDACTED } from './redact.js';

/** The AppMap version this recorder declares. Checked against the
 * official validator (@appland/appmap-validate) in
 * recorder/test/validity.test.ts; see docs/design/12. */
export const APPMAP_VERSION = '1.12';

/** Default maximum captured length of any single value string, like
 * APPMAP_EVENT_VALUESIZE in the .NET agent: 100, the length the AppMap
 * spec says values are trimmed to (schemas 1.6+ enforce it). The cap
 * includes the "…" marking a cut. Overridable at runtime via
 * setValueSizeCap (wired to the APPMAP_EVENT_VALUESIZE env var by
 * testRecording.ts and vitePlugin.ts). */
export const VALUE_SIZE_CAP = 100;

let currentValueSizeCap = VALUE_SIZE_CAP;

/** Override the value-size cap at runtime (see VALUE_SIZE_CAP). */
export function setValueSizeCap(n: number): void {
  currentValueSizeCap = n;
}

/** Tracks object identity within one recording so repeated references to
 * the same object across events share an object_id, per the AppMap spec. */
export interface ObjectIdTracker {
  ids: WeakMap<object, number>;
  next: number;
}

export function formatValue(
  v: unknown,
  tracker?: ObjectIdTracker,
  name?: string,
): { class: string; value: string; size?: number; object_id?: number; properties?: ParameterProperty[] } {
  // Never JSON.stringify / String() an unknown value: that runs its
  // getters and toJSON and can change what the app does (stringify.ts).
  const cls = v === undefined ? 'undefined' : className(v);

  let str: string;
  if (isSensitiveName(name)) str = REDACTED;
  else if (typeof v === 'string') str = redactString(v);
  else if (typeof v === 'function') str = `[function ${functionName(v) || 'anonymous'}]`;
  else if (v === undefined) str = 'undefined';
  else if (typeof v === 'symbol') str = v.toString();
  else if (typeof v === 'bigint') str = String(v);
  else {
    try {
      str = safeStringify(v, currentValueSizeCap);
    } catch {
      str = `[${cls}]`;
    }
  }
  str = capValue(str);

  const result: { class: string; value: string; size?: number; object_id?: number; properties?: ParameterProperty[] } = {
    class: cls,
    value: str,
  };
  const properties = plainObjectProperties(v);
  if (properties) result.properties = properties;

  if (v !== null && typeof v === 'object') {
    result.size = Array.isArray(v) ? ownLength(v) : Object.keys(v as object).length;
    if (tracker) {
      let id = tracker.ids.get(v as object);
      if (id === undefined) {
        id = tracker.next++;
        tracker.ids.set(v as object, id);
      }
      result.object_id = id;
    }
  }

  return result;
}

const MAX_PROPERTIES = 50;

/** The spec's parameter `properties` for a plain object (prototype
 * Object.prototype or null): each own enumerable data property's name and
 * class, read from descriptors only (no getter is run; accessors are left
 * out). A value is cut to 100 characters, so without this an argument like
 * `{ email, firstName, lastName, password, teamName }` lost its last
 * fields entirely. */
function plainObjectProperties(v: unknown): ParameterProperty[] | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out: ParameterProperty[] = [];
  for (const key of Object.keys(v as object)) {
    if (out.length >= MAX_PROPERTIES) break;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !('value' in d)) continue;
    out.push({ name: key, class: d.value === undefined ? 'undefined' : className(d.value) });
  }
  return out.length ? out : undefined;
}

/** Cut a value string to the cap, "…" included (no off-by-one), never
 * splitting a surrogate pair. */
export function capValue(str: string): string {
  if (str.length <= currentValueSizeCap) return str;
  let end = Math.max(0, currentValueSizeCap - 1);
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return str.slice(0, end) + '…';
}

/** Split a URL into what http_*_request events carry: the URL without
 * its query string (and fragment), and the query parameters as a
 * `message` array. */
export function splitUrl(raw: string): { url: string; message: ParameterValue[] } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    const q = raw.indexOf('?');
    const bare = raw.split('#')[0];
    return q === -1 ? { url: bare, message: [] } : { url: bare.slice(0, q), message: queryMessage(new URLSearchParams(bare.slice(q + 1))) };
  }
  return { url: `${u.origin}${u.pathname}`, message: queryMessage(u.searchParams) };
}

export function queryMessage(params: URLSearchParams): ParameterValue[] {
  const message: ParameterValue[] = [];
  for (const [name, value] of params) {
    message.push({ name, class: 'String', value: isSensitiveName(name) ? REDACTED : capValue(redactString(value)) });
  }
  return message;
}

/** Class of a thrown value: its constructor's name for objects (a
 * thrown plain object is an "Object", not "object"), typeof otherwise. */
function exceptionClass(e: unknown): string {
  return e !== null && (typeof e === 'object' || typeof e === 'function') ? className(e) : typeof e;
}

/** Message of a thrown value, read without running app code: an own or
 * inherited `message` data property if it is a string (Error, and the
 * plain error objects libraries like supabase-js throw), otherwise the
 * value itself rendered as a parameter would be — never String(e),
 * which printed "[object Object]" and runs toString. */
function exceptionMessage(e: unknown): string {
  const message = readDataProperty(e, 'message');
  if (typeof message === 'string') return redactString(message);
  if (e !== null && typeof e === 'object') return formatValue(e).value;
  return redactString(String(e));
}

function ownLength(a: unknown[]): number {
  const d = Object.getOwnPropertyDescriptor(a, 'length');
  return d && typeof d.value === 'number' ? d.value : 0;
}

/** Handle returned by Recording.enter; consumed exactly once by exit.
 * Same contract as the Go recorder spike's CallToken: the injected
 * epilogue (here, a `finally` block) must call exit with it. Carries its
 * own thread_id (see the thread-assignment design in
 * docs/design/01-recording-sessions-and-interaction-windows.md, 2026
 * amendment) so exit/response methods don't have to re-derive it. */
export interface CallToken {
  callId: number;
  startMs: number;
  threadId: number;
}

/** An http_*_request that never got a response the format can express
 * (network error, or still in flight when the recording closed). Kept
 * out of the event stream — an http_*_response needs a real 100-599
 * status — and listed in metadata instead (docs/design/12). */
export interface UnansweredHttpRequest {
  event: 'http_client_request' | 'http_server_request';
  request_method: string;
  url: string;
  reason: 'network error' | 'no response before the recording closed';
}

export class Recording {
  /** The live event stream, in the order things happened. `toAppMap()`
   * serializes it as a call tree (see there). */
  readonly events: Event[] = [];
  readonly metadata: Metadata;
  private nextId = 1;
  private functions = new Map<string, FunctionInfo>();
  private objectIds: ObjectIdTracker = { ids: new WeakMap(), next: 1 };
  // callId -> the call it was made from (undefined: a root). Sync nesting
  // from `syncStack`; async continuations from the async context
  // (session.ts currentCallId), where the runtime has one.
  private parentOf = new Map<number, number | undefined>();

  // Thread assignment (docs/design/01, 2026 amendment) for the *live*
  // event stream: each thread_id's own event subsequence must
  // independently nest like balanced parentheses. `syncStack` mirrors
  // the real, single-threaded JS call stack — entries leave it the
  // instant a call yields control back to its caller (returns
  // synchronously, or hands back a pending Promise), even though the
  // call may still be logically open. A call started while its would-be
  // parent thread already has another call that has left its sync frame
  // but not yet settled (a genuine concurrent sibling, e.g. one leg of a
  // Promise.all) gets a fresh thread instead of corrupting the parent
  // thread's nesting. The serialized map re-threads everything as one
  // tree (toAppMap).
  private syncStack: number[] = [];
  private openCalls = new Map<number, number>(); // callId -> threadId
  private danglingByThread = new Map<number, Set<number>>(); // threadId -> callIds that left their sync frame, still open
  private nextThreadId = 2;
  private readonly primaryThreadId = 1;

  constructor(metadata: Metadata) {
    this.metadata = { ...metadata, trace_id: randomHex(16) };
  }

  /** One trace id per recording — the frontend half of the
   * traceparent join (docs/design/02). Reads live from
   * `metadata.trace_id` so a backend driver can copy in an inbound
   * trace id after construction and outbound fetches still join it. */
  get traceId(): string {
    return this.metadata.trace_id!;
  }

  /** The call a new call would be made from right now: the innermost
   * synchronously executing call, else the call whose async
   * continuation is running (where the runtime has async context). */
  currentParent(): number | undefined {
    return this.syncStack[this.syncStack.length - 1] ?? currentCallId(this);
  }

  private allocateThread(): number {
    const parent = this.syncStack[this.syncStack.length - 1];
    if (parent !== undefined) {
      const parentThread = this.openCalls.get(parent)!;
      return this.hasDangling(parentThread) ? this.nextThreadId++ : parentThread;
    }
    if (this.openCalls.size === 0) return this.primaryThreadId;
    return this.hasDangling(this.primaryThreadId) ? this.nextThreadId++ : this.primaryThreadId;
  }

  private hasDangling(threadId: number): boolean {
    const set = this.danglingByThread.get(threadId);
    return !!set && set.size > 0;
  }

  private markDangling(threadId: number, callId: number): void {
    let set = this.danglingByThread.get(threadId);
    if (!set) {
      set = new Set();
      this.danglingByThread.set(threadId, set);
    }
    set.add(callId);
  }

  /** Open a call that always leaves its sync frame immediately — used by
   * the http_client_request/http_server_request events, which have no
   * instrumented children of their own and settle asynchronously. */
  private openDangling(parent: number | undefined): { callId: number; threadId: number } {
    const callId = this.nextId++;
    const threadId = this.allocateThread();
    this.parentOf.set(callId, parent);
    this.openCalls.set(callId, threadId);
    this.markDangling(threadId, callId);
    return { callId, threadId };
  }

  /** Move an open call from the sync stack to "dangling" — called by the
   * instrument() wrapper the instant a wrapped call hands back a pending
   * Promise, i.e. the moment it yields control back to its caller. */
  leaveSyncFrame(token: CallToken): void {
    const idx = this.syncStack.lastIndexOf(token.callId);
    if (idx !== -1) this.syncStack.splice(idx, 1);
    this.markDangling(token.threadId, token.callId);
  }

  private closeCall(token: CallToken): void {
    this.openCalls.delete(token.callId);
    this.danglingByThread.get(token.threadId)?.delete(token.callId);
    const idx = this.syncStack.lastIndexOf(token.callId);
    if (idx !== -1) this.syncStack.splice(idx, 1);
  }

  enter(fn: FunctionInfo, args?: { name?: string; value: unknown }[]): CallToken {
    const key = `${fn.path}:${fn.lineno ?? ''}:${fn.definedClass}.${fn.methodId}`;
    if (!this.functions.has(key)) this.functions.set(key, fn);

    const parent = this.currentParent();
    const id = this.nextId++;
    const threadId = this.allocateThread();
    this.parentOf.set(id, parent);
    this.syncStack.push(id);
    this.openCalls.set(id, threadId);

    const parameters: ParameterValue[] | undefined = args?.map((a) => ({
      name: a.name,
      ...formatValue(a.value, this.objectIds, a.name),
    }));
    this.events.push({
      id,
      event: 'call',
      thread_id: threadId,
      defined_class: fn.definedClass,
      method_id: fn.methodId,
      path: fn.path,
      lineno: fn.lineno,
      // Always correct today: only module-level functions (components,
      // hooks, handlers) are instrumented — there is no class/instance
      // distinction yet. Revisit if instance-method instrumentation is
      // ever added.
      static: true,
      ...(parameters && parameters.length ? { parameters } : {}),
    });
    return { callId: id, startMs: performance.now(), threadId };
  }

  exit(token: CallToken, outcome: { returnValue?: unknown; exception?: unknown }): void {
    const elapsed = (performance.now() - token.startMs) / 1000;
    this.closeCall(token);
    if (outcome.exception !== undefined) {
      const e = outcome.exception;
      this.events.push({
        id: this.nextId++,
        event: 'return',
        thread_id: token.threadId,
        parent_id: token.callId,
        elapsed,
        exceptions: [
          {
            class: exceptionClass(e),
            message: exceptionMessage(e),
            object_id: this.objectId(e),
          },
        ],
      });
    } else {
      this.events.push({
        id: this.nextId++,
        event: 'return',
        thread_id: token.threadId,
        parent_id: token.callId,
        elapsed,
        ...(outcome.returnValue !== undefined
          ? { return_value: formatValue(outcome.returnValue, this.objectIds) }
          : {}),
      });
    }
  }

  /** object_id for any value: shared by repeated references to the same
   * object, fresh for primitives (the spec requires one on exceptions). */
  private objectId(v: unknown): number {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return this.objectIds.next++;
    let id = this.objectIds.ids.get(v);
    if (id === undefined) {
      id = this.objectIds.next++;
      this.objectIds.ids.set(v, id);
    }
    return id;
  }

  /** `url` may carry a query string; it is split off into `message`, as
   * the spec wants. `parent` overrides the call it was made from (for
   * requests whose event is recorded later than the call that made
   * them, e.g. XMLHttpRequest). */
  httpClientRequest(
    method: string,
    url: string,
    headers?: Record<string, string>,
    parent: number | undefined = this.currentParent(),
  ): CallToken {
    const { callId: id, threadId } = this.openDangling(parent);
    const split = splitUrl(url);
    this.events.push({
      id,
      event: 'call',
      thread_id: threadId,
      http_client_request: {
        request_method: method,
        url: split.url,
        ...(headers && Object.keys(headers).length ? { headers: redactHeaders(headers) } : {}),
      },
      message: split.message,
    });
    return { callId: id, startMs: performance.now(), threadId };
  }

  /** statusCode 0 means there was no response (network error, abort). */
  httpClientResponse(token: CallToken, statusCode: number, headers?: Record<string, string>): void {
    this.closeCall(token);
    this.events.push({
      id: this.nextId++,
      event: 'return',
      thread_id: token.threadId,
      parent_id: token.callId,
      elapsed: (performance.now() - token.startMs) / 1000,
      http_client_response: {
        status_code: statusCode,
        ...(headers && Object.keys(headers).length ? { headers: redactHeaders(headers) } : {}),
      },
    });
  }

  /** Server-side twin of httpClientRequest, for recorders running inside
   * a backend request handler (e.g. the Deno driver in deno/appmap.ts).
   * `query` becomes the event's `message`. */
  httpServerRequest(
    method: string,
    pathInfo: string,
    headers?: Record<string, string>,
    normalizedPathInfo?: string,
    query?: URLSearchParams,
  ): CallToken {
    const { callId: id, threadId } = this.openDangling(this.currentParent());
    this.events.push({
      id,
      event: 'call',
      thread_id: threadId,
      http_server_request: {
        request_method: method,
        path_info: pathInfo,
        ...(normalizedPathInfo ? { normalized_path_info: normalizedPathInfo } : {}),
        ...(headers && Object.keys(headers).length ? { headers: redactHeaders(headers) } : {}),
      },
      message: query ? queryMessage(query) : [],
    });
    return { callId: id, startMs: performance.now(), threadId };
  }

  httpServerResponse(token: CallToken, statusCode: number): void {
    this.closeCall(token);
    this.events.push({
      id: this.nextId++,
      event: 'return',
      thread_id: token.threadId,
      parent_id: token.callId,
      elapsed: (performance.now() - token.startMs) / 1000,
      http_server_response: { status_code: statusCode },
    });
  }

  /** Number of calls opened but not yet returned. Non-zero at
   * serialization time means the recording is being closed with work
   * still in flight (a hard teardown). */
  openCallCount(): number {
    return this.openCalls.size;
  }

  /** Serialize to AppMap (APPMAP_VERSION). The classMap contains exactly
   * the functions that produced events, grouped package-per-directory
   * like appmap-agent-js.
   *
   * Events are emitted as a call tree (docs/design/12): every call sits
   * between its parent's call and return — the parent being the call it
   * was made from, synchronously or from an async continuation — with
   * ids renumbered in that order and one thread_id. Standard tooling
   * (the official validator, `appmap sequence-diagram`) rebuilds the
   * tree positionally per thread, so this is what makes a request one
   * tree rooted at its http_server_request, and keeps an async call's
   * children under it after its caller has already returned. The live
   * `events` list is untouched.
   *
   * Self-healing (docs/design/11): any function call still open at this
   * point gets a synthesized `return`, so the tree is always balanced —
   * an unbalanced list makes downstream tools that reconstruct the call
   * stack throw ("failed trying to compute event stack, call.id: N").
   * Synthetic returns carry no elapsed/return_value and are flagged
   * collectively by metadata.truncated. HTTP calls without a response
   * the format can express are listed in metadata.unanswered_http_requests
   * instead (their children, if any, move up to their parent). */
  toAppMap(overrides?: Partial<Metadata>): AppMap {
    const calls = this.events.filter((e) => e.event === 'call');
    const returns = new Map<number, Event>();
    for (const e of this.events) if (e.event === 'return') returns.set(e.parent_id, e);
    const known = new Set(calls.map((c) => c.id));
    const children = new Map<number | undefined, Event[]>();
    for (const call of calls) {
      let parent = this.parentOf.get(call.id);
      if (parent !== undefined && !known.has(parent)) parent = undefined;
      const list = children.get(parent) ?? [];
      list.push(call);
      children.set(parent, list);
    }

    const out: Event[] = [];
    const unanswered: UnansweredHttpRequest[] = [];
    let truncated = false;
    let nextId = 1;
    const threadId = 1;
    const emit = (call: Event): void => {
      const ret = returns.get(call.id);
      if ('http_client_request' in call || 'http_server_request' in call) {
        const status =
          ret && 'http_client_response' in ret
            ? ret.http_client_response.status_code
            : ret && 'http_server_response' in ret
              ? ret.http_server_response.status_code
              : undefined;
        if (status === undefined || status < 100 || status > 599) {
          if (!ret) truncated = true;
          unanswered.push(
            'http_client_request' in call
              ? {
                  event: 'http_client_request',
                  request_method: call.http_client_request.request_method,
                  url: call.http_client_request.url,
                  reason: ret ? 'network error' : 'no response before the recording closed',
                }
              : {
                  event: 'http_server_request',
                  request_method: call.http_server_request.request_method,
                  url: call.http_server_request.path_info,
                  reason: 'no response before the recording closed',
                },
          );
          for (const child of children.get(call.id) ?? []) emit(child);
          return;
        }
      }
      const id = nextId++;
      out.push({ ...call, id, thread_id: threadId } as Event);
      for (const child of children.get(call.id) ?? []) emit(child);
      if (ret) {
        out.push({ ...ret, id: nextId++, thread_id: threadId, parent_id: id } as Event);
      } else {
        truncated = true;
        out.push({ id: nextId++, event: 'return', thread_id: threadId, parent_id: id });
      }
    };
    for (const root of children.get(undefined) ?? []) emit(root);

    return {
      version: APPMAP_VERSION,
      metadata: {
        ...this.metadata,
        ...(truncated ? { truncated: true } : {}),
        ...(unanswered.length ? { unanswered_http_requests: unanswered } : {}),
        ...overrides,
      },
      classMap: buildClassMap([...this.functions.values()]),
      events: out,
    };
  }
}

function buildClassMap(functions: FunctionInfo[]): ClassMapEntry[] {
  const roots: PackageEntry[] = [];

  const packageFor = (dirPath: string): PackageEntry => {
    const segments = dirPath === '' ? ['.'] : dirPath.split('/');
    let level: { children: ClassMapEntry[] } = { children: roots as ClassMapEntry[] };
    let pkg: PackageEntry | undefined;
    for (const segment of segments) {
      pkg = level.children.find(
        (c): c is PackageEntry => c.type === 'package' && c.name === segment,
      );
      if (!pkg) {
        pkg = { type: 'package', name: segment, children: [] };
        level.children.push(pkg);
      }
      level = pkg;
    }
    return pkg!;
  };

  for (const fn of functions) {
    const dir = fn.path.includes('/') ? fn.path.slice(0, fn.path.lastIndexOf('/')) : '';
    const pkg = packageFor(dir);
    let cls = pkg.children.find(
      (c): c is ClassEntry => c.type === 'class' && c.name === fn.definedClass,
    );
    if (!cls) {
      cls = { type: 'class', name: fn.definedClass, children: [] };
      pkg.children.push(cls);
    }
    const location = fn.lineno ? `${fn.path}:${fn.lineno}` : fn.path;
    if (!cls.children.some((c) => c.type === 'function' && c.name === fn.methodId && c.location === location)) {
      cls.children.push({
        type: 'function',
        name: fn.methodId,
        location,
        // See the matching comment in enter(): always correct today,
        // no instance-method instrumentation exists yet.
        static: true,
        ...(fn.labels?.length ? { labels: fn.labels } : {}),
      });
    }
  }
  return roots;
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
