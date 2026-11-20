import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { STORE_NAME } from '../../../src/core/brand.js';
import { MIN_CHROME_VERSION, RULESET_SLOTS } from '../../../src/core/limits.js';
import { bannedPermissionsIn, checkBuiltManifest, createManifest, DECLARED_PERMISSIONS, EXTENSION_PAGES_CSP, ICON_FILES, readRuleResources } from '../../../src/core/manifest.js';

describe('createManifest', () => {
  test('takes the extension name from the brand constant', () => {
    // Arrange / Act
    const manifest = createManifest();

    // Assert
    expect(manifest.name).toBe(STORE_NAME);
  });

  test('requires Chrome 145 or later', () => {
    expect(MIN_CHROME_VERSION).toBe('145');
    expect(createManifest().minimum_chrome_version).toBe(MIN_CHROME_VERSION);
  });

  test('sets a strict content security policy for extension pages', () => {
    const manifest = createManifest();

    expect(EXTENSION_PAGES_CSP).toBe("script-src 'self'; object-src 'none'; base-uri 'none'");
    expect(manifest.content_security_policy).toEqual({ extension_pages: EXTENSION_PAGES_CSP });
  });

  test('declares exactly the permissions the worker uses (ADR-007 set, design review 2026-11-14; activeTab with P2-11 and the element hider, contextMenus with P2-21)', () => {
    const manifest = createManifest();

    expect(manifest.permissions).toEqual([...DECLARED_PERMISSIONS]);
    expect(DECLARED_PERMISSIONS).toEqual(['declarativeNetRequest', 'scripting', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'contextMenus']);
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest.incognito).toBe('split');
  });

  test('the dashboard is the options page, in a full tab (P2-34)', () => {
    expect(createManifest().options_ui).toEqual({ page: 'dashboard.html', open_in_tab: true });
  });

  test('declares every permission listed in docs/permissions.md and nothing else', () => {
    const doc = readFileSync(path.resolve(import.meta.dirname, '../../../docs/permissions.md'), 'utf8');
    const listed = [...doc.matchAll(/^\| `([^`]+)` \| declared \|/gm)].map((m) => m[1]);

    expect(listed.sort()).toEqual([...DECLARED_PERMISSIONS, '<all_urls>'].sort());
  });

  test('declares the surrogates and the picker panel web-accessible with use_dynamic_url (P1-30, P2-19, ADR-007)', () => {
    expect(createManifest().web_accessible_resources).toEqual([
      { resources: ['surrogates/*'], matches: ['<all_urls>'], use_dynamic_url: true },
      { resources: ['picker-panel.html'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true },
      { resources: ['blocked.html'], matches: ['<all_urls>'], use_dynamic_url: true },
    ]);
  });

  test('declares the store icon at 16, 32, 48 and 128 px for the package and the toolbar button (P2-50 follow-up 2)', () => {
    const manifest = createManifest();
    expect(manifest.icons).toEqual({ 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' });
    expect(manifest.action.default_icon).toEqual({ 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' });
    expect(ICON_FILES.map((f) => f.source)).toEqual(['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']);
  });

  test('every declared icon has a source PNG in store/icon/', () => {
    for (const file of ICON_FILES) {
      const bytes = readFileSync(path.join(import.meta.dirname, '../../../store/icon', file.source));
      expect(bytes.subarray(1, 4).toString('latin1'), file.source).toBe('PNG');
    }
  });

  test('returns a new object on every call', () => {
    expect(createManifest()).not.toBe(createManifest());
  });
});

describe('checkBuiltManifest (P1-13 build-artefact gate)', () => {
  const good = {
    ...createManifest(),
    manifest_version: 3,
  };

  test('accepts the manifest we build', () => {
    expect(checkBuiltManifest(good)).toEqual([]);
  });

  test.each([
    ['a content_scripts key', { ...good, content_scripts: [] }, /content_scripts/],
    [
      'an -x ruleset enabled',
      { ...good, declarative_net_request: { rule_resources: [{ id: 'ubo-x', enabled: true, path: 'x' }] } },
      /ubo-x/,
    ],
    ['an extra permission', { ...good, permissions: [...DECLARED_PERMISSIONS, 'tabs'] }, /tabs/],
    ['a missing permission', { ...good, permissions: ['storage'] }, /permissions/],
    ['the host-access DNR variant', { ...good, permissions: [...DECLARED_PERMISSIONS, 'declarativeNetRequestWithHostAccess'] }, /WithHostAccess/],
    ['externally_connectable', { ...good, externally_connectable: { matches: ['*://*/*'] } }, /externally_connectable/],
    ['not an object', null, /object/],
    ['a web-accessible page outside the ADR-007 set', { ...good, web_accessible_resources: [{ resources: ['popup.html'], matches: ['<all_urls>'], use_dynamic_url: true }] }, /popup.html/],
    ['web-accessible matches naming one site', { ...good, web_accessible_resources: [{ resources: ['picker-panel.html'], matches: ['https://example.com/*'], use_dynamic_url: true }] }, /matches/],
    ['web-accessible matches empty', { ...good, web_accessible_resources: [{ resources: ['picker-panel.html'], matches: [], use_dynamic_url: true }] }, /matches/],
    ['web-accessible resources without use_dynamic_url', { ...good, web_accessible_resources: [{ resources: ['surrogates/*'], matches: ['<all_urls>'] }] }, /use_dynamic_url/],
    ['web-accessible resources for named extensions', { ...good, web_accessible_resources: [{ resources: ['surrogates/*'], matches: ['<all_urls>'], use_dynamic_url: true, extension_ids: ['x'] }] }, /keys/],
    ['optional permissions', { ...good, optional_permissions: ['tabs'] }, /optional_permissions/],
    ['a weaker CSP', { ...good, content_security_policy: { extension_pages: "script-src 'self'" } }, /content_security_policy/],
    ['incognito spanning', { ...good, incognito: 'spanning' }, /incognito/],
    ['permissions of the wrong type', { ...good, permissions: 'storage' }, /permissions/],
    ['a null rule_resources entry', { ...good, declarative_net_request: { rule_resources: [null] } }, /rule_resources/],
    ['no icons', { ...good, icons: undefined }, /icons/],
    ['a missing 128 px icon', { ...good, icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' } }, /icons/],
    ['no toolbar icon', { ...good, action: {} }, /action/],
  ])('rejects %s', (_name, manifest, message) => {
    expect(checkBuiltManifest(manifest).join('\n')).toMatch(message);
  });
});

describe('declarative_net_request from the compiler fragment (P1-26 follow-up)', () => {
  const slots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${String(i)}${i % 2 ? '-x' : ''}`, enabled: i % 2 === 0, path: `rulesets/s${String(i)}${i % 2 ? '-x' : ''}.json` }));
  const fragment = { declarative_net_request: { rule_resources: slots(RULESET_SLOTS) } };

  test('readRuleResources accepts the compiler fragment and createManifest declares it', () => {
    const resources = readRuleResources(fragment);
    expect(resources).toHaveLength(RULESET_SLOTS);
    const manifest = createManifest(resources);
    expect(manifest.declarative_net_request?.rule_resources).toEqual(fragment.declarative_net_request.rule_resources);
    expect(checkBuiltManifest({ ...manifest, manifest_version: 3 })).toEqual([]);
  });

  test('without a fragment the manifest declares no rulesets', () => {
    expect(createManifest().declarative_net_request).toBeUndefined();
  });

  test.each([
    ['not an object', null, /object/],
    ['an -x ruleset enabled', { declarative_net_request: { rule_resources: [{ id: 'a-x', enabled: true, path: 'rulesets/a-x.json' }] } }, /a-x/],
    ['a path outside rulesets/', { declarative_net_request: { rule_resources: [{ id: 'a', enabled: true, path: '../a.json' }] } }, /path/],
    ['a duplicate id', { declarative_net_request: { rule_resources: [{ id: 'a', enabled: true, path: 'rulesets/a.json' }, { id: 'a', enabled: true, path: 'rulesets/a.json' }] } }, /duplicate/],
    ['an unknown key', { declarative_net_request: { rule_resources: [{ id: 'a', enabled: true, path: 'rulesets/a.json', x: 1 }] } }, /key/],
  ])('readRuleResources refuses %s', (_name, value, message) => {
    expect(() => readRuleResources(value)).toThrow(message);
  });

  test('checkBuiltManifest wants either no rulesets or every slot, each at rulesets/<id>.json', () => {
    const m = { ...createManifest(), manifest_version: 3 };
    expect(checkBuiltManifest({ ...m, declarative_net_request: { rule_resources: slots(3) } }).join('\n')).toMatch(/3 rulesets declared/);
    const moved = slots(RULESET_SLOTS).map((r, i) => (i === 0 ? { ...r, path: 'x.json' } : r));
    expect(checkBuiltManifest({ ...m, declarative_net_request: { rule_resources: moved } }).join('\n')).toMatch(/path/);
  });

  test('checkBuiltManifest takes the store build\'s slot count (P2-29 --drop-pending: 36 - 4 = 32)', () => {
    const m = { ...createManifest(), manifest_version: 3 };
    const store = { ...m, declarative_net_request: { rule_resources: slots(32) } };
    expect(checkBuiltManifest(store).join('\n')).toMatch(/32 rulesets declared, expected 0 or 36/);
    expect(checkBuiltManifest(store, 32)).toEqual([]);
    expect(checkBuiltManifest({ ...m, declarative_net_request: { rule_resources: slots(RULESET_SLOTS) } }, 32).join('\n')).toMatch(/36 rulesets declared, expected 0 or 32/);
  });
});

describe('bannedPermissionsIn (P2-11 build guard)', () => {
  test('the real manifest has none; a test-only copy with the feedback permission is caught', () => {
    expect(bannedPermissionsIn(createManifest([]))).toEqual([]);
    expect(bannedPermissionsIn({ permissions: ['activeTab', 'declarativeNetRequestFeedback'] })).toEqual(['declarativeNetRequestFeedback']);
    expect(bannedPermissionsIn(null)).toEqual([]);
  });
});
