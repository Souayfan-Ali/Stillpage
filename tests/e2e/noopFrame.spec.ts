/**
 * D-24 condition 5 (P1-30 follow-up): in the real build, a `sub_frame` request redirected by
 * `redirect=noopframe` lands on the packaged, inert `surrogates/noop.html` (dynamic URL), the fixture
 * server never sees the frame's request, and no script runs in the landed document. The rule is the
 * pinned lists' own (`||a-ads.com^$subdocument,redirect=noopframe,domain=dogefaucet.com`, in `ubo-x`).
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startFixtureServer } from '../fixtures/server/server.js';
import { closeAll, expectNoSurvivors, extensionWorker, newProfile } from './helpers/browser.js';
import { launchCorpus, reconciledSince } from './helpers/corpus.js';
import { BUILD_DIR, TEMP_PREFIX } from './helpers/fixtureExtension.js';

test('a frame redirected to noopframe lands on the packaged inert noop.html (D-24)', async () => {
  const server = await startFixtureServer();
  const root = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dir = path.join(root, 'ext');
  await cp(BUILD_DIR, dir, { recursive: true });
  const since = Date.now();
  const context = await launchCorpus(await newProfile(), dir, server.chromiumArgs);
  try {
    const worker = await extensionWorker(context);
    await reconciledSince(worker, since, /^installed:/);
    const enabled = await worker.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
    expect(enabled).toContain('ubo-x');
    server.clearLog();
    const page = await context.newPage();
    await page.goto('https://dogefaucet.com/redirect/noop-frame.html', { waitUntil: 'load' });
    await expect.poll(() => page.frames().map((f) => f.url()).find((u) => u.startsWith('chrome-extension://')) ?? '').toMatch(/^chrome-extension:\/\/[a-z0-9-]+\/surrogates\/noop\.html$/);
    const frame = page.frames().find((f) => f.url().endsWith('/surrogates/noop.html'));
    expect(await frame?.evaluate(() => ({ scripts: document.scripts.length, body: document.body.innerHTML.trim() }))).toEqual({ scripts: 0, body: '' });
    expect(server.log().filter((r) => r.host === 'a-ads.com')).toEqual([]);
  } finally {
    await context.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
    await closeAll();
    await expectNoSurvivors();
  }
});
