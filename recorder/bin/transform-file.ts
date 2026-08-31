// Standalone driver for the instrumentation transform (docs/design/03
// amendment): transforms one source file for runtimes with no loader
// hook (e.g. Deno / Supabase edge functions), which then execute the
// instrumented output directly.
//
// usage:
//   node --experimental-strip-types recorder/bin/transform-file.ts \
//     <input.ts> <output.ts> --runtime <specifier> [--jsx]
//
// <specifier> is what the instrumented file will import the recorder
// runtime from: for Deno, a relative path with extension (./appmap.ts)
// or a URL; for Node/Vite, a bare package name.

import { readFileSync, writeFileSync } from 'node:fs';
import { transformSource } from '../src/transform.ts';

const args = process.argv.slice(2);
const positional: string[] = [];
let runtime: string | undefined;
let jsx = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runtime') runtime = args[++i];
  else if (args[i] === '--jsx') jsx = true;
  else positional.push(args[i]);
}
const [input, output] = positional;
if (!input || !output || !runtime) {
  console.error(
    'usage: node --experimental-strip-types recorder/bin/transform-file.ts <input> <output> --runtime <specifier> [--jsx]',
  );
  process.exit(2);
}

const result = await transformSource(readFileSync(input, 'utf8'), {
  relPath: input,
  filename: input,
  jsx,
  runtimeModule: runtime,
});
if (!result) {
  console.error(`transform produced no output for ${input}`);
  process.exit(1);
}
writeFileSync(output, result.code + '\n');
console.log(`instrumented ${input} -> ${output} (runtime: ${runtime})`);
