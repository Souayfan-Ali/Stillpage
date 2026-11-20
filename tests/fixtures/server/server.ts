/**
 * The fixture server (P1-42, testing notes §3, S-05): one HTTPS server on 127.0.0.1 answering for every
 * hostname. Chromium reaches it through `--host-resolver-rules=MAP * 127.0.0.1:<port>`, so rules
 * written for real hostnames match and nothing leaves the machine. Pages come from
 * `tests/fixtures/<family>/<name>.html`; any other path gets a small generic resource by extension.
 * Every request is logged (host, path with query, fetch destination) so tests can assert both what
 * was fetched and what was not. `/redirect?to=` answers one 302 hop to an https address (P2-61).
 */
import { readFile } from 'node:fs/promises';
import type http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fixtureCert } from './cert.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '..');
/** `family/name.html`, lower-case words only: no `..`, no hidden files, nothing outside a family dir. */
const PAGE_PATH = /^\/([a-z0-9-]+)\/([a-z0-9-]+\.html)$/;
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

interface LoggedRequest {
  readonly host: string;
  /** Path and query, as received. */
  readonly path: string;
  readonly dest: string | undefined;
}

export interface FixtureServer {
  readonly port: number;
  readonly spki: string;
  /** Requests seen so far, oldest first. */
  readonly log: () => readonly LoggedRequest[];
  readonly clearLog: () => void;
  /** Body bytes served since the log was last cleared (what reached the page, for the benchmark). */
  readonly bytes: () => number;
  /** Chromium flags that send every hostname here and trust the throwaway key. */
  readonly chromiumArgs: readonly string[];
  readonly close: () => Promise<void>;
}

interface Reply {
  readonly status: number;
  readonly type: string;
  readonly body: string | Buffer;
}

/** Each fetched script records its own address, so a page can tell which scripts ran. */
const SCRIPT = "(self.__ran = self.__ran || []).push(document.currentScript ? document.currentScript.src : '');\n";

async function page(pathname: string): Promise<Reply | null> {
  const match = PAGE_PATH.exec(pathname);
  if (match === null) return null;
  const [, family = '', name = ''] = match;
  try {
    return {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: await readFile(path.join(FIXTURES_DIR, family, name)),
    };
  } catch {
    return { status: 404, type: 'text/plain', body: 'no such fixture' };
  }
}

/** `/redirect?to=<https address>`: one hop of a 302 chain (pop-up destinations, P2-61); nothing else. */
function redirect(url: URL): Reply & { readonly location?: string } {
  const to = url.searchParams.get('to') ?? '';
  const valid = URL.canParse(to) && new URL(to).protocol === 'https:';
  return valid ? { status: 302, type: 'text/plain', body: '', location: to } : { status: 400, type: 'text/plain', body: 'bad redirect target' };
}

/** CPU an ad tag burns on load and again shortly after, like S-15's ad stack (P2-46 benchmark pages). */
const TAG_BURN_MS = 60;
const TAG_LATE_BURN_MS = 30;
const burn = (ms: number): string => `(()=>{const t=performance.now();while(performance.now()-t<${String(ms)}){}})();`;

/** Typical ad weights for the benchmark's byte figures: a 40 KiB tag, a 20 KiB banner. */
const TAG_BYTES = 40 * 1024;
const BANNER_BYTES = 20 * 1024;
/** A GIF decoder stops at the trailer, so padding after it only adds weight. */
const BANNER_GIF = Buffer.concat([GIF_1PX, Buffer.alloc(BANNER_BYTES - GIF_1PX.length)]);

/** `/perf/tag.js` on any host: burns CPU, adds three pixels and a frame from that host; padded to tag weight. */
function adTag(host: string): string {
  const origin = `https://${host}`;
  const code = `${burn(TAG_BURN_MS)}
for(let i=0;i<3;i++){const im=new Image();im.src='${origin}/perf/px.gif?'+i;}
const f=document.createElement('iframe');f.src='${origin}/perf/frame.html';f.style.cssText='width:300px;height:250px;border:0';(document.body||document.documentElement).append(f);
setTimeout(()=>{${burn(TAG_LATE_BURN_MS)}},200);
`;
  return `${code}/*${'x'.repeat(Math.max(0, TAG_BYTES - code.length - 5))}*/\n`;
}

function resource(url: URL): Reply {
  if (url.pathname === '/perf/tag.js') return { status: 200, type: 'text/javascript', body: adTag(url.hostname) };
  if (url.pathname === '/perf/banner.gif') return { status: 200, type: 'image/gif', body: BANNER_GIF };
  const ext = path.extname(url.pathname);
  if (ext === '.js') return { status: 200, type: 'text/javascript', body: SCRIPT };
  if (ext === '.gif' || ext === '.png') return { status: 200, type: 'image/gif', body: GIF_1PX };
  if (ext === '.css') return { status: 200, type: 'text/css', body: '' };
  return {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: `<!doctype html><title>${url.hostname}</title><p>${url.hostname}</p>`,
  };
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const { key, cert, spki } = fixtureCert();
  let log: readonly LoggedRequest[] = [];
  let bytes = 0;
  const send = (res: http.ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void => {
    bytes += Buffer.byteLength(body);
    res.writeHead(status, { ...headers, 'cache-control': 'no-store' });
    res.end(body);
  };
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(req.url ?? '/', `https://${host || 'invalid'}`);
    const dest = req.headers['sec-fetch-dest'];
    log = [...log, { host, path: url.pathname + url.search, dest: typeof dest === 'string' ? dest : undefined }];
    if (url.pathname === '/redirect') {
      const { status, type, body, location } = redirect(url);
      send(res, status, { 'content-type': type, ...(location !== undefined && { location }) }, body);
      return;
    }
    void page(url.pathname).then((reply) => {
      const { status, type, body } = reply ?? resource(url);
      send(res, status, { 'content-type': type }, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    spki,
    log: () => log,
    clearLog: () => {
      log = [];
      bytes = 0;
    },
    bytes: () => bytes,
    chromiumArgs: [`--host-resolver-rules=MAP * 127.0.0.1:${String(port)}`, `--ignore-certificate-errors-spki-list=${spki}`],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
