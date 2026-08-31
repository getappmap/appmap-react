import { Recording } from '@funwithappmap/react-recorder';
// @ts-expect-error plain-JS linker module has no type declarations
import { linkMaps, isBackendMap } from '../../../linker/src/link.mjs';

// The recorder can now write backend request maps too — this is what
// the Deno driver (deno/appmap.ts) produces per edge-function request.

const TRACE = 'c'.repeat(32);
const SPAN = '9'.repeat(16);

function backendRecording() {
  const recording = new Recording({
    name: 'GET /what2say',
    app: 'what2say',
    language: { name: 'typescript', engine: 'deno' },
    client: { name: '@funwithappmap/react-recorder', url: 'https://example.invalid' },
    recorder: { name: 'funwithappmap-deno', type: 'requests' },
  });
  recording.metadata.trace_id = TRACE;
  recording.metadata.parent_span_id = SPAN;
  const token = recording.httpServerRequest('GET', '/what2say', {
    traceparent: `00-${TRACE}-${SPAN}-01`,
  });
  recording.httpServerResponse(token, 200);
  return recording;
}

describe('server-side recording (Deno driver shape)', () => {
  it('serializes http_server_request/response with linking metadata', () => {
    const appmap = backendRecording().toAppMap();

    expect(appmap.metadata.trace_id).toBe(TRACE);
    expect(appmap.metadata.parent_span_id).toBe(SPAN);
    expect(appmap.events).toEqual([
      expect.objectContaining({
        id: 1,
        event: 'call',
        http_server_request: {
          request_method: 'GET',
          path_info: '/what2say',
          headers: { traceparent: `00-${TRACE}-${SPAN}-01` },
        },
      }),
      expect.objectContaining({
        id: 2,
        event: 'return',
        parent_id: 1,
        http_server_response: { status_code: 200 },
      }),
    ]);
    expect(isBackendMap(appmap)).toBe(true);
  });

  it('joins to a frontend map by span-id', () => {
    const frontend = {
      version: '1.2',
      metadata: { name: 'click', trace_id: TRACE },
      classMap: [],
      events: [
        {
          id: 1,
          event: 'call',
          thread_id: 1,
          http_client_request: {
            request_method: 'GET',
            url: 'http://localhost:8000/what2say',
            headers: { traceparent: `00-${TRACE}-${SPAN}-01` },
          },
        },
        {
          id: 2,
          event: 'return',
          thread_id: 1,
          parent_id: 1,
          http_client_response: { status_code: 200 },
        },
      ],
    };
    const { links, orphanBackends } = linkMaps(
      [{ path: 'fe.appmap.json', appmap: frontend }],
      [{ path: 'be.appmap.json', appmap: backendRecording().toAppMap() }],
    );
    expect(orphanBackends).toEqual([]);
    expect(links[0].requests[0].backend).toEqual({ path: 'be.appmap.json', name: 'GET /what2say' });
  });
});
