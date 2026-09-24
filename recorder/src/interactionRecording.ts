import type { Metadata } from './types.js';
import { Recording } from './recording.js';
import { startRecording, stopRecording, activeRecording } from './session.js';
import { setPropagateTraceHeaderOrigins, type OriginPattern } from './propagation.js';

// Interaction-window recording (docs/design/01 §design, spiked for
// docs/design/04): one AppMap per user interaction. The window opens at
// the triggering DOM event and closes when the recording goes idle — no
// new events and no http_client request still awaiting its response —
// or when the hard cap elapses. Everything that runs while the window
// is open is attributed to it; that is the accepted noise of
// interaction-window scoping.
//
// Browsers can't write tmp/appmap/, so finished maps are POSTed to the
// collector (the Vite dev-server side of the plugin) — the remote
// recording protocol with roles reversed.

export interface InteractionRecorderOptions {
  app?: string;
  /** Collector endpoint; the Vite plugin serves this in dev. */
  collectorUrl?: string;
  /** Close the window after this much time with no recording activity. */
  idleMs?: number;
  /** Hard cap on window length. */
  maxMs?: number;
  /** DOM event types that open a window. */
  triggers?: string[];
  /** Cross-origin targets whose requests get a `traceparent` header
   * (same-origin requests always do): origins such as
   * 'https://api.example.com', RegExps tested against the URL, or '*'.
   * The backend's CORS must allow the `traceparent` request header, or
   * the browser blocks the request. See propagation.ts. */
  propagateTraceHeaderOrigins?: OriginPattern[];
  /** Also open a window when the recorder is installed, named
   * `load <path>`, so the requests and renders of the initial page load
   * (before any click) are recorded and stamped too. The Vite plugin's
   * zero-touch injection turns this on. Default false. */
  recordPageLoad?: boolean;
}

export const COLLECTOR_PATH = '/__appmap/interactions';

/** Install the interaction recorder on `document`. Returns uninstall. */
export function installInteractionRecorder(options: InteractionRecorderOptions = {}): () => void {
  const {
    app,
    collectorUrl = COLLECTOR_PATH,
    idleMs = 250,
    maxMs = 10_000,
    triggers = ['click', 'submit'],
  } = options;
  if (options.propagateTraceHeaderOrigins) setPropagateTraceHeaderOrigins(options.propagateTraceHeaderOrigins);

  let timer: ReturnType<typeof setInterval> | undefined;
  let open: { recording: Recording; interactions: string[]; sameTask: boolean } | undefined;

  const onTrigger = (event: Event) => {
    const active = activeRecording();
    if (active && active === open?.recording) {
      // A trigger dispatched in the same task as the one that opened the
      // window is part of the same user action (clicking a submit button
      // fires click, then submit).
      if (open.sameTask) return;
      // Otherwise the open window absorbs it, but records that it did:
      // the map now covers more than one interaction.
      open.interactions.push(describeInteraction(event));
      return;
    }
    // A window opened elsewhere (e.g. a test recording) is respected.
    if (active) return;
    openWindow(describeInteraction(event));
  };

  const openWindow = (description: string) => {
    const interactions = [description];
    const metadata: Metadata = {
      name: interactions[0],
      app,
      client: {
        name: '@funwithappmap/react-recorder',
        url: 'https://github.com/getappmap/appmap-react',
      },
      recorder: { name: 'funwithappmap-react', type: 'requests' },
    };
    const recording = startRecording(new Recording(metadata));
    const opened = { recording, interactions, sameTask: true };
    open = opened;
    setTimeout(() => (opened.sameTask = false), 0);

    const openedAt = Date.now();
    let lastCount = -1; // force at least one full idle interval
    timer = setInterval(() => {
      if (activeRecording() !== recording) {
        clearInterval(timer);
        return;
      }
      const idle = recording.events.length === lastCount && pendingRequests(recording) === 0;
      lastCount = recording.events.length;
      if (idle || Date.now() - openedAt >= maxMs) {
        clearInterval(timer);
        open = undefined;
        if (interactions.length > 1) {
          recording.metadata.name = interactions.join(' + ');
          recording.metadata.interactions = interactions;
          recording.metadata.ambiguous = true;
        }
        ship(stopRecording(), collectorUrl);
      }
    }, idleMs);
  };

  for (const type of triggers) document.addEventListener(type, onTrigger, { capture: true });
  if (options.recordPageLoad && !activeRecording()) {
    const where = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? '/';
    openWindow(`load ${where}`);
  }
  return () => {
    for (const type of triggers) document.removeEventListener(type, onTrigger, { capture: true });
    if (timer) clearInterval(timer);
  };
}

/** http_client_request events whose response has not arrived yet —
 * fetch and XMLHttpRequest alike (both patches record into the same
 * events), so the window stays open until XHR responses land too. */
function pendingRequests(recording: Recording): number {
  let pending = 0;
  const open = new Set<number>();
  for (const event of recording.events) {
    if ('http_client_request' in event) {
      open.add(event.id);
      pending++;
    } else if ('http_client_response' in event && open.has(event.parent_id)) {
      pending--;
    }
  }
  return pending;
}

function ship(recording: Recording, collectorUrl: string): void {
  // stopRecording() has already unpatched fetch (and XMLHttpRequest),
  // so this request is never recorded or stamped.
  void fetch(collectorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recording.toAppMap()),
  }).catch((err) => console.warn('appmap: failed to ship interaction recording:', err));
}

function describeInteraction(event: Event): string {
  const target = event.target as Element | null;
  if (!target?.tagName) return event.type;
  const text =
    target.getAttribute?.('aria-label') ||
    (target.textContent ?? '').trim().slice(0, 40) ||
    target.id ||
    (target as HTMLInputElement).name ||
    '';
  return `${event.type} ${target.tagName.toLowerCase()}${text ? ` "${text}"` : ''}`;
}
