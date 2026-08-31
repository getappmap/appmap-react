import type { Metadata } from './types';
import { Recording } from './recording';
import { startRecording, stopRecording, activeRecording } from './session';

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

  let timer: ReturnType<typeof setInterval> | undefined;

  const onTrigger = (event: Event) => {
    // An open window absorbs further triggers (interaction-window
    // scoping); a window opened elsewhere (e.g. a test recording) is
    // respected the same way.
    if (activeRecording()) return;

    const metadata: Metadata = {
      name: describeInteraction(event),
      app,
      client: {
        name: '@funwithappmap/react-recorder',
        url: 'https://github.com/getappmap/appmap-react',
      },
      recorder: { name: 'funwithappmap-react', type: 'requests' },
    };
    const recording = startRecording(new Recording(metadata));

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
        ship(stopRecording(), collectorUrl);
      }
    }, idleMs);
  };

  for (const type of triggers) document.addEventListener(type, onTrigger, { capture: true });
  return () => {
    for (const type of triggers) document.removeEventListener(type, onTrigger, { capture: true });
    if (timer) clearInterval(timer);
  };
}

/** http_client_request events whose response has not arrived yet. */
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
  // stopRecording() has already unpatched fetch, so this request is
  // never recorded or stamped.
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
