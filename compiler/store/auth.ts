/**
 * Service-account auth for the store API (research notes 03 §7.3, P2-04): an RS256-signed JWT exchanged for a
 * short-lived access token (OAuth 2.0 JWT bearer grant). No long-lived refresh token exists anywhere.
 * The key file is read by the CLI from a path the owner supplies through the protected CI environment;
 * nothing here logs the key, the assertion or the token. Dependency-free (D-71): runs with plain `node`.
 */
import { createSign } from 'node:crypto';
import { STORE_SCOPE, TOKEN_URL, TokenResponseSchema, type Transport } from './contract.ts';

const TOKEN_LIFETIME_S = 3600;
const MS_PER_S = 1000;
const HTTP_OK = 200;

/** The fields of a Google service-account key file that are used (others are kept, never read). */
export interface ServiceAccountKey {
  readonly type: 'service_account';
  readonly client_email: string;
  readonly private_key: string;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Validates a parsed key file; errors never quote it. */
export const ServiceAccountKeySchema = {
  parse(value: unknown): ServiceAccountKey {
    const v = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const email = v['client_email'];
    const pem = v['private_key'];
    if (v['type'] !== 'service_account' || typeof email !== 'string' || !EMAIL.test(email) || typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) {
      throw new Error('not a service-account key');
    }
    return value as ServiceAccountKey;
  },
};

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

function assertion(key: ServiceAccountKey, nowMs: number): string {
  const iat = Math.floor(nowMs / MS_PER_S);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: STORE_SCOPE, aud: TOKEN_URL, iat, exp: iat + TOKEN_LIFETIME_S }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** A fresh access token for `key`. Errors name the HTTP status only (the body may echo credentials). */
export async function serviceAccountToken(key: ServiceAccountKey, transport: Transport, now: () => number): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(key, now()) }).toString();
  const res = await transport({ method: 'POST', url: TOKEN_URL, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (res.status !== HTTP_OK) throw new Error(`token request refused (HTTP ${String(res.status)})`);
  const parsed = TokenResponseSchema.safeParse(res.json);
  if (!parsed.success) throw new Error('token response has no access token');
  return parsed.data.access_token;
}
