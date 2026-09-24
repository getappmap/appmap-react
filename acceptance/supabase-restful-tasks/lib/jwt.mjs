// HS256 JWT for the local PostgREST (role claim selects the DB role).
import crypto from 'node:crypto';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
export function jwt(role, secret = process.env.JWT_SECRET ?? 'acceptance-local-jwt-secret-at-least-32-chars') {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role, iss: 'acceptance', iat: 1700000000, exp: 4102444800 });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(jwt(process.argv[2] ?? 'authenticated'));
