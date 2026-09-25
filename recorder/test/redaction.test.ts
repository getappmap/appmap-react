import { describe, it, expect, afterEach, vi } from 'vitest';
import { Recording, formatValue, setValueSizeCap, VALUE_SIZE_CAP } from '../src/recording';
import { autoInstrument } from '../src/instrument';
import { activeRecording, startRecording, stopRecording } from '../src/session';

// Credentials never reach a recording in plaintext.

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2lnbmF0dXJl';

function record(run: () => unknown) {
  const recording = startRecording(new Recording({
    name: 'redaction',
    client: { name: 'test', url: 'https://example.invalid' },
    recorder: { name: 'test', type: 'tests' },
  }));
  try {
    run();
  } finally {
    stopRecording();
  }
  return recording.toAppMap();
}

describe('credential redaction', () => {
  afterEach(() => {
    setValueSizeCap(VALUE_SIZE_CAP);
    if (activeRecording()) stopRecording();
    vi.unstubAllGlobals();
  });

  it('redacts parameters and nested properties with a sensitive name, case-insensitively', () => {
    const login = autoInstrument(
      (data: unknown, apiKey: string, _page: number) => ({ ok: true, session: { accessToken: 'tok-123', user: 'ada' } }),
      { definedClass: 'auth', methodId: 'login', path: 'src/auth.ts', lineno: 1 },
      ['data', 'apiKey', 'page'],
    );
    setValueSizeCap(1000); // see the whole value
    const appmap = record(() =>
      login({ email: 'ada@example.com', password: 'secret-pw-1', nested: { API_KEY: 'k', 'x-api-key': 'k2', clientSecret: 's' } }, 'ak-1', 2),
    );
    const call = appmap.events.find((e: any) => e.method_id === 'login') as any;
    expect(call.parameters[0].value).toBe(
      '{"email":"ada@example.com","password":"[REDACTED]","nested":{"API_KEY":"[REDACTED]","x-api-key":"[REDACTED]","clientSecret":"[REDACTED]"}}',
    );
    expect(call.parameters[1].value).toBe('[REDACTED]');
    expect(call.parameters[2].value).toBe('2');
    const ret = appmap.events.find((e: any) => e.return_value) as any;
    expect(ret.return_value.value).toBe('{"ok":true,"session":{"accessToken":"[REDACTED]","user":"ada"}}');
    expect(JSON.stringify(appmap)).not.toMatch(/secret-pw-1|ak-1|tok-123/);
  });

  it('removes bearer tokens from any captured string', () => {
    expect(formatValue(`Bearer ${JWT}`).value).toBe('Bearer [REDACTED]');
    expect(formatValue({ auth: `bearer ${JWT}` }).value).toBe('{"auth":"bearer [REDACTED]"}');
  });

  it('redacts a JWT under any name (a Supabase client carries its key as supabaseKey)', () => {
    expect(formatValue({ supabaseUrl: 'http://127.0.0.1:54321', supabaseKey: JWT }).value).toBe(
      '{"supabaseUrl":"http://127.0.0.1:54321","supabaseKey":"[REDACTED]"}',
    );
  });

  it('redacts Authorization/Cookie/Set-Cookie headers and sensitive query parameters on HTTP events', () => {
    const recording = new Recording({
      name: 'http',
      client: { name: 'test', url: 'https://example.invalid' },
      recorder: { name: 'test', type: 'requests' },
    });
    const token = recording.httpClientRequest('GET', 'https://api.example.test/items?page=1&access_token=abc&apiKey=def', {
      authorization: `Bearer ${JWT}`,
      cookie: 'sid=abc',
      accept: 'application/json',
    });
    recording.httpClientResponse(token, 200, { 'set-cookie': 'sid=new' });
    const appmap = recording.toAppMap();
    const [call, ret] = appmap.events as any[];
    expect(call.http_client_request.headers).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      accept: 'application/json',
    });
    expect(call.message).toEqual([
      { name: 'page', class: 'String', value: '1' },
      { name: 'access_token', class: 'String', value: '[REDACTED]' },
      { name: 'apiKey', class: 'String', value: '[REDACTED]' },
    ]);
    expect(ret.http_client_response.headers).toEqual({ 'set-cookie': '[REDACTED]' });
    expect(JSON.stringify(appmap)).not.toMatch(new RegExp(`${JWT}|sid=|abc|def`));
  });
});
