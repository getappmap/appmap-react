import { afterEach, beforeEach } from 'vitest';
import { activeRecording } from './session.js';
import {
  startTestRecording,
  finishTestRecording,
  type TestRecordingOptions,
} from './testRecording.js';

// Vitest-only module (imports 'vitest' and, via testRecording, node:fs);
// deliberately separate from index.ts so the core recorder stays
// loadable in a browser.
export { startTestRecording, finishTestRecording, type TestRecordingOptions } from './testRecording.js';

/** Install beforeEach/afterEach hooks that record every test in the
 * importing project. Call from a Vitest setup file. */
export function registerAppMapHooks(options: TestRecordingOptions = {}): void {
  beforeEach((ctx) => {
    startTestRecording(taskFullName(ctx.task), {
      sourceLocation: ctx.task.file?.name,
      ...options,
    });
  });
  afterEach((ctx) => {
    if (!activeRecording()) return;
    finishTestRecording(ctx.task.result?.state === 'fail' ? 'failed' : 'succeeded');
  });
}

interface TaskLike {
  name: string;
  suite?: TaskLike;
}

function taskFullName(task: TaskLike): string {
  const parts: string[] = [];
  for (let t: TaskLike | undefined = task; t; t = t.suite) parts.unshift(t.name);
  return parts.join(' > ');
}
