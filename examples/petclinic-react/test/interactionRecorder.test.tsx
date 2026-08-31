import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { stopRecording, installInteractionRecorder } from '@funwithappmap/react-recorder';
import { server } from './setup';
import { API_BASE } from './mocks/handlers';
import { renderApp } from './utils';

// Interaction-window spike (docs/design/04), the jsdom half: a real DOM
// click opens the window, the fetch keeps it open until the response
// lands, idle closes it, and the finished AppMap is POSTed to the
// collector URL. The real-browser half is manual for now: `npm run dev`
// and click around (see doc 04).

const COLLECTOR = `${API_BASE}/__appmap/interactions`;

describe('interaction-window recording', () => {
  it('records click → renders → fetch into one AppMap and ships it', async () => {
    // This test drives the interaction recorder instead of the ambient
    // per-test recording; discard the latter so a window can open.
    stopRecording();

    const shipped: unknown[] = [];
    server.use(
      http.post(COLLECTOR, async ({ request }) => {
        shipped.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const user = userEvent.setup();
    renderApp('/owners');
    // Type first: userEvent.type clicks the input to focus it, which
    // would otherwise open (and ship) its own interaction window.
    await user.type(screen.getByLabelText(/last name/i), 'Davis');

    const uninstall = installInteractionRecorder({
      app: 'petclinic-react',
      collectorUrl: COLLECTOR,
      idleMs: 25,
    });
    try {
      await user.click(screen.getByRole('button', { name: /find owner/i }));
      await screen.findByRole('link', { name: 'Betty Davis' });

      await waitFor(() => expect(shipped).toHaveLength(1), { timeout: 2000 });
    } finally {
      uninstall();
    }

    const appmap = shipped[0] as any;
    expect(appmap.version).toBe('1.2');
    expect(appmap.metadata.name).toMatch(/^click button/);
    expect(appmap.metadata.recorder.name).toBe('funwithappmap-react');

    const calls = appmap.events.filter((e: any) => e.event === 'call');
    // The window swept in the whole interaction: the handler, the API
    // call, the fetch, and the re-renders it caused.
    expect(calls.some((e: any) => e.method_id === 'search')).toBe(true);
    expect(calls.some((e: any) => e.method_id === 'findOwners')).toBe(true);
    expect(calls.some((e: any) => e.http_client_request)).toBe(true);
    expect(calls.some((e: any) => e.method_id === 'OwnersSearch')).toBe(true);
    // And the fetch was stamped, so this interaction is linkable.
    const req = calls.find((e: any) => e.http_client_request);
    expect(req.http_client_request.headers.traceparent).toMatch(
      new RegExp(`^00-${appmap.metadata.trace_id}-[0-9a-f]{16}-01$`),
    );
  });
});
