// For one recording: which minimal, named fixes make it pass each official
// schema version? Answers "which required fields are missing" precisely,
// instead of reading ajv's anyOf noise. Diagnostic only; never changes the file.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const TOOLS = process.env.APPMAP_TOOLS ?? '/root/appmap-tools';
const req = createRequire(path.join(TOOLS, 'package.json'));
const Ajv = req('ajv');
const ajv = new Ajv({ allErrors: true, strict: false });
const dir = path.join(TOOLS, 'node_modules/@appland/appmap-validate/schema');
const versions = fs.readdirSync(dir).filter((f) => /^1-\d+-\d+\.js$/.test(f))
  .map((f) => ({ v: f.slice(0, -3).replace(/-/g, '.'), check: ajv.compile(req(path.join(dir, f)).schema) }))
  .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));

const FIXES = {
  'metadata.language.version': (m) => { if (m.metadata.language) m.metadata.language.version = 'x'; },
  'message[] on http_server_request/http_client_request calls': (m) => {
    for (const e of m.events) if (e.http_server_request || e.http_client_request) e.message ??= [];
  },
  'exceptions[].object_id': (m) => { for (const e of m.events) for (const x of e.exceptions ?? []) x.object_id ??= 1; },
  'parameter/return value <= 100 chars': (m) => {
    for (const e of m.events) for (const p of [...(e.parameters ?? []), ...(e.return_value ? [e.return_value] : [])]) if (p.value?.length > 100) p.value = p.value.slice(0, 100);
  },
};
export function diagnose(file) {
  const orig = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  for (const { v, check } of versions) {
    const names = Object.keys(FIXES);
    // smallest subset of fixes that makes it valid (4 fixes -> 16 subsets)
    let best = null;
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const m = structuredClone(orig); m.version = v;
      const used = names.filter((_, i) => mask & (1 << i));
      used.forEach((n) => FIXES[n](m));
      if (check(m) && (!best || used.length < best.length)) best = used;
    }
    out[v] = best ?? 'not fixable by the named fixes';
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) console.log(path.basename(f), JSON.stringify(diagnose(f), null, 1));
}
