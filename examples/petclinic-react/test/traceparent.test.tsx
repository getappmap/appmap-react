import { screen } from '@testing-library/react';
import { activeRecording, type HttpClientRequestEvent } from '@funwithappmap/react-recorder';
import { renderApp } from './utils';

describe('traceparent stamping (docs/design/02)', () => {
  it('stamps every fetch with the recording trace-id and a fresh span-id', async () => {
    renderApp('/owners/1');
    await screen.findByRole('heading', { name: 'George Franklin' });

    // The per-test recording is still open; inspect it in flight.
    const recording = activeRecording()!;
    const requests = recording.events.filter(
      (e): e is HttpClientRequestEvent => 'http_client_request' in e,
    );
    expect(requests).toHaveLength(2);

    const spanIds = new Set<string>();
    for (const event of requests) {
      const traceparent = event.http_client_request.headers?.traceparent;
      expect(traceparent).toMatch(new RegExp(`^00-${recording.traceId}-[0-9a-f]{16}-01$`));
      spanIds.add(traceparent!.split('-')[2]);
    }
    // One trace-id per interaction, a distinct span-id per request.
    expect(spanIds.size).toBe(2);
  });
});
