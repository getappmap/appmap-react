import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Metadata } from './types';
import { Recording } from './recording';
import { startRecording, stopRecording } from './session';

// Test recording: one AppMap per test, written to tmp/appmap/tests/.
// This is milestone 1 (docs/design/01): RTL under Vitest runs in
// Node/jsdom, so the browser collector problem doesn't exist yet —
// we just write the file.

const OUTPUT_DIR = join('tmp', 'appmap', 'tests');

export interface TestRecordingOptions {
  app?: string;
  sourceLocation?: string;
  frameworks?: { name: string; version?: string }[];
}

export function startTestRecording(name: string, options: TestRecordingOptions = {}): Recording {
  const metadata: Metadata = {
    name,
    app: options.app,
    language: { name: 'javascript', engine: 'node', version: process.version },
    client: {
      name: '@funwithappmap/react-recorder',
      url: 'https://github.com/getappmap/appmap-react',
    },
    recorder: { name: 'funwithappmap-react', type: 'tests' },
    frameworks: options.frameworks ?? [{ name: 'vitest' }],
    source_location: options.sourceLocation,
  };
  return startRecording(new Recording(metadata));
}

export function finishTestRecording(status: 'succeeded' | 'failed'): string {
  const recording = stopRecording();
  const appmap = recording.toAppMap({ test_status: status });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = join(OUTPUT_DIR, `${sanitize(appmap.metadata.name)}.appmap.json`);
  writeFileSync(file, JSON.stringify(appmap, null, 2));
  return file;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
}
