// include / exclude matching for the Vite plugin (the appmap.yml
// `packages:` / `exclude:` equivalent).
//
// An entry without glob characters is a directory prefix or an exact file
// ('src', 'src/testing', 'src/main.tsx'), as before. An entry with glob
// characters is matched against the whole project-relative path:
//   *      any characters within one path segment
//   **     any number of segments, including none ('**/__tests__/**')
//   ?      one character within a segment
//   {a,b}  alternatives ('**/*.{test,spec}.tsx')

/** Test code the plugin leaves uninstrumented unless told otherwise
 * (option `defaultExclude`). Tests are not the app: a function defined in
 * a test file showing up in an AppMap is noise. */
export const DEFAULT_TEST_EXCLUDE: readonly string[] = [
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}',
];

export type PathMatcher = (relPath: string) => boolean;

const GLOB_CHARS = /[*?{]/;

export function pathMatcher(entries: readonly string[]): PathMatcher {
  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const raw of entries) {
    const entry = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!entry) continue;
    if (GLOB_CHARS.test(entry)) patterns.push(...expandBraces(entry).map(globToRegExp));
    else prefixes.push(entry);
  }
  return (rel) => {
    const p = rel.split('\\').join('/');
    return prefixes.some((d) => p === d || p.startsWith(d + '/')) || patterns.some((re) => re.test(p));
  };
}

function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++;
    else if (glob[i] === '}' && --depth === 0) {
      const alternatives: string[] = [];
      let start = open + 1;
      let d = 0;
      for (let k = open + 1; k < i; k++) {
        if (glob[k] === '{') d++;
        else if (glob[k] === '}') d--;
        else if (glob[k] === ',' && d === 0) {
          alternatives.push(glob.slice(start, k));
          start = k + 1;
        }
      }
      alternatives.push(glob.slice(start, i));
      const head = glob.slice(0, open);
      const tail = glob.slice(i + 1);
      return alternatives.flatMap((alt) => expandBraces(head + alt + tail));
    }
  }
  return [glob]; // unbalanced: literal
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atSegmentStart && atSegmentEnd) {
          if (i + 2 === glob.length) {
            re += '.*';
            i += 1;
          } else {
            re += '(?:.*/)?';
            i += 2; // '**/'
          }
          continue;
        }
        i += 1;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}
