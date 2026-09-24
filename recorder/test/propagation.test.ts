import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  shouldPropagateTraceHeader,
  setPropagateTraceHeaderOrigins,
  parseOriginPatterns,
  serializeOriginPatterns,
} from '../src/propagation';

// Which requests get traceparent (docs/design/02, "Cross-origin requests"):
// OpenTelemetry's browser model. Same origin always; cross origin only when
// listed; server-side (no page origin) always.

afterEach(() => {
  vi.unstubAllGlobals();
  setPropagateTraceHeaderOrigins([]);
});

describe('shouldPropagateTraceHeader', () => {
  it('stamps every request where there is no page origin (Node, Deno)', () => {
    expect(globalThis.location).toBeUndefined();
    expect(shouldPropagateTraceHeader('https://api.example.com/x')).toBe(true);
  });

  it('in a page: same origin yes, other origins only when listed', () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:3300' });
    expect(shouldPropagateTraceHeader('http://127.0.0.1:3300/api/x?y=1')).toBe(true);
    expect(shouldPropagateTraceHeader('/relative')).toBe(true);
    expect(shouldPropagateTraceHeader('http://localhost:54321/functions/v1/fn')).toBe(false);
    expect(shouldPropagateTraceHeader('http://127.0.0.1:8080/api')).toBe(false);

    setPropagateTraceHeaderOrigins(['http://localhost:54321/']);
    expect(shouldPropagateTraceHeader('http://localhost:54321/functions/v1/fn')).toBe(true);
    expect(shouldPropagateTraceHeader('http://localhost:54322/functions/v1/fn')).toBe(false);

    setPropagateTraceHeaderOrigins([/\/functions\/v1\//]);
    expect(shouldPropagateTraceHeader('http://localhost:54321/functions/v1/fn')).toBe(true);
    expect(shouldPropagateTraceHeader('http://localhost:54321/rest/v1/users')).toBe(false);

    setPropagateTraceHeaderOrigins(['*']);
    expect(shouldPropagateTraceHeader('https://anything.example/x')).toBe(true);
  });

  it('treats a throwing location getter (Deno without --location) as server-side', () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get() {
        throw new ReferenceError('Access to "location", run again with --location <href>.');
      },
    });
    try {
      expect(shouldPropagateTraceHeader('https://api.example.com/x')).toBe(true);
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });
});

describe('APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS', () => {
  it('round-trips origins and regular expressions', () => {
    const list = ['http://localhost:54321', /\.example\.com\//i];
    const parsed = parseOriginPatterns(serializeOriginPatterns(list));
    expect(parsed[0]).toBe('http://localhost:54321');
    expect(parsed[1]).toBeInstanceOf(RegExp);
    expect((parsed[1] as RegExp).test('https://API.example.com/x')).toBe(true);
    expect(parseOriginPatterns(' a , ,b ')).toEqual(['a', 'b']);
    expect(parseOriginPatterns(undefined)).toEqual([]);
  });

  it('is read when the module loads (how Vitest workers get the Vite plugin option)', async () => {
    vi.stubEnv('APPMAP_PROPAGATE_TRACE_HEADER_ORIGINS', 'http://localhost:8080');
    vi.resetModules();
    const fresh = await import('../src/propagation');
    vi.stubGlobal('location', { origin: 'http://localhost:3000' });
    expect(fresh.shouldPropagateTraceHeader('http://localhost:8080/owners')).toBe(true);
    expect(fresh.shouldPropagateTraceHeader('http://localhost:8081/owners')).toBe(false);
    vi.unstubAllEnvs();
  });
});
