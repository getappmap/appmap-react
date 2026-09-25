import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Metadata } from './types.js';
import { Recording, setValueSizeCap } from './recording.js';
import { installAsyncContext, startRecording, stopRecording, type RecordingContext } from './session.js';

// Test recording: one AppMap per test, written to tmp/appmap/tests/.
// This is milestone 1 (docs/design/01): RTL under Vitest runs in
// Node/jsdom, so the browser collector problem doesn't exist yet —
// we just write the file.

const OUTPUT_DIR = join('tmp', 'appmap', 'tests');

// APPMAP_EVENT_VALUESIZE, like the .NET agent: override the default
// value-size cap for this process.
const envValueSize = Number(process.env.APPMAP_EVENT_VALUESIZE);
if (Number.isFinite(envValueSize) && envValueSize > 0) setValueSizeCap(envValueSize);

// Node has async context: with it, a call made from an async
// continuation (after an await) nests under the call that started it
// instead of floating to the top of the tree (session.ts, runInCall).
installAsyncContext(new AsyncLocalStorage<RecordingContext>());

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
    frameworks: frameworksWithVersions(options.frameworks ?? [{ name: 'vitest' }, { name: 'react' }]),
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

/** The spec requires a version on every framework entry. Fill missing
 * versions from the installed package; leave out a framework that isn't
 * installed rather than claim one. */
function frameworksWithVersions(
  frameworks: { name: string; version?: string }[],
): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const f of frameworks) {
    const version = f.version ?? installedVersion(f.name);
    if (version) out.push({ name: f.name, version });
  }
  return out;
}

const versionCache = new Map<string, string | undefined>();

function installedVersion(pkg: string): string | undefined {
  if (versionCache.has(pkg)) return versionCache.get(pkg);
  let version: string | undefined;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(manifest)) {
      try {
        version = JSON.parse(readFileSync(manifest, 'utf8')).version;
      } catch {
        // unreadable manifest: treat as unknown
      }
      break;
    }
    if (dirname(dir) === dir) break;
  }
  versionCache.set(pkg, version);
  return version;
}
