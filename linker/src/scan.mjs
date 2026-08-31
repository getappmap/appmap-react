import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Recursively collect *.appmap.json files under the given directories.
 * @returns {{path: string, appmap: object}[]} */
export function scanAppMaps(dirs) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.appmap.json')) {
        try {
          found.push({ path: full, appmap: JSON.parse(readFileSync(full, 'utf8')) });
        } catch (err) {
          console.warn(`skipping unparseable ${full}: ${err.message}`);
        }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}
