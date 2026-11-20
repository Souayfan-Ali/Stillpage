import https from 'node:https';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server/server.js';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

/** GET with any Host header, as Chromium does through `--host-resolver-rules`. */
function get(host: string, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        headers: { host, 'sec-fetch-dest': 'script' },
        rejectUnauthorized: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('fixture server', () => {
  test('serves a fixture page for any hostname and logs host, path and destination', async () => {
    server.clearLog();
    const reply = await get('news.example', '/net/third-party.html');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('fixture: net/third-party');
    expect(server.log()).toEqual([{ host: 'news.example', path: '/net/third-party.html', dest: 'script' }]);
  });

  test('answers other paths with a generic resource by extension, query kept in the log', async () => {
    server.clearLog();
    expect((await get('ads.example', '/ad.js?x=1')).type).toBe('text/javascript');
    expect((await get('pixel.example', '/p.gif')).type).toBe('image/gif');
    expect((await get('x.example', '/anything')).body).toContain('x.example');
    expect(server.log().map((r) => r.path)).toEqual(['/ad.js?x=1', '/p.gif', '/anything']);
  });

  test('counts the body bytes it served since the log was cleared (benchmark bytes, P2-46)', async () => {
    server.clearLog();
    expect(server.bytes()).toBe(0);
    const reply = await get('news.example', '/net/third-party.html');
    expect(server.bytes()).toBe(Buffer.byteLength(reply.body));
    server.clearLog();
    expect(server.bytes()).toBe(0);
  });

  test('never serves a file outside a family directory', async () => {
    for (const path of ['/../package.json', '/net/../../package.json', '/%2e%2e/package.json', '/server/server.ts', '/fixtures.json']) {
      const reply = await get('a.example', path);
      expect(reply.body).not.toContain('"name": "glassmere"');
      expect(reply.body).not.toContain('import');
    }
  });

  test('/redirect?to= answers a 302 to an https address and is logged (pop-up 302 chains, P2-61)', async () => {
    server.clearLog();
    const reply = await get('hop.example', `/redirect?to=${encodeURIComponent('https://popads.example/landing')}`);
    expect(reply.status).toBe(302);
    expect(server.log().map((r) => r.host)).toEqual(['hop.example']);
  });

  test('/redirect refuses a target that is not https', async () => {
    for (const to of ['javascript:alert(1)', 'http://x.example/', '/local', '']) {
      expect((await get('hop.example', `/redirect?to=${encodeURIComponent(to)}`)).status).toBe(400);
    }
  });

  test('/perf/tag.js is an ad tag that burns CPU and adds pixels and a frame from its own host (P2-46)', async () => {
    const reply = await get('ib.adnxs.com', '/perf/tag.js');
    expect(reply.type).toBe('text/javascript');
    expect(reply.body).toContain('performance.now()');
    expect(reply.body).toContain('https://ib.adnxs.com/perf/frame.html');
    expect(reply.body).toContain('https://ib.adnxs.com/perf/px.gif');
    expect(Buffer.byteLength(reply.body)).toBeGreaterThanOrEqual(40 * 1024);
  });

  test('/perf/banner.gif is a GIF of banner weight (20 KiB); other images stay 1 px', async () => {
    server.clearLog();
    expect((await get('ib.adnxs.com', '/perf/banner.gif?1')).type).toBe('image/gif');
    expect(server.bytes()).toBe(20 * 1024);
    expect((await get('ib.adnxs.com', '/perf/px.gif')).body.length).toBeLessThan(100);
  });

  test('an unknown fixture page is a 404', async () => {
    expect((await get('a.example', '/net/missing.html')).status).toBe(404);
  });

  test('the Chromium flags map every host here and pin the throwaway key', () => {
    expect(server.chromiumArgs).toEqual([
      `--host-resolver-rules=MAP * 127.0.0.1:${String(server.port)}`,
      expect.stringMatching(/^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/) as string,
    ]);
  });
});
