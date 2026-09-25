# 8. Labels: comment tags and built-in security/data-access patterns

Status: **accepted**, validated by
[`examples/petclinic-react/test/labels.test.ts`](../../examples/petclinic-react/test/labels.test.ts)
(14 tests: transform output for both mechanisms, and the runtime merge).

## Why this needed doing

Doc 03 noted labels came from naming conventions only (PascalCase →
`component`, `use[A-Z]…` → `hook`). That leaves no way to mark a
function as security- or data-access-relevant without either editing
runtime code (against docs 06/07's whole point) or renaming it to fit
a convention that doesn't exist for that purpose. appmap-java and
appmap-dotnet solve this two ways: an annotation a developer applies
by hand (`com.appland.appmap.annotation`, `AppMap.Attributes`), and
built-in hooks that recognize known driver/library calls (SQL, crypto)
and label them automatically, no annotation needed. This doc adds
both, for JS/TS.

## Mechanism 1: `@label` comments

```ts
/** @label security.authz */
export function checkAccess(user) { ... }

// @label io.sql security.authz
const runQuery = (q) => db.execute(q);
```

No import — the transform reads the function's leading comment
(`stmt.node.leadingComments`, so it works whether or not the
declaration is exported) and pulls out every `@label` line, splitting
on whitespace for multiple labels on one line. This is the free
version of an annotation-only package: nothing to add to
`package.json`, nothing to import, works in a `.ts` file with zero
runtime dependency on the recorder.

## Mechanism 2: built-in security/data-access labels

```ts
export async function handle(req) {
  const { data: { user } } = await supabase.auth.getUser();   // security.authentication
  const { data } = await supabase.from('orders').select();     // io.sql
  const ok = await bcrypt.compare(pw, hash);                   // security.crypto
}
```

The transform walks each wrapped function's body for `CallExpression`s
and matches the callee's own source text (not a resolved import)
against a small table: Supabase auth methods → `security.authentication`,
`.from()`/`.rpc()`/`.select()`/`.insert()`/`.update()`/`.upsert()`/`.delete()`
→ `io.sql`, Web Crypto (`crypto.subtle.*`) and `bcrypt`/`argon2`/`scrypt`
→ `security.crypto`, `jwt.sign/verify/decode` and `jose.*` →
`security.authentication`.

**Scoped deliberately to what this project's own downstream user
actually runs** (Supabase + the common JS crypto/JWT libraries), not a
general port of appmap-java's whole built-in-hooks table. Extending
the table is adding a row, not a redesign.

**The tradeoff, stated plainly:** this matches callee *text*, not a
resolved import binding. A local variable that happens to be named
`supabase` with an unrelated `.from()` method gets the same label a
real Supabase client would. That's a false positive, not a wrong
program — a label is a hint for a reviewer, not a security control —
and it's the same tradeoff a fully-qualified-name table makes when the
name is common enough to collide. Real import-graph resolution would
remove it, at real implementation cost; not done here.

**One implementation detail worth flagging:** `callee.start`/`.end`
bounds the callee expression only, never the call's own parentheses —
`supabase.rpc(x)`'s callee text is `"supabase.rpc"`, not
`"supabase.rpc("`. Every pattern in the table is written against that
(anchored with `$` where the property name is the last segment), not
guessed — this was caught by a failing test on the first pass, not
assumed correct because the code looked reasonable.

## Merging with naming-convention labels

Both mechanisms above are compile-time — the transform, not
`autoInstrument`. `autoInstrument` still applies its own runtime
naming-convention labels (`component`, `hook`) on top, and the two are
merged, not one replacing the other:

```ts
autoInstrument(fn, { ..., methodId: 'LoginForm', labels: ['security.authentication'] })
// → classMap entry: labels: ['security.authentication', 'component']
```

This mattered because the old signature (`Omit<FunctionInfo, 'labels'>`)
made it a type error to even try passing a label in, and the old
implementation (`{ ...info, labels }` with the naming-convention value
computed last) would have silently discarded whatever the transform
sent — the exact bug a merge-not-replace design has to actively avoid.

## Where labels actually live

Labels are classMap metadata — recorded once per function, not
repeated on every call event. A test that checks `event.labels`
instead of `classMap`'s function entry will always see `undefined`;
this cost one iteration on this doc's own test suite before landing on
`classMap`.

## Consequences

- Nothing here requires touching the doc 06/07 zero-touch story — a
  `@label` comment or a `supabase.from()` call is already in the
  developer's own code; the transform reads what's there.
- Built-in labels are attributed to the top-level function whose body
  contains the recognized call. Nested handlers are also instrumented
  by the current transform, but do not receive a separate built-in
  label from that call.
