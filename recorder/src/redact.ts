// Credentials never go into a recording in plaintext. AppMaps get
// committed, attached to PRs and shared; the acceptance runs found
// plaintext passwords in React parameter values and a bearer token in a
// Deno one.
//
// - A parameter, property, query parameter or header whose *name*
//   matches SENSITIVE_NAME has its value replaced by "[REDACTED]".
// - Authorization, Cookie and Set-Cookie headers are always redacted.
// - "Bearer <token>" anywhere inside a captured string keeps the word
//   Bearer and loses the token.
// - A JWT anywhere inside a captured string is redacted whatever it is
//   called: a Supabase client object carries its key as `supabaseKey`,
//   which no name rule catches.

export const REDACTED = '[REDACTED]';

const SENSITIVE_NAME = /password|secret|token|api[_-]?key/i;
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;
const BEARER = /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

export function isSensitiveName(name: string | undefined): boolean {
  return !!name && SENSITIVE_NAME.test(name);
}

export function redactString(s: string): string {
  return s.replace(BEARER, `$1 ${REDACTED}`).replace(JWT, REDACTED);
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) || isSensitiveName(name) ? REDACTED : redactString(value);
  }
  return out;
}
