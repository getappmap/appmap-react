import { describe, it, expect } from 'vitest';
import { Recording, formatValue } from '../src/recording';
import { instrument } from '../src/instrument';
import { startRecording, stopRecording } from '../src/session';

// The observer-effect fix: capturing a value must never run app code.
// React Query's tracked query result is an object of getters that
// subscribe the component to each field read; the recorder used to
// JSON.stringify hook return values, read every getter, and so changed
// how often components re-rendered.

function tracked() {
  const reads: string[] = [];
  const result = {};
  for (const key of ['data', 'isFetching', 'status']) {
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: false,
      get: () => {
        reads.push(key);
        return key === 'data' ? 1 : false;
      },
    });
  }
  return { result, reads };
}

describe('value capture has no side effects', () => {
  it('never invokes getters or toJSON on a captured value', () => {
    const { result, reads } = tracked();
    let toJSONCalls = 0;
    const withToJSON = { a: 1, toJSON: () => (toJSONCalls++, 'x') };
    formatValue(result);
    formatValue({ nested: { deeper: result } });
    formatValue([result]);
    formatValue(withToJSON);
    expect(reads).toEqual([]);
    expect(toJSONCalls).toBe(0);
  });

  it('does not read a tracked hook result returned through an instrumented hook', () => {
    const { result, reads } = tracked();
    const useThing = instrument(() => result, { definedClass: 'x', methodId: 'useThing', path: 'x.ts' });
    const recording = startRecording(new Recording({
      name: 'observer effect',
      client: { name: 'test', url: 'https://example.invalid' },
      recorder: { name: 'test', type: 'tests' },
    }));
    try {
      expect(useThing()).toBe(result);
    } finally {
      stopRecording();
    }
    expect(reads).toEqual([]);
    const ret = recording.events.find((e) => e.event === 'return') as { return_value: { value: string } };
    expect(ret.return_value.value).toBe('{"data":"[getter]","isFetching":"[getter]","status":"[getter]"}');
  });

  it('still renders plain data exactly like JSON', () => {
    const value = { a: 1, b: [1, 'x', null, true], c: { d: 'e' }, n: -2.5 };
    expect(formatValue(value).value).toBe(JSON.stringify(value));
    expect(formatValue([{ id: 1 }, { id: 2 }]).value).toBe('[{"id":1},{"id":2}]');
    expect(formatValue('plain').value).toBe('plain');
    expect(formatValue(42).value).toBe('42');
    expect(formatValue(null).value).toBe('null');
  });

  it('keeps function-valued properties visible instead of dropping them', () => {
    function onSuccess() {}
    expect(formatValue({ onSuccess }).value).toBe('{"onSuccess":"[function onSuccess]"}');
  });

  it('survives cycles and huge values within the cap', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(formatValue(cyclic).value).toBe('{"name":"loop","self":"[Circular]"}');
    const huge = Array.from({ length: 100_000 }, (_, i) => ({ i }));
    expect(formatValue(huge).value.length).toBeLessThanOrEqual(1025);
  });

  it('reads the class name without invoking a constructor getter', () => {
    let reads = 0;
    const odd = Object.create({
      get constructor() {
        reads++;
        return Object;
      },
    });
    expect(formatValue(odd).class).toBe('Object');
    expect(reads).toBe(0);
    class Owner {
      id = 1;
    }
    expect(formatValue(new Owner()).class).toBe('Owner');
  });
});
