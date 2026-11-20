import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { RulesetId } from '../../../src/core/ids.js';
import { RETRY_ALARM } from '../../../src/background/reconciler.js';
import { createWorker } from '../../../src/background/worker.js';
import { createFakeBrowser } from '../platform/fakes/browser.js';
import { NOW, testCatalog } from '../core/reconcile/fixtures.js';

const SRC = path.resolve(import.meta.dirname, '../../../src');
const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html`, origin: `chrome-extension://${RUNTIME_ID}` };
const CONTENT = { id: RUNTIME_ID, url: 'https://news.test/', origin: 'https://news.test', tab: { id: 3 }, frameId: 0 };

/** architecture notes §2: the only listeners the worker may add (contextMenus / commands come with P2 features). */
const ALLOWED_LISTENERS = [
  'runtime.onInstalled',
  'runtime.onStartup',
  'runtime.onMessage',
  'permissions.onAdded',
  'permissions.onRemoved',
  'alarms.onAlarm',
  'contextMenus.onClicked',
  'commands.onCommand',
];

/** D-80 (P3-17): the one listener outside the worker, in the `user-cosmetic` script's storage port. */
const CONTENT_LISTENER = { name: 'storage.onChanged', file: path.join('platform', 'contentStorage.ts') };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const code = (file: string): string =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const shipped = files(SRC).map((f) => ({ file: path.relative(SRC, f), text: code(f) }));

describe('worker entry (static checks)', () => {
  test('every addListener in shipped code is on the allowed list', () => {
    const found = shipped.flatMap(({ file, text }) => [...text.matchAll(/(\w+)\.(on\w+)\.addListener\s*\(/g)].map((m) => ({ file, name: `${m[1] ?? ''}.${m[2] ?? ''}` })));
    expect(found.length).toBeGreaterThan(0);
    const allowed = ({ file, name }: { file: string; name: string }): boolean =>
      ALLOWED_LISTENERS.includes(name) || (name === CONTENT_LISTENER.name && file === CONTENT_LISTENER.file);
    expect(found.filter((l) => !allowed(l))).toEqual([]);
  });

  test('D-80: storage.onChanged is added in one place, the content-side port the user-cosmetic script calls', () => {
    const owners = shipped.filter(({ text }) => text.includes('storage.onChanged')).map((s) => s.file);
    expect(owners).toEqual([CONTENT_LISTENER.file]);
  });

  test('no webRequest, webNavigation, tabs events, ports or external messaging anywhere', () => {
    const banned = /\b(webRequest|webNavigation|tabs\.on\w+|onConnect\w*|runtime\.connect|onMessageExternal|externally_connectable)\b/;
    // core/manifest.ts names these only to forbid them in the built manifest; the privacy page's
    // permissions table (P2-36) names them only to tell users they are never asked for.
    const naming = new Set([path.join('core', 'manifest.ts'), path.join('features', 'dashboard', 'privacy', 'permissions.ts')]);
    const scanned = shipped.filter(({ file }) => !naming.has(file));
    expect(scanned.filter(({ text }) => banned.test(text)).map((s) => s.file)).toEqual([]);
  });

  test('the entry file only wires: no state, no listener of its own, no chrome', () => {
    const entry = code(path.join(SRC, 'entrypoints/background.ts'));
    expect(entry).not.toMatch(/^\s*(let|var)\s/m);
    expect(entry).not.toMatch(/addListener|chrome\./);
    expect([...entry.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual([
      'wxt/utils/define-background',
      '../background/worker.js',
      '../platform/chromePorts.js',
      '../platform/events.js',
    ]);
  });

  test('no module-level mutable state in worker code (ADR-012 item 7)', () => {
    const worker = shipped.filter(({ file }) => /^(background|platform|entrypoints)\//.test(file));
    expect(worker.filter(({ text }) => /^(let|var)\s/m.test(text)).map((s) => s.file)).toEqual([]);
  });
});

describe('createWorker', () => {
  const rulesets = ['ubo', 'ubo-x', 'easyprivacy', 'cookies', 'cookies-x', 'popups'].map((id) => ({
    id: id as RulesetId,
    enabled: !id.endsWith('-x'),
    regexCount: 1,
  }));

  test.each([
    ['onInstalled', (w: ReturnType<typeof createWorker>) => { w.handlers.installed('install'); }],
    ['onStartup', (w: ReturnType<typeof createWorker>) => { w.handlers.startup(); }],
    ['permission change', (w: ReturnType<typeof createWorker>) => { w.handlers.permissionsChanged(); }],
    ['pause alarm', (w: ReturnType<typeof createWorker>) => { w.handlers.alarm('pause-expiry'); }],
  ])('%s reconciles', async (_name, trigger) => {
    const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
    const worker = createWorker(b.ports, RUNTIME_ID);
    trigger(worker);
    await worker.reconciler.request('settle');
    expect(await b.ports.dnr.getEnabledRulesets()).toContain('ubo-x');
  });

  test('the retry alarm (D-83) runs one reconcile of its own', async () => {
    const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
    const worker = createWorker(b.ports, RUNTIME_ID);
    worker.handlers.alarm(RETRY_ALARM);
    await worker.reconciler.request('settle');
    expect(b.calls().filter((c) => c === 'catalog.read')).toHaveLength(2);
    expect(await b.ports.dnr.getEnabledRulesets()).toContain('ubo-x');
  });

  test('an unrelated alarm does nothing', () => {
    const b = createFakeBrowser({ rulesets, catalog: testCatalog() });
    createWorker(b.ports, RUNTIME_ID).handlers.alarm('other');
    expect(b.calls()).toEqual([]);
  });

  test('messages: c/reconcile from a page works; content scripts are refused; other commands not yet', async () => {
    const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
    const { handlers } = createWorker(b.ports, RUNTIME_ID);
    const msg = (type: string, payload: unknown = {}): unknown => ({ v: 1, type, id: 'a1', payload });

    expect(await handlers.message(msg('c/reconcile'), POPUP)).toEqual({ ok: true, data: { status: 'applied', skippedPacks: [] } });
    expect(await handlers.message(msg('c/reconcile'), CONTENT)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    // c/startPicker exists since P2-21; tab 1 is not an active tab here, so it is refused.
    expect(await handlers.message(msg('c/startPicker', { tabId: 1, mode: 'zap' }), POPUP)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    // c/importBackup exists since P2-37, from the dashboard only.
    expect(await handlers.message(msg('c/importBackup', { json: '{}', expect: 'ab'.repeat(32) }), POPUP)).toMatchObject({ ok: false, error: { code: 'forbidden-sender' } });
    expect(await handlers.message('junk', POPUP)).toMatchObject({ ok: false, error: { code: 'invalid-envelope' } });
    b.failNext('catalog.read');
    expect(await handlers.message(msg('c/reconcile'), POPUP)).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  test('resume reconciles only after an interrupted run', async () => {
    const b = createFakeBrowser({ rulesets, catalog: testCatalog(), now: () => NOW });
    await createWorker(b.ports, RUNTIME_ID).resume();
    expect(b.calls()).toEqual(['session.get']);
    await b.ports.session.set('reconcile.pending', true);
    await createWorker(b.ports, RUNTIME_ID).resume();
    expect(await b.ports.dnr.getEnabledRulesets()).toContain('ubo-x');
  });
});
