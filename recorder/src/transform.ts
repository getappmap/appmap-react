import { basename } from 'node:path';
import { transformAsync, types as t, type BabelFileResult, type NodePath, type PluginObj } from '@babel/core';

// The build-time instrumentation transform (docs/design/03), host-
// agnostic: no Vite types here, so any driver can run it — the Vite
// plugin (browser/vitest builds), or a standalone pre-build pass over
// server-side TypeScript before a runtime that has no loader hook
// executes it (e.g. Deno / Supabase edge functions: transform, then
// `deno run` / `supabase functions serve` the instrumented output).
//
// It injects, for every top-level function in a module, exactly the
// wrapper the hand-instrumentation spike applied manually:
//
//   function Foo(props) {...}   →  Foo = __appmap_instrument__(Foo, info, argNames)
//   const useBar = () => {...}  →  const useBar = __appmap_instrument__(() => {...}, info)
//
// plus one import of the runtime entry point. `runtimeModule`
// configures that import specifier because module resolution is the
// one thing hosts genuinely disagree on: a bare npm specifier for
// Vite/Node, a URL or import-map name for Deno.
//
// Labels (docs/design/08): a `@label` line in the function's leading
// comment, no import required — the appmap-java /
// com.appland.appmap.annotation equivalent, but free: nothing to add
// to package.json.
//
//   /** @label security.authz */
//   export function checkAccess(user) {...}
//
// These are additive to autoInstrument's own naming-convention labels
// (PascalCase → component, use[A-Z]… → hook), not a replacement —
// instrument.ts merges the two.

function extractLabels(comments: readonly t.Comment[] | null | undefined): string[] {
  if (!comments) return [];
  const labels: string[] = [];
  for (const comment of comments) {
    for (const rawLine of comment.value.split('\n')) {
      const line = rawLine.replace(/^[ \t]*\*?[ \t]*/, '');
      const match = /^@label[ \t]+(.+)$/.exec(line);
      if (match) labels.push(...match[1].trim().split(/\s+/).filter(Boolean));
    }
  }
  return labels;
}

// Built-in labels (docs/design/08): recognizes calls to well-known
// security/data-access APIs *inside* a wrapped function's body and
// labels the function automatically — no comment, no naming
// convention needed. This is appmap-java/appmap-dotnet's "built-in
// hooks" idea (their SQL/crypto/auth labeling of known driver calls),
// scoped here to the JS/TS/Deno + Supabase stack this project actually
// targets. Matches on the callee's own source text (a raw slice of
// the original code, not a resolved import) — deliberately simple
// pattern matching, not import-graph analysis, so it stays
// dependency-free and fast; the tradeoff is it can't tell a real
// Supabase client from a differently-shaped object that happens to
// have a `.from()` method. Good enough as a first pass; a false
// positive is a label, not a wrong behavior.
const BUILTIN_LABEL_PATTERNS: Array<{ label: string; test: RegExp }> = [
  // Supabase auth vs. data access share one client — split on the
  // fluent-call path, not the import.
  // Note: callee.start/.end bounds the callee expression only, never
  // the call's own parentheses — `supabase.rpc(x)`'s callee text is
  // "supabase.rpc", not "supabase.rpc(". Patterns below match against
  // that, anchored with $ where the property name is the last segment.
  { label: 'security.authentication', test: /\.auth\.(signIn\w*|signUp|signOut|verifyOtp|admin\.\w+|getUser|getSession|refreshSession|resetPasswordForEmail)$/ },
  { label: 'io.sql', test: /\.(from|rpc)$/ },
  { label: 'io.sql', test: /\.(select|insert|update|upsert|delete)$/ },
  // Web Crypto API and the common password-hashing libraries.
  { label: 'security.crypto', test: /crypto\.subtle\./ },
  { label: 'security.crypto', test: /\b(bcrypt|argon2|scrypt)\b/i },
  // JWTs.
  { label: 'security.authentication', test: /\bjwt\.(sign|verify|decode)$/ },
  { label: 'security.authentication', test: /\bjose\./ },
];

function detectBuiltinLabels(fnPath: NodePath, code: string): string[] {
  const found = new Set<string>();
  fnPath.traverse({
    CallExpression(callPath) {
      const callee = callPath.node.callee;
      if (callee.start == null || callee.end == null) return;
      const calleeText = code.slice(callee.start, callee.end);
      for (const { label, test } of BUILTIN_LABEL_PATTERNS) {
        if (test.test(calleeText)) found.add(label);
      }
    },
  });
  return [...found];
}

const RUNTIME_NAME = '__appmap_instrument__';
export const DEFAULT_RUNTIME_MODULE = '@funwithappmap/react-recorder';

export interface TransformOptions {
  /** Project-relative path recorded as the AppMap function location. */
  relPath: string;
  /** Filename handed to Babel (diagnostics, sourcemap source). */
  filename?: string;
  /** Parse JSX (for .tsx/.jsx sources). */
  jsx?: boolean;
  /** Import specifier for the recorder runtime. */
  runtimeModule?: string;
}

export async function transformSource(
  code: string,
  options: TransformOptions,
): Promise<{ code: string; map: BabelFileResult['map'] } | null> {
  const result = await transformAsync(code, {
    filename: options.filename ?? options.relPath,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    parserOpts: { plugins: options.jsx ? ['typescript', 'jsx'] : ['typescript'] },
    plugins: [
      instrumentBabelPlugin(options.relPath, options.runtimeModule ?? DEFAULT_RUNTIME_MODULE, code),
    ],
  });
  if (!result?.code) return null;
  return { code: result.code, map: result.map };
}

export function instrumentBabelPlugin(relPath: string, runtimeModule: string, code: string): PluginObj {
  const definedClass = basename(relPath).replace(/\.[jt]sx?$/, '');
  let wrapped = 0;

  const infoObject = (name: string, lineno: number | undefined, labels: string[]) =>
    t.objectExpression([
      t.objectProperty(t.identifier('definedClass'), t.stringLiteral(definedClass)),
      t.objectProperty(t.identifier('methodId'), t.stringLiteral(name)),
      t.objectProperty(t.identifier('path'), t.stringLiteral(relPath)),
      ...(lineno ? [t.objectProperty(t.identifier('lineno'), t.numericLiteral(lineno))] : []),
      ...(labels.length
        ? [t.objectProperty(t.identifier('labels'), t.arrayExpression(labels.map((l) => t.stringLiteral(l))))]
        : []),
    ]);

  const argNamesArray = (params: t.Function['params'], componentLike: boolean) =>
    t.arrayExpression(
      params.map((p, i) => {
        if (t.isIdentifier(p)) return t.stringLiteral(p.name);
        if (i === 0 && componentLike) return t.stringLiteral('props');
        return t.stringLiteral(`arg${i}`);
      }),
    );

  const wrapCall = (
    fn: t.Expression,
    name: string,
    params: t.Function['params'],
    lineno: number | undefined,
    labels: string[],
  ) => {
    wrapped++;
    return t.callExpression(t.identifier(RUNTIME_NAME), [
      fn,
      infoObject(name, lineno, labels),
      argNamesArray(params, /^[A-Z]/.test(name)),
    ]);
  };

  return {
    visitor: {
      Program: {
        enter(program) {
          for (const stmt of program.get('body')) {
            const decl =
              stmt.isExportNamedDeclaration() && stmt.node.declaration
                ? stmt.get('declaration')
                : stmt;
            if (Array.isArray(decl)) continue;
            const commentLabels = extractLabels(stmt.node.leadingComments);

            if (decl.isFunctionDeclaration() && decl.node.id && !decl.node.generator) {
              const { id, params, loc } = decl.node;
              const labels = [...new Set([...commentLabels, ...detectBuiltinLabels(decl, code)])];
              // Function declarations are mutable bindings, and ESM
              // exports are live: reassigning after the declaration
              // rebinds the export too.
              stmt.insertAfter(
                t.expressionStatement(
                  t.assignmentExpression(
                    '=',
                    t.identifier(id.name),
                    wrapCall(t.identifier(id.name), id.name, params, loc?.start.line, labels),
                  ),
                ),
              );
            } else if (decl.isVariableDeclaration()) {
              for (const d of decl.get('declarations')) {
                const init = d.get('init');
                const idPath = d.get('id');
                if (!idPath.isIdentifier()) continue;
                if (init.isArrowFunctionExpression() || init.isFunctionExpression()) {
                  const labels = [...new Set([...commentLabels, ...detectBuiltinLabels(init, code)])];
                  init.replaceWith(
                    wrapCall(
                      init.node,
                      idPath.node.name,
                      init.node.params,
                      init.node.loc?.start.line,
                      labels,
                    ),
                  );
                }
              }
            }
          }
        },
        exit(program) {
          if (wrapped === 0) return;
          program.node.body.unshift(
            t.importDeclaration(
              [t.importSpecifier(t.identifier(RUNTIME_NAME), t.identifier('autoInstrument'))],
              t.stringLiteral(runtimeModule),
            ),
          );
        },
      },
    },
  };
}
