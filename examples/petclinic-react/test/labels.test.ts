import { transformSource } from '../../../recorder/src/transform';
import { autoInstrument, startRecording, stopRecording, Recording } from '@funwithappmap/react-recorder';

// Two label mechanisms (docs/design/08), tested at the two layers each
// one actually lives at:
//
// - `@label` comments and the built-in security/data-access patterns
//   are both compile-time: the transform reads the source and emits a
//   `labels: [...]` array in the info object it hands to
//   autoInstrument. Tested here by inspecting the generated code.
// - Merging those compile-time labels with autoInstrument's own
//   naming-convention labels (component/hook) happens at runtime, in
//   instrument.ts. Tested here by calling autoInstrument directly and
//   inspecting the classMap — labels are function metadata (recorded
//   once per function, in classMap), not repeated on every call event.

function findFunctionEntry(classMap: any[], name: string): any {
  for (const entry of classMap) {
    if (entry.type === 'function' && entry.name === name) return entry;
    if (entry.children) {
      const found = findFunctionEntry(entry.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

describe('@label comments', () => {
  it('labels a plain function declaration from a block comment', async () => {
    const code = `
/** @label security.authz */
export function checkAccess(user) {
  return user.isAdmin;
}
`;
    const result = await transformSource(code, { relPath: 'src/access.ts' });
    expect(result!.code).toContain('labels: ["security.authz"]');
  });

  it('labels a const arrow function and accepts multiple labels on one line', async () => {
    const code = `
// @label io.sql security.authz
const runQuery = (q) => db.execute(q);
`;
    const result = await transformSource(code, { relPath: 'src/db.ts' });
    expect(result!.code).toContain('labels: ["io.sql", "security.authz"]');
  });

  it('adds no labels property when there is no @label comment and no built-in match', async () => {
    const code = `export function noop() { return 1; }`;
    const result = await transformSource(code, { relPath: 'src/noop.ts' });
    expect(result!.code).not.toContain('labels:');
  });
});

describe('built-in security/data-access labels', () => {
  it.each([
    ['supabase.auth.getUser()', 'security.authentication'],
    ['supabase.auth.signInWithPassword(creds)', 'security.authentication'],
    ["supabase.from('waitlist_signups').insert(row)", 'io.sql'],
    ['supabase.rpc("consume_credit")', 'io.sql'],
    ['crypto.subtle.digest("SHA-256", data)', 'security.crypto'],
    ['bcrypt.compare(password, hash)', 'security.crypto'],
    ['jwt.verify(token, secret)', 'security.authentication'],
  ])('labels a function calling %s as %s', async (call, label) => {
    const code = `export function handle() { return ${call}; }`;
    const result = await transformSource(code, { relPath: 'src/handle.ts' });
    expect(result!.code).toContain(`labels: ["${label}"]`);
  });

  it('does not label a same-named method on an unrelated object', async () => {
    // Deliberately documents the tradeoff: this matches on callee
    // *text*, not a resolved import, so an unrelated `.select()` still
    // matches. Not testing a false negative here (there isn't a safe
    // one to assert), but pinning that a call with NO matching shape
    // gets nothing.
    const code = `export function handle() { return list.map(x => x * 2); }`;
    const result = await transformSource(code, { relPath: 'src/handle.ts' });
    expect(result!.code).not.toContain('labels:');
  });

  it('merges multiple built-in matches into one array, de-duplicated', async () => {
    const code = `
export function handle() {
  const user = supabase.auth.getUser();
  const rows = supabase.from('t').select();
  return { user, rows };
}
`;
    const result = await transformSource(code, { relPath: 'src/handle.ts' });
    expect(result!.code).toContain('labels: ["security.authentication", "io.sql"]');
  });
});

describe('label merging at runtime (autoInstrument)', () => {
  // Discard the ambient per-test recording (the ./vitest hooks start
  // one for every test in this suite) so a controlled one can run
  // instead — the same thing interactionRecorder.test.tsx already
  // does for the same reason.

  it('combines a compile-time label with the naming-convention label for a component', () => {
    stopRecording();
    startRecording(new Recording({ name: 'test' }));
    const Component = autoInstrument(
      () => 'ok',
      { definedClass: 'x', methodId: 'LoginForm', path: 'src/x.tsx', labels: ['security.authentication'] },
      [],
    );
    Component();
    const appmap = stopRecording().toAppMap();
    const entry = findFunctionEntry(appmap.classMap, 'LoginForm');
    expect(entry.labels).toEqual(['security.authentication', 'component']);
  });

  it('a plain function with no compile-time label still gets no labels at all', () => {
    stopRecording();
    startRecording(new Recording({ name: 'test' }));
    const fn = autoInstrument(() => 'ok', { definedClass: 'x', methodId: 'helper', path: 'src/x.ts' }, []);
    fn();
    const appmap = stopRecording().toAppMap();
    const entry = findFunctionEntry(appmap.classMap, 'helper');
    expect(entry.labels).toBeUndefined();
  });
});
