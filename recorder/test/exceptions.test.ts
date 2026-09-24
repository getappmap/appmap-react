import { describe, it, expect } from 'vitest';
import { Recording } from '../src/recording';

// Thrown values that are not Errors — supabase-js throws the plain
// parsed PostgREST error object — must keep their message.

function thrown(value: unknown) {
  const recording = new Recording({
    name: 'exceptions',
    client: { name: 'test', url: 'https://example.invalid' },
    recorder: { name: 'test', type: 'tests' },
  });
  const token = recording.enter({ definedClass: 'index', methodId: 'getTask', path: 'index.ts', lineno: 18 });
  recording.exit(token, { exception: value });
  return (recording.toAppMap().events[1] as any).exceptions[0];
}

describe('exception capture', () => {
  it('records a thrown plain object by its class and its message property', () => {
    const e = thrown({ code: '22P02', details: null, hint: null, message: 'invalid input syntax for type bigint: "not-a-number"' });
    expect(e).toMatchObject({ class: 'Object', message: 'invalid input syntax for type bigint: "not-a-number"' });
    expect(Number.isInteger(e.object_id)).toBe(true);
  });

  it('records a plain object without a message as its value, not "[object Object]"', () => {
    expect(thrown({ code: 42 })).toMatchObject({ class: 'Object', message: '{"code":42}' });
  });

  it('keeps Error subclasses and primitives as before', () => {
    class ApiError extends Error {}
    expect(thrown(new ApiError('nope'))).toMatchObject({ class: 'ApiError', message: 'nope' });
    expect(thrown('boom')).toMatchObject({ class: 'string', message: 'boom' });
  });

  it('never calls a message getter or toString on the thrown value', () => {
    let calls = 0;
    const sneaky = {
      get message() {
        calls++;
        return 'x';
      },
      toString() {
        calls++;
        return 'y';
      },
    };
    thrown(sneaky);
    expect(calls).toBe(0);
  });
});
