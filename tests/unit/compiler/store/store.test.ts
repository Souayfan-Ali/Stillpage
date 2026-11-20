import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { serviceAccountToken, ServiceAccountKeySchema } from '../../../../compiler/store/auth.js';
import { createStoreClient, toStoreState } from '../../../../compiler/store/client.js';
import { checkItemRef, STORE_SCOPE, TOKEN_URL, urls, type Transport } from '../../../../compiler/store/contract.js';
import { FAKE_ITEM, fakeStore } from '../../../../compiler/store/fake.js';
import { extensionZip } from '../release/fixtures.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = { type: 'service_account', client_email: 'ci@placeholder.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const NOW = Date.UTC(2026, 10, 14, 5, 30);
const b64url = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

describe('service-account auth (P2-04)', () => {
  test('exchanges an RS256-signed JWT with the store scope for an access token', async () => {
    const sent: { url: string; body: string }[] = [];
    const transport: Transport = (r) => {
      sent.push({ url: r.url, body: String(r.body) });
      return Promise.resolve({ status: 200, json: { access_token: 'tok', expires_in: 3600, token_type: 'Bearer' } });
    };
    expect(await serviceAccountToken(ServiceAccountKeySchema.parse(KEY), transport, () => NOW)).toBe('tok');
    expect(sent[0]?.url).toBe(TOKEN_URL);
    const form = new URLSearchParams(sent[0]?.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h = '', p = '', sig = ''] = (form.get('assertion') ?? '').split('.');
    expect(JSON.parse(b64url(h))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(b64url(p))).toEqual({ iss: KEY.client_email, scope: STORE_SCOPE, aud: TOKEN_URL, iat: NOW / 1000, exp: NOW / 1000 + 3600 });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
  });

  test('a refused token request fails without echoing the response body', async () => {
    const transport: Transport = () => Promise.resolve({ status: 401, json: { error: 'invalid_grant', secret: 'do-not-print' } });
    await expect(serviceAccountToken(ServiceAccountKeySchema.parse(KEY), transport, () => NOW)).rejects.toThrow(/^token request refused \(HTTP 401\)$/);
  });

  test('a key file that is not a service-account key is refused', () => {
    expect(() => ServiceAccountKeySchema.parse({ ...KEY, type: 'authorized_user' })).toThrow();
  });
});

describe('store client requests (recorded contract)', () => {
  test('status, upload and publish hit the v2 routes with a bearer token', async () => {
    const fake = fakeStore({ publishedVersion: '1.0.317.600', publish: 'live' });
    const seen: Record<string, string>[] = [];
    const spy: Transport = (r) => { seen.push({ ...r.headers }); return fake.transport(r); };
    const client = createStoreClient(FAKE_ITEM, spy, () => Promise.resolve('fake-access-token'));
    expect(toStoreState(await client.status())).toEqual({ published: true, publishedVersion: '1.0.317.600', warned: false, pendingSubmission: false });
    expect(await client.upload(extensionZip({ version: '1.0.318.600' }))).toEqual({ state: 'SUCCEEDED', version: '1.0.318.600' });
    await client.publishSkipReview();
    expect(fake.log.map((l) => `${l.method} ${l.url}`)).toEqual([`GET ${urls.status(FAKE_ITEM)}`, `POST ${urls.upload(FAKE_ITEM)}`, `POST ${urls.publish(FAKE_ITEM)}`]);
    expect(fake.log[2]?.body).toEqual({ publishType: 'DEFAULT_PUBLISH', skipReview: true });
    expect(seen.every((h) => h['Authorization'] === 'Bearer fake-access-token')).toBe(true);
  });

  test('a malformed answer or an HTTP error is an error, not a guess', async () => {
    const bad: Transport = () => Promise.resolve({ status: 200, json: { uploadState: 'MAYBE' } });
    await expect(createStoreClient(FAKE_ITEM, bad, () => Promise.resolve('t')).upload(new Uint8Array())).rejects.toThrow(/unexpected answer/);
    const down: Transport = () => Promise.resolve({ status: 503, json: { error: { message: 'down' } } });
    await expect(createStoreClient(FAKE_ITEM, down, () => Promise.resolve('t')).status()).rejects.toThrow(/HTTP 503/);
  });

  test('item ids are checked before they reach a URL', () => {
    expect(() => checkItemRef({ publisherId: '../x', itemId: 'a' })).toThrow(/plain ids/);
    expect(checkItemRef(FAKE_ITEM)).toBe(FAKE_ITEM);
  });

  test('a full release is a separate call that asks for review', async () => {
    const fake = fakeStore({ publishedVersion: '1.0.317.600' });
    await createStoreClient(FAKE_ITEM, fake.transport, () => Promise.resolve('t')).publishWithReview();
    expect(fake.log.at(-1)?.body).toEqual({ publishType: 'STAGED_PUBLISH', skipReview: false });
  });
});
