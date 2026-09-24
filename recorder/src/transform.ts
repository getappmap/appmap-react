import { basename } from 'node:path';
import {
  transformAsync,
  types as t,
  type BabelFileResult,
  type PluginObj,
  type NodePath,
} from '@babel/core';

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
// 2026 amendment (docs/design/03): the transform also reaches inside
// each top-level function/component/hook body — nested named
// functions, nested `const x = arrow/function`, arrows passed as the
// first argument to useCallback/useMemo, and arrow/function
// expressions used inline as JSX event-handler props (onClick,
// onSubmit, …) — using the same 2-arg call shape the hand-written
// `instrumentHandler` used, since Babel gives real `loc` info here
// with no hand-supplied line numbers needed. `instrumentHandler`
// itself stays exported as the advanced-scenarios escape hatch for
// shapes the transform still doesn't reach (e.g. functions built up
// dynamically at runtime).
//
// Labels (docs/design/08) can be supplied by `@label` comments or inferred
// from common security/data-access calls in a function body. They are passed
// to autoInstrument, which merges them with convention labels.

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

const BUILTIN_LABEL_PATTERNS: Array<{ label: string; test: RegExp }> = [
  { label: 'security.authentication', test: /\.auth\.(signIn\w*|signUp|signOut|verifyOtp|admin\.\w+|getUser|getSession|refreshSession|resetPasswordForEmail)$/ },
  { label: 'io.sql', test: /\.(from|rpc)$/ },
  { label: 'io.sql', test: /\.(select|insert|update|upsert|delete)$/ },
  { label: 'security.crypto', test: /crypto\.subtle\./ },
  { label: 'security.crypto', test: /\b(bcrypt|argon2|scrypt)\b/i },
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
const HANDLER_RUNTIME_NAME = '__appmap_instrument_handler__';
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

export function instrumentBabelPlugin(relPath: string, runtimeModule: string, code = ''): PluginObj {
  const definedClass = basename(relPath).replace(/\.[jt]sx?$/, '');
  let wrapped = 0;
  let handlerWrapped = 0;

  const infoObject = (name: string, lineno: number | undefined, labels: string[] = []) =>
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

  // The 2-arg shape the hand-written instrumentHandler used: no
  // argNames, always labeled ['event-handler']. Used for everything
  // this transform reaches below the top level — nested closures are
  // overwhelmingly event handlers/callbacks in this domain, matching
  // what the codebase already did by hand.
  const wrapHandlerCall = (fn: t.Expression, name: string, lineno?: number) => {
    handlerWrapped++;
    return t.callExpression(t.identifier(HANDLER_RUNTIME_NAME), [fn, infoObject(name, lineno)]);
  };

  // Nested instrumentation (2026 amendment, docs/design/03): walks a
  // top-level function/component/hook's body for closures below the
  // top-level visitor's granularity. Run on each top-level function
  // BEFORE that function itself is wrapped (see below), so this always
  // sees the pristine, unwrapped tree.
  const instrumentNested = (fnPath: NodePath<t.Function>) => {
    fnPath.traverse({
      FunctionDeclaration(path) {
        const { id, params, body, generator, async: isAsync, loc } = path.node;
        if (!id || generator) return;
        path.replaceWith(
          t.variableDeclaration('const', [
            t.variableDeclarator(
              t.identifier(id.name),
              wrapHandlerCall(
                t.functionExpression(id, params, body, generator, isAsync),
                id.name,
                loc?.start.line,
              ),
            ),
          ]),
        );
        path.skip();
      },
      VariableDeclarator(path) {
        const idPath = path.get('id');
        const init = path.get('init');
        if (!idPath.isIdentifier() || !init.node) return;

        // const name = useCallback(fn, deps) / useMemo(fn, deps) — wrap
        // just the callback argument, leave the hook call itself alone.
        if (init.isCallExpression()) {
          const callee = init.node.callee;
          const calleeName = t.isIdentifier(callee) ? callee.name : undefined;
          if (calleeName !== 'useCallback' && calleeName !== 'useMemo') return;
          const first = init.get('arguments')[0];
          if (!first || (!first.isArrowFunctionExpression() && !first.isFunctionExpression())) return;
          first.replaceWith(wrapHandlerCall(first.node, idPath.node.name, first.node.loc?.start.line));
          path.skip();
          return;
        }

        if (init.isArrowFunctionExpression() || init.isFunctionExpression()) {
          init.replaceWith(wrapHandlerCall(init.node, idPath.node.name, init.node.loc?.start.line));
          path.skip();
        }
      },
      JSXAttribute(path) {
        const name = path.node.name;
        if (!t.isJSXIdentifier(name) || !/^on[A-Z]/.test(name.name)) return;
        const value = path.get('value');
        if (!value.isJSXExpressionContainer()) return;
        const expr = value.get('expression');
        if (!expr.isArrowFunctionExpression() && !expr.isFunctionExpression()) return;
        expr.replaceWith(wrapHandlerCall(expr.node, name.name, expr.node.loc?.start.line));
        path.skip();
      },
    });
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
              instrumentNested(decl);
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
                  instrumentNested(init);
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
          if (wrapped === 0 && handlerWrapped === 0) return;
          const specifiers: t.ImportSpecifier[] = [];
          if (wrapped > 0) {
            specifiers.push(
              t.importSpecifier(t.identifier(RUNTIME_NAME), t.identifier('autoInstrument')),
            );
          }
          if (handlerWrapped > 0) {
            specifiers.push(
              t.importSpecifier(t.identifier(HANDLER_RUNTIME_NAME), t.identifier('instrumentHandler')),
            );
          }
          program.node.body.unshift(t.importDeclaration(specifiers, t.stringLiteral(runtimeModule)));
        },
      },
    },
  };
}
