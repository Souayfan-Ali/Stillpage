/**
 * Throwaway TLS key for the fixture server (S-05): a self-signed P-256 certificate with only a CN and
 * no SANs, made by `openssl` into the git-ignored cache. Chromium trusts it by SPKI pin
 * (`--ignore-certificate-errors-spki-list`), so one key serves every hostname and nothing is ever
 * added to a trust store.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CERT_DIR = path.resolve(import.meta.dirname, '../../../.cache/fixtures/cert');
const VALID_DAYS = '30';

export interface FixtureCert {
  readonly key: Buffer;
  readonly cert: Buffer;
  /** Base64 SHA-256 of the certificate's SubjectPublicKeyInfo. */
  readonly spki: string;
}

function generate(key: string, cert: string): void {
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      VALID_DAYS,
      '-subj',
      '/CN=glassmere-fixture',
    ],
    { stdio: 'ignore' },
  );
}

function isExpiring(cert: string): boolean {
  try {
    // Exit status 1 when the certificate expires within a day.
    execFileSync('openssl', ['x509', '-in', cert, '-noout', '-checkend', '86400'], {
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

export function fixtureCert(): FixtureCert {
  const key = path.join(CERT_DIR, 'key.pem');
  const cert = path.join(CERT_DIR, 'cert.pem');
  if (!existsSync(cert) || !existsSync(key) || isExpiring(cert)) generate(key, cert);
  const pub = execFileSync('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { key: readFileSync(key), cert: readFileSync(cert), spki };
}
