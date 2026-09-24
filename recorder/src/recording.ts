import type {
  AppMap,
  ClassMapEntry,
  ClassEntry,
  Event,
  FunctionInfo,
  Metadata,
  PackageEntry,
  ParameterValue,
} from './types.js';
import { className, functionName, safeStringify } from './stringify.js';

/** Default maximum captured length of any single value string, like
 * APPMAP_EVENT_VALUESIZE in the .NET agent. Overridable at runtime via
 * setValueSizeCap (wired to the APPMAP_EVENT_VALUESIZE env var by
 * testRecording.ts and vitePlugin.ts). */
export const VALUE_SIZE_CAP = 1024;

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
): { class: string; value: string; size?: number; object_id?: number } {
  // Never JSON.stringify / String() an unknown value: that runs its
  // getters and toJSON and can change what the app does (stringify.ts).
  const cls = v === undefined ? 'undefined' : className(v);

  let str: string;
  if (typeof v === 'string') str = v;
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
  if (str.length > currentValueSizeCap) str = str.slice(0, currentValueSizeCap) + '…';

  const result: { class: string; value: string; size?: number; object_id?: number } = {
    class: cls,
    value: str,
  };

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

export class Recording {
  readonly events: Event[] = [];
  readonly metadata: Metadata;
  private nextId = 1;
  private functions = new Map<string, FunctionInfo>();
  private objectIds: ObjectIdTracker = { ids: new WeakMap(), next: 1 };

  // Thread assignment (docs/design/01, 2026 amendment): each thread_id's
  // own event subsequence must independently nest like balanced
  // parentheses. `syncStack` mirrors the real, single-threaded JS call
  // stack — entries leave it the instant a call yields control back to
  // its caller (returns synchronously, or hands back a pending Promise),
  // even though the call may still be logically open. A call started
  // while its would-be parent thread already has another call that has
  // left its sync frame but not yet settled (a genuine concurrent
  // sibling, e.g. one leg of a Promise.all) gets a fresh thread instead
  // of corrupting the parent thread's nesting.
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
  private openDangling(): { callId: number; threadId: number } {
    const callId = this.nextId++;
    const threadId = this.allocateThread();
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
    const key = `${fn.path}:${fn.definedClass}.${fn.methodId}`;
    if (!this.functions.has(key)) this.functions.set(key, fn);

    const id = this.nextId++;
    const threadId = this.allocateThread();
    this.syncStack.push(id);
    this.openCalls.set(id, threadId);

    const parameters: ParameterValue[] | undefined = args?.map((a) => ({
      name: a.name,
      ...formatValue(a.value, this.objectIds),
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
            class: e instanceof Error ? e.constructor.name : typeof e,
            message: e instanceof Error ? e.message : String(e),
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

  httpClientRequest(method: string, url: string, headers?: Record<string, string>): CallToken {
    const { callId: id, threadId } = this.openDangling();
    this.events.push({
      id,
      event: 'call',
      thread_id: threadId,
      http_client_request: {
        request_method: method,
        url,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
    });
    return { callId: id, startMs: performance.now(), threadId };
  }

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
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
    });
  }

  /** Server-side twin of httpClientRequest, for recorders running inside
   * a backend request handler (e.g. the Deno driver in deno/appmap.ts). */
  httpServerRequest(
    method: string,
    pathInfo: string,
    headers?: Record<string, string>,
    normalizedPathInfo?: string,
  ): CallToken {
    const { callId: id, threadId } = this.openDangling();
    this.events.push({
      id,
      event: 'call',
      thread_id: threadId,
      http_server_request: {
        request_method: method,
        path_info: pathInfo,
        ...(normalizedPathInfo ? { normalized_path_info: normalizedPathInfo } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
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

  /** Serialize to AppMap v1.12. The classMap contains exactly the
   * functions that produced events, grouped package-per-directory like
   * appmap-agent-js.
   *
   * Self-healing (docs/design/11): any call still open at this point
   * gets a synthesized `return` appended, so the event list is always
   * balanced. An unbalanced list — a `call` with no matching `return`,
   * which happens when a process is torn down mid-flight (a Supabase
   * edge function killed during EdgeRuntime.waitUntil background work) —
   * makes downstream tools that reconstruct the call stack throw
   * ("failed trying to compute event stack, call.id: N"). A balanced,
   * if incomplete, map is sanitizable; an unbalanced one is not
   * committable at all. Synthetic returns carry no elapsed/return_value
   * and are flagged collectively by metadata.truncated. */
  toAppMap(overrides?: Partial<Metadata>): AppMap {
    const events: Event[] = [...this.events];
    const open = [...this.openCalls];
    if (open.length > 0) {
      // Innermost-first so nested synthetic returns nest correctly.
      let syntheticId = this.nextId;
      for (const [callId, threadId] of open.reverse()) {
        events.push({
          id: syntheticId++,
          event: 'return',
          thread_id: threadId,
          parent_id: callId,
        });
      }
    }
    return {
      version: '1.12',
      metadata: {
        ...this.metadata,
        ...(open.length > 0 ? { truncated: true } : {}),
        ...overrides,
      },
      classMap: buildClassMap([...this.functions.values()]),
      events,
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
    if (!cls.children.some((c) => c.type === 'function' && c.name === fn.methodId)) {
      cls.children.push({
        type: 'function',
        name: fn.methodId,
        location: fn.lineno ? `${fn.path}:${fn.lineno}` : fn.path,
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
