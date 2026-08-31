import type {
  AppMap,
  ClassMapEntry,
  ClassEntry,
  Event,
  FunctionInfo,
  Metadata,
  PackageEntry,
  ParameterValue,
} from './types';

/** Maximum captured length of any single value string, like
 * APPMAP_EVENT_VALUESIZE in the .NET agent. */
export const VALUE_SIZE_CAP = 1024;

export function formatValue(v: unknown): { class: string; value: string } {
  let cls: string;
  if (v === null) cls = 'null';
  else if (v === undefined) cls = 'undefined';
  else if (typeof v === 'object' || typeof v === 'function') {
    cls = (v as object).constructor?.name ?? typeof v;
  } else {
    cls = typeof v;
  }

  let str: string;
  try {
    if (typeof v === 'string') str = v;
    else if (typeof v === 'function') str = `[function ${(v as Function).name || 'anonymous'}]`;
    else str = JSON.stringify(v) ?? String(v);
  } catch {
    str = String(v);
  }
  if (str.length > VALUE_SIZE_CAP) str = str.slice(0, VALUE_SIZE_CAP) + '…';
  return { class: cls, value: str };
}

/** Handle returned by Recording.enter; consumed exactly once by exit.
 * Same contract as the Go recorder spike's CallToken: the injected
 * epilogue (here, a `finally` block) must call exit with it. */
export interface CallToken {
  callId: number;
  startMs: number;
}

export class Recording {
  readonly events: Event[] = [];
  readonly metadata: Metadata;

  private nextId = 1;
  private functions = new Map<string, FunctionInfo>();

  constructor(metadata: Metadata) {
    this.metadata = { ...metadata, trace_id: randomHex(16) };
  }

  /** One trace id per recording — the frontend half of the
   * traceparent join (docs/design/02). Reads live from
   * `metadata.trace_id` rather than a value frozen at construction:
   * the Deno driver overwrites `metadata.trace_id` after construction
   * to copy in the caller's inbound trace id, and every outbound
   * stamp fetchPatch.ts makes for the rest of this recording must
   * carry that value too, or a downstream call can never join back to
   * the original frontend interaction. */
  get traceId(): string {
    return this.metadata.trace_id!;
  }

  enter(fn: FunctionInfo, args?: { name?: string; value: unknown }[]): CallToken {
    const key = `${fn.path}:${fn.definedClass}.${fn.methodId}`;
    if (!this.functions.has(key)) this.functions.set(key, fn);

    const id = this.nextId++;
    const parameters: ParameterValue[] | undefined = args?.map((a) => ({
      name: a.name,
      ...formatValue(a.value),
    }));
    this.events.push({
      id,
      event: 'call',
      thread_id: 1,
      defined_class: fn.definedClass,
      method_id: fn.methodId,
      path: fn.path,
      lineno: fn.lineno,
      static: true,
      ...(parameters && parameters.length ? { parameters } : {}),
    });
    return { callId: id, startMs: performance.now() };
  }

  exit(token: CallToken, outcome: { returnValue?: unknown; exception?: unknown }): void {
    const elapsed = (performance.now() - token.startMs) / 1000;
    if (outcome.exception !== undefined) {
      const e = outcome.exception;
      this.events.push({
        id: this.nextId++,
        event: 'return',
        thread_id: 1,
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
        thread_id: 1,
        parent_id: token.callId,
        elapsed,
        ...(outcome.returnValue !== undefined
          ? { return_value: formatValue(outcome.returnValue) }
          : {}),
      });
    }
  }

  httpClientRequest(method: string, url: string, headers?: Record<string, string>): CallToken {
    const id = this.nextId++;
    this.events.push({
      id,
      event: 'call',
      thread_id: 1,
      http_client_request: {
        request_method: method,
        url,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
    });
    return { callId: id, startMs: performance.now() };
  }

  httpClientResponse(token: CallToken, statusCode: number, headers?: Record<string, string>): void {
    this.events.push({
      id: this.nextId++,
      event: 'return',
      thread_id: 1,
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
    const id = this.nextId++;
    this.events.push({
      id,
      event: 'call',
      thread_id: 1,
      http_server_request: {
        request_method: method,
        path_info: pathInfo,
        ...(normalizedPathInfo ? { normalized_path_info: normalizedPathInfo } : {}),
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      },
    });
    return { callId: id, startMs: performance.now() };
  }

  httpServerResponse(token: CallToken, statusCode: number): void {
    this.events.push({
      id: this.nextId++,
      event: 'return',
      thread_id: 1,
      parent_id: token.callId,
      elapsed: (performance.now() - token.startMs) / 1000,
      http_server_response: { status_code: statusCode },
    });
  }

  /** Serialize to AppMap v1.2. The classMap contains exactly the functions
   * that produced events, grouped package-per-directory like appmap-agent-js. */
  toAppMap(overrides?: Partial<Metadata>): AppMap {
    return {
      version: '1.2',
      metadata: { ...this.metadata, ...overrides },
      classMap: buildClassMap([...this.functions.values()]),
      events: this.events,
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
