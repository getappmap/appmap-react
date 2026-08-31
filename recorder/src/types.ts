// AppMap data format v1.2 — the subset this agent emits.
// https://github.com/getappmap/appmap (appmap.json spec)

export interface AppMap {
  version: '1.2';
  metadata: Metadata;
  classMap: ClassMapEntry[];
  events: Event[];
}

export interface Metadata {
  name: string;
  app?: string;
  language?: { name: string; version?: string; engine?: string };
  client: { name: string; url: string; version?: string };
  recorder: { name: string; type?: 'tests' | 'requests' | 'remote' | 'process' };
  frameworks?: { name: string; version?: string }[];
  source_location?: string;
  test_status?: 'succeeded' | 'failed';
  exception?: { class: string; message: string };
  // Full-stack linking (docs/design/02): one trace id per recording.
  trace_id?: string;
  // Backend request maps only: the span-id of the frontend fetch that
  // caused this request (copied from the incoming traceparent).
  parent_span_id?: string;
}

export type ClassMapEntry = PackageEntry | ClassEntry | FunctionEntry;

export interface PackageEntry {
  type: 'package';
  name: string;
  children: ClassMapEntry[];
}

export interface ClassEntry {
  type: 'class';
  name: string;
  children: ClassMapEntry[];
}

export interface FunctionEntry {
  type: 'function';
  name: string;
  location: string;
  static: boolean;
  labels?: string[];
}

export type Event =
  | CallEvent
  | ReturnEvent
  | HttpClientRequestEvent
  | HttpClientResponseEvent
  | HttpServerRequestEvent
  | HttpServerResponseEvent;

export interface ParameterValue {
  name?: string;
  class: string;
  value: string;
  kind?: 'req';
}

export interface CallEvent {
  id: number;
  event: 'call';
  thread_id: number;
  defined_class: string;
  method_id: string;
  path: string;
  lineno?: number;
  static: boolean;
  parameters?: ParameterValue[];
}

export interface ReturnEvent {
  id: number;
  event: 'return';
  thread_id: number;
  parent_id: number;
  elapsed?: number;
  return_value?: { class: string; value: string };
  exceptions?: { class: string; message: string }[];
}

export interface HttpClientRequestEvent {
  id: number;
  event: 'call';
  thread_id: number;
  http_client_request: {
    request_method: string;
    url: string;
    headers?: Record<string, string>;
  };
}

export interface HttpClientResponseEvent {
  id: number;
  event: 'return';
  thread_id: number;
  parent_id: number;
  elapsed?: number;
  http_client_response: {
    status_code: number;
    headers?: Record<string, string>;
  };
}

export interface HttpServerRequestEvent {
  id: number;
  event: 'call';
  thread_id: number;
  http_server_request: {
    request_method: string;
    path_info: string;
    normalized_path_info?: string;
    headers?: Record<string, string>;
  };
}

export interface HttpServerResponseEvent {
  id: number;
  event: 'return';
  thread_id: number;
  parent_id: number;
  elapsed?: number;
  http_server_response: {
    status_code: number;
  };
}

/** Identity of an instrumented function; the hand-written analogue of what
 * the build-time transform (docs/design/03) will generate per function. */
export interface FunctionInfo {
  /** Class-like container: for React code, the module basename (e.g. "OwnerDetail"). */
  definedClass: string;
  /** Function name within the container (e.g. "OwnerDetail", "useOwnerSearch"). */
  methodId: string;
  /** Repo-relative source path (e.g. "src/pages/OwnerDetail.tsx"). */
  path: string;
  lineno?: number;
  /** AppMap labels, e.g. ["hook"] or ["event-handler"]. */
  labels?: string[];
}
