/**
 * P2-57 in real Chromium: `popup-sentinel.js` registered by the test (top-level documents, ISOLATED,
 * `document_start`) on a site where the default mode `off` registers no guard, so the script is tested alone.
 * Trusted link clicks: an explicit link opens in Smart (G8) and is blocked in Strict; an href swapped
 * at pointerdown is blocked (G9/G10); a click anywhere that fires a script click on a hidden link is
 * blocked (G11); the link check answers `true` after a real click; a tab-under is cancelled; the notice
 * shows; the sentinel answers our extension only and stores nothing.
 */
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { test } from './fixtures.js';

const ORIGIN = 'https://guard.example';
const PAGE = `<!doctype html><title>guard</title><style>body{margin:0;height:900px} a{display:inline-block;margin:20px;padding:10px;background:#eee}</style>
<a id="explicit" target="_blank" href="https://other.example/page">explicit</a>
<a id="swap" target="_blank" href="https://news.example/story">swap</a>
<a id="hidden" target="_blank" href="https://ads.example/x" style="display:none">h</a>
<a id="tab" target="_blank" href="https://other.example/next">tab-under</a>
<p id="empty" style="margin-top:300px">click anywhere text</p>
<script>
  document.getElementById('swap').addEventListener('pointerdown', (e) => { e.currentTarget.href = 'https://ads.example/landing'; });
  document.getElementById('empty').addEventListener('click', () => { document.getElementById('hidden').click(); });
  document.getElementById('tab').addEventListener('click', () => { setTimeout(() => { location.href = 'https://tabunder.example/'; }, 200); });
</script>`;

// The install reconcile (≈ 10 s on a loaded machine) runs first, and each click waits up to 4 s for a tab.
test.beforeEach(() => { test.setTimeout(120_000); });

async function register(sw: Worker, strict: boolean): Promise<void> {
  // The install reconcile removes registrations it does not know: register only after it finished.
  await expect.poll(() => sw.evaluate(async () => (await chrome.storage.session.get('reconcile.last'))['reconcile.last'] !== undefined), { timeout: 60_000 }).toBe(true);
  await sw.evaluate(async ({ origin, strictToo }) => {
    const base = { matches: [`${origin}/*`], runAt: 'document_start' as const, allFrames: false, world: 'ISOLATED' as const, persistAcrossSessions: false };
    const scripts = [...(strictToo ? [{ id: 'e2e-strict', js: ['popup-strict.js'], ...base }] : []), { id: 'e2e-sentinel', js: ['popup-sentinel.js'], ...base }];
    await chrome.scripting.registerContentScripts(scripts);
  }, { origin: ORIGIN, strictToo: strict });
}

async function open(context: BrowserContext, sw: Worker, strict = false): Promise<Page> {
  await register(sw, strict);
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ body: PAGE, contentType: 'text/html' }));
  await context.route('https://*.example/**', (route) => (route.request().url().startsWith(ORIGIN) ? route.fallback() : route.fulfill({ body: '<title>x</title>', contentType: 'text/html' })));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

/** Clicks `selector` for real and reports whether a new tab opened within the settle time. */
async function opens(context: BrowserContext, page: Page, selector: string): Promise<boolean> {
  const popup = context.waitForEvent('page', { timeout: 4_000 }).then((p) => { void p.close(); return true; }, () => false);
  await page.click(selector);
  return popup;
}

const ask = (sw: Worker, message: object): Promise<unknown> => sw.evaluate(async ({ origin, m }) => {
  const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
  return chrome.tabs.sendMessage<object, unknown>(tab?.id ?? -1, m, { frameId: 0 });
}, { origin: ORIGIN, m: message });

test('Smart: an explicit link opens (G8); a swapped href (G9/G10) and a click-anywhere (G11) are blocked with a notice; the log lists them', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker);
  expect(await opens(context, page, '#explicit')).toBe(true);
  expect(await opens(context, page, '#swap')).toBe(false);
  expect(await opens(context, page, '#empty')).toBe(false);
  await expect.poll(() => page.evaluate(() => document.documentElement.lastElementChild?.tagName)).toBe('DIV');
  expect(await ask(serviceWorker, { type: 'x/popupLog' })).toMatchObject({ hosts: ['ads.example'], blocked: 2 });
});

test('Strict (popup-strict flag): the explicit link is blocked too', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker, true);
  expect(await opens(context, page, '#explicit')).toBe(false);
  expect(await ask(serviceWorker, { type: 'x/popupLog' })).toMatchObject({ hosts: ['other.example'], blocked: 1 });
});

test('the link check answers true only after a real click on a visible link to that host', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker);
  // No event yet: the sentinel has not armed its listener (guard cost), which blocked.html reads as `false`.
  await expect(ask(serviceWorker, { type: 'x/linkClickCheck', host: 'other.example' })).rejects.toThrow(/Receiving end does not exist/);
  await page.mouse.click(2, 2);
  expect(await ask(serviceWorker, { type: 'x/linkClickCheck', host: 'other.example' })).toBe(false);
  await opens(context, page, '#explicit');
  expect(await ask(serviceWorker, { type: 'x/linkClickCheck', host: 'other.example' })).toBe(true);
  expect(await ask(serviceWorker, { type: 'x/linkClickCheck', host: 'ads.example' })).toBe(false);
});

test('tab-under: the opener’s script navigation to another site right after the new tab is cancelled', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker);
  expect(await opens(context, page, '#tab')).toBe(true);
  await page.waitForTimeout(800);
  expect(page.url()).toBe(`${ORIGIN}/`);
  expect(await ask(serviceWorker, { type: 'x/popupLog' })).toMatchObject({ hosts: ['tabunder.example'], blocked: 1, codes: ['TU'] });
});

test('popupClosed from blocked.html draws the notice; nothing is stored; the page cannot query the sentinel', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker);
  await page.mouse.click(2, 2); // a pop-up comes after a gesture or a judged open, which arms the listener
  expect(await ask(serviceWorker, { type: 'x/popupClosed', host: 'pop.example' })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.lastElementChild?.tagName)).toBe('DIV');
  expect(await serviceWorker.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  expect(await page.evaluate(() => typeof (window as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime?.sendMessage)).not.toBe('function');
});

test('a page that restyles the notice (invisible, scaled over the page) cannot make it act (review MEDIUM-1)', async ({ context, serviceWorker }) => {
  const page = await open(context, serviceWorker, true);
  expect(await opens(context, page, '#explicit')).toBe(false);
  await page.evaluate(() => {
    const host = document.documentElement.lastElementChild as HTMLElement;
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;opacity:0;z-index:2147483647;transform:scale(40)';
  });
  await page.waitForTimeout(800);
  await page.mouse.click(400, 300);
  // "Allow on this page" was not set: the explicit link is still blocked.
  expect(await opens(context, page, '#explicit')).toBe(false);
});

