import { describe, it, expect, afterEach } from 'vitest';
import { Recording, formatValue, setValueSizeCap, VALUE_SIZE_CAP } from '../src/recording';
import { startTestRecording } from '../src/testRecording';
import { stopRecording } from '../src/session';
import type { Metadata } from '../src/types';

function baseMetadata(): Metadata {
  return {
    name: 'unit test',
    client: { name: '@funwithappmap/react-recorder', url: 'https://github.com/getappmap/appmap-react' },
    recorder: { name: 'funwithappmap-react', type: 'tests' },
  };
}

describe('Recording.toAppMap', () => {
  it('serializes AppMap v1.12 (the real spec tag, not v1.2)', () => {
    const recording = new Recording(baseMetadata());
    expect(recording.toAppMap().version).toBe('1.12');
  });
});

describe('formatValue value-size cap', () => {
  afterEach(() => setValueSizeCap(VALUE_SIZE_CAP));

  it('defaults to VALUE_SIZE_CAP, the spec\'s 100 characters', () => {
    expect(VALUE_SIZE_CAP).toBe(100);
    const { value } = formatValue('a'.repeat(VALUE_SIZE_CAP + 50));
    // The truncation ellipsis counts toward the cap: the spec (and the
    // official validator) allow 100 characters, not 101.
    expect(value.length).toBe(VALUE_SIZE_CAP);
    expect(value.endsWith('…')).toBe(true);
    expect(formatValue('a'.repeat(VALUE_SIZE_CAP)).value).toBe('a'.repeat(VALUE_SIZE_CAP));
  });

  it('honors setValueSizeCap (wired to APPMAP_EVENT_VALUESIZE)', () => {
    setValueSizeCap(10);
    const { value } = formatValue('a'.repeat(50));
    expect(value.length).toBe(10);
  });

  it('never splits a surrogate pair when cutting', () => {
    setValueSizeCap(10);
    const { value } = formatValue('aaaaaaaa😀😀😀');
    expect(value).toBe('aaaaaaaa…');
  });
});

describe('formatValue object metadata', () => {
  it('adds size for array and object values', () => {
    expect(formatValue([1, 2, 3]).size).toBe(3);
    expect(formatValue({ a: 1, b: 2 }).size).toBe(2);
  });

  it('omits size for primitive values', () => {
    expect(formatValue('hello').size).toBeUndefined();
    expect(formatValue(42).size).toBeUndefined();
    expect(formatValue(null).size).toBeUndefined();
  });

  it('assigns a stable object_id for repeated references within one tracker', () => {
    const tracker = { ids: new WeakMap<object, number>(), next: 1 };
    const obj = { a: 1 };
    const first = formatValue(obj, tracker);
    const second = formatValue(obj, tracker);
    const other = formatValue({ a: 1 }, tracker);
    expect(first.object_id).toBe(second.object_id);
    expect(other.object_id).not.toBe(first.object_id);
  });

  it('omits object_id when no tracker is supplied', () => {
    expect(formatValue({ a: 1 }).object_id).toBeUndefined();
  });
});

describe('Recording.enter parameter capture', () => {
  it('includes size and object_id for an object-valued parameter', () => {
    const recording = new Recording(baseMetadata());
    const token = recording.enter({ definedClass: 'Foo', methodId: 'bar', path: 'src/Foo.ts' }, [
      { name: 'opts', value: { a: 1, b: 2 } },
    ]);
    recording.exit(token, { returnValue: undefined });

    const callEvent = recording.events[0] as { parameters?: { size?: number; object_id?: number }[] };
    expect(callEvent.parameters?.[0].size).toBe(2);
    expect(callEvent.parameters?.[0].object_id).toBeTypeOf('number');
  });
});

describe('Recording.toAppMap self-heals open calls (docs/design/11)', () => {
  it('a fully balanced recording is not flagged truncated and gains no synthetic returns', () => {
    const recording = new Recording(baseMetadata());
    const token = recording.enter({ definedClass: 'Foo', methodId: 'bar', path: 'src/Foo.ts' });
    recording.exit(token, { returnValue: 1 });
    const appmap = recording.toAppMap();
    expect(appmap.metadata.truncated).toBeUndefined();
    expect(appmap.events).toHaveLength(2);
    expect(recording.openCallCount()).toBe(0);
  });

  it('synthesizes a return for a call left open at serialization and flags the map truncated', () => {
    const recording = new Recording(baseMetadata());
    // Open a call and never exit it — a hard teardown mid-flight, e.g. a
    // Supabase edge function killed during EdgeRuntime.waitUntil work.
    const token = recording.enter({ definedClass: 'Scan', methodId: 'pipeline', path: 'src/scan.ts' });
    expect(recording.openCallCount()).toBe(1);

    const appmap = recording.toAppMap();
    expect(appmap.metadata.truncated).toBe(true);

    // The event list is balanced: every call has a matching return.
    const calls = appmap.events.filter((e) => e.event === 'call');
    const returns = appmap.events.filter((e) => e.event === 'return');
    expect(returns).toHaveLength(calls.length);
    const synthetic = returns.find((r) => (r as { parent_id: number }).parent_id === token.callId);
    expect(synthetic).toBeDefined();

    // Non-mutating snapshot: the recording's own event list is untouched,
    // so a later real exit still lands correctly.
    expect(recording.events).toHaveLength(1);
    recording.exit(token, { returnValue: 'ok' });
    expect(recording.openCallCount()).toBe(0);
    expect(recording.toAppMap().metadata.truncated).toBeUndefined();
  });
});

describe('metadata shape per recording mode', () => {
  afterEach(() => {
    try {
      stopRecording();
    } catch {
      // no active recording — fine, test already cleaned up
    }
  });

  it('test-mode metadata includes language, frameworks, and source_location', () => {
    const recording = startTestRecording('example test', { sourceLocation: 'test/example.test.ts' });
    const { metadata } = recording.toAppMap();
    expect(metadata.language).toEqual({ name: 'javascript', engine: 'node', version: process.version });
    // Every framework entry carries the version the spec requires, read
    // from the installed package.
    expect(metadata.frameworks).toContainEqual({ name: 'vitest', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    for (const f of metadata.frameworks!) expect(f.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(metadata.source_location).toBe('test/example.test.ts');
  });

  it('interaction-mode metadata has no language/frameworks/source_location today (not a mode-specific bug — unimplemented for that mode entirely)', () => {
    const recording = new Recording({
      name: 'click button',
      client: { name: '@funwithappmap/react-recorder', url: 'https://github.com/getappmap/appmap-react' },
      recorder: { name: 'funwithappmap-react', type: 'requests' },
    });
    const { metadata } = recording.toAppMap();
    expect(metadata.language).toBeUndefined();
    expect(metadata.frameworks).toBeUndefined();
    expect(metadata.source_location).toBeUndefined();
  });
});
