import { describe, it, expect } from 'vitest';
import { Recording } from '../src/recording';
import { instrument } from '../src/instrument';
import { startRecording, stopRecording } from '../src/session';
import type { Event, Metadata } from '../src/types';

// Thread assignment (docs/design/01, 2026 amendment). The AppMap format
// requires each thread_id's own event subsequence to independently nest
// like balanced parentheses. These tests pin down the fix for the bug
// found in review: concurrent siblings sharing one thread could produce
// out-of-order returns that don't nest correctly.

function baseMetadata(): Metadata {
  return {
    name: 'concurrency test',
    client: { name: '@funwithappmap/react-recorder', url: 'https://github.com/getappmap/appmap-react' },
    recorder: { name: 'funwithappmap-react', type: 'requests' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Assert every thread's own event subsequence independently nests like
 * balanced parentheses (call pushes, return must close the most
 * recently opened still-open call on that same thread). */
function assertWellNestedPerThread(events: Event[]): void {
  const byThread = new Map<number, Event[]>();
  for (const event of events) {
    const list = byThread.get(event.thread_id) ?? [];
    list.push(event);
    byThread.set(event.thread_id, list);
  }
  for (const [threadId, threadEvents] of byThread) {
    const stack: number[] = [];
    for (const event of threadEvents) {
      if (event.event === 'call') {
        stack.push(event.id);
      } else {
        const top = stack.pop();
        expect(top, `thread ${threadId}: return for ${event.parent_id} must close the top of its own thread's stack`).toBe(
          event.parent_id,
        );
      }
    }
    expect(stack, `thread ${threadId}: every call must have closed`).toHaveLength(0);
  }
}

describe('thread assignment under concurrency', () => {
  it('gives concurrent Promise.all siblings distinct threads that each nest correctly, regardless of settlement order', async () => {
    const recording = startRecording(new Recording(baseMetadata()));

    const dA = deferred<number>();
    const dB = deferred<number>();
    const callA = instrument(() => dA.promise, { definedClass: 'X', methodId: 'a', path: 'x.ts' });
    const callB = instrument(() => dB.promise, { definedClass: 'X', methodId: 'b', path: 'x.ts' });
    const parent = instrument(
      async () => {
        const [a, b] = await Promise.all([callA(), callB()]);
        return a + b;
      },
      { definedClass: 'X', methodId: 'parent', path: 'x.ts' },
    );

    const resultPromise = parent();
    // B settles before A, out of call order — the scenario the original
    // shared-thread bug mishandled.
    dB.resolve(2);
    dA.resolve(1);
    expect(await resultPromise).toBe(3);
    stopRecording();

    const threadIds = new Set(recording.events.map((e) => e.thread_id));
    expect(threadIds.size).toBeGreaterThanOrEqual(2);
    assertWellNestedPerThread(recording.events);
  });

  it('keeps two fully sequential (non-overlapping) calls on the same thread', async () => {
    const recording = startRecording(new Recording(baseMetadata()));
    const callA = instrument(async () => 'a', { definedClass: 'X', methodId: 'a', path: 'x.ts' });
    const callB = instrument(async () => 'b', { definedClass: 'X', methodId: 'b', path: 'x.ts' });

    await callA();
    await callB();
    stopRecording();

    const threadIds = new Set(recording.events.map((e) => e.thread_id));
    expect(threadIds.size).toBe(1);
    assertWellNestedPerThread(recording.events);
  });
});
