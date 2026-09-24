import { activeRecording } from './session.js';
import { randomHex, type CallToken, type Recording } from './recording.js';
import { CAPTURED_REQUEST_HEADERS, CAPTURED_RESPONSE_HEADERS } from './fetchPatch.js';

// The XMLHttpRequest twin of fetchPatch.ts. axios (and every other
// XHR-based client) never calls fetch, so without this an axios app's
// HTTP traffic was invisible: no http_client_request events, no
// traceparent on the wire (so no full-stack linking), and interaction
// windows closed before the response because the idle check had no
// pending request to wait for.
//
// While a recording is open, globalThis.XMLHttpRequest is wrapped so
// every new instance is observed:
//
// - open(): if a recording is active, remember it and stamp the request
//   with a traceparent (the recording's trace id, a fresh span id);
// - setRequestHeader(): capture the headers worth keeping;
// - the `loadstart` / `loadend` events: record http_client_request /
//   http_client_response.
//
// Hooks are installed on the *instance the app holds*, not on
// XMLHttpRequest.prototype, and the request is detected from events
// rather than by wrapping send(): request interceptors such as MSW's
// (bulletproof-react's tests) replace XMLHttpRequest with a proxy that
// answers mocked requests without ever calling the real send(), and only
// fire listeners registered through that proxy.

// Structural types: this module is also type-checked under Deno, whose
// lib has no XMLHttpRequest (the patch is a no-op there).
interface Xhr {
  open(...args: unknown[]): void;
  setRequestHeader(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  getResponseHeader(name: string): string | null;
  readonly status: number;
}
type XhrCtor = new (...args: unknown[]) => Xhr;
const scope = globalThis as unknown as { XMLHttpRequest?: XhrCtor };

let original: XhrCtor | undefined;
let originalDescriptor: PropertyDescriptor | undefined;
let wrapper: XhrCtor | undefined;

interface Pending {
  recording: Recording;
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The call that opened the request: its event is recorded later. */
  parent: number | undefined;
  token?: CallToken;
}

export function patchXhr(): void {
  if (original || typeof scope.XMLHttpRequest !== 'function') return;
  // Interceptors (MSW) install XMLHttpRequest with defineProperty, often
  // read-only; go through defineProperty too, and restore it exactly.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  original = scope.XMLHttpRequest;
  originalDescriptor = descriptor;
  wrapper = new Proxy(original, {
    construct(target, args, newTarget) {
      const xhr = Reflect.construct(target, args, newTarget) as Xhr;
      observe(xhr);
      return xhr;
    },
  });
  setGlobal(wrapper);
}

function setGlobal(value: XhrCtor): void {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  if (!d || d.configurable) {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value,
      writable: true,
      configurable: true,
      enumerable: d?.enumerable ?? false,
    });
  } else {
    scope.XMLHttpRequest = value;
  }
}

export function unpatchXhr(): void {
  if (!original) return;
  // Only undo our own wrapper; if something wrapped it after us, leave
  // the chain alone (instances keep checking activeRecording()).
  if (scope.XMLHttpRequest === wrapper) {
    if (originalDescriptor?.configurable) Object.defineProperty(globalThis, 'XMLHttpRequest', originalDescriptor);
    else setGlobal(original);
  }
  original = undefined;
  originalDescriptor = undefined;
  wrapper = undefined;
}

function observe(xhr: Xhr): void {
  let pending: Pending | undefined;
  const open = xhr.open;
  const setRequestHeader = xhr.setRequestHeader;

  xhr.open = function (...args: unknown[]) {
    pending = undefined;
    const result = open.apply(xhr, args);
    const recording = activeRecording();
    if (recording) {
      const [method, url] = args as [string, string | URL];
      pending = {
        recording,
        method: String(method).toUpperCase(),
        url: absoluteUrl(url),
        headers: {},
        parent: recording.currentParent(),
      };
      xhr.setRequestHeader('traceparent', `00-${recording.traceId}-${randomHex(8)}-01`);
    }
    return result;
  };

  xhr.setRequestHeader = function (name: string, value: string) {
    if (pending && CAPTURED_REQUEST_HEADERS.includes(name.toLowerCase())) {
      pending.headers[name.toLowerCase()] = value;
    }
    return setRequestHeader.call(xhr, name, value);
  };

  const start = () => {
    if (pending && !pending.token) {
      pending.token = pending.recording.httpClientRequest(pending.method, pending.url, pending.headers, pending.parent);
    }
  };
  xhr.addEventListener('loadstart', start);
  xhr.addEventListener('loadend', () => {
    if (!pending) return;
    start();
    const { recording, token } = pending;
    pending = undefined;
    let status = 0;
    const headers: Record<string, string> = {};
    try {
      status = xhr.status;
      for (const name of CAPTURED_RESPONSE_HEADERS) {
        const value = xhr.getResponseHeader(name);
        if (value !== null) headers[name] = value;
      }
    } catch {
      // aborted / network error: no response to read
    }
    // status 0: network error, abort or timeout — no response.
    recording.httpClientResponse(token!, status, headers);
  });
}

function absoluteUrl(url: string | URL): string {
  const base = (globalThis as { document?: { baseURI?: string } }).document?.baseURI;
  try {
    return new URL(String(url), base).href;
  } catch {
    return String(url);
  }
}
