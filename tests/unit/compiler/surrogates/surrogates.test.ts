import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ConvertedRule } from '../../../../compiler/convert/convert.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { htmlSurrogateProblems, redirectProblems, surrogateFiles, surrogatesUsed } from '../../../../compiler/surrogates/files.js';
import { redirectName, resolveRedirects, resourceIndex } from '../../../../compiler/surrogates/redirects.js';
import { loadVendorLock, vendorReader } from '../../../../compiler/vendor/node-ports.js';
import { readRedirectResources } from '../../../../compiler/vendor/resources.js';
import { VENDOR_PRESENT } from '../content/helpers.js';

const index = resourceIndex([{ name: 'noop.js', aliases: ['noopjs', 'abp-resource:blank-js'] }, { name: 'noop.html', aliases: ['noopframe'] }]);
const rule = (filter: string, action: DnrRule['action'], types?: string[]): ConvertedRule => ({
  rule: { id: 1, priority: 1101, action, condition: { urlFilter: '||a.example^', ...(types && { resourceTypes: types as never }) } },
  sources: [{ text: filter, source: { list: 'l', line: 1, text: filter }, fixes: [] }],
});
const toResource = { type: 'redirect', redirect: { extensionPath: '/surrogates/whatever.js' } } as const;
const bytes = (s: string) => new TextEncoder().encode(s);

describe('redirect targets → packaged surrogates (P1-30)', () => {
  test('names: priority suffixes (also negative) are stripped, ABP rewrite= is read', () => {
    expect(redirectName('||a^$script,redirect=noopjs:5')).toBe('noopjs');
    expect(redirectName('||a^$redirect=nooptext:-1,domain=b.com')).toBe('nooptext');
    expect(redirectName('||a^$rewrite=abp-resource:blank-js')).toBe('abp-resource:blank-js');
  });

  test('aliases map to uBO files; none becomes a block at the same priority; unknown, external and HTML on other types are dropped and logged', () => {
    const r = resolveRedirects([
      rule('||a^$script,redirect=noopjs', toResource, ['script']),
      rule('||a^$rewrite=abp-resource:blank-js', toResource),
      rule('||a^$script,redirect=none:5', toResource, ['script']),
      rule('||a^$redirect=nope', toResource),
      rule('||a^$redirect=x', { type: 'redirect', redirect: { url: 'https://evil.example/x.js' } }),
      rule('||a^$subdocument,redirect=noopframe', toResource, ['sub_frame']),
      rule('||a^$redirect=noopframe', toResource, ['sub_frame', 'script']),
      rule('||a^$removeparam=x', { type: 'redirect', redirect: { transform: { query: '' } } }),
    ], index);
    expect(r.rules.map((x) => x.rule.action.redirect?.extensionPath ?? x.rule.action.type)).toEqual(['/surrogates/noop.js', '/surrogates/noop.js', 'block', '/surrogates/noop.html', 'redirect']);
    expect(r.rules[2]?.rule.priority).toBe(1101);
    expect(r.none).toBe(1);
    expect(r.log.map((l) => l.reason)).toEqual(['redirect-unknown', 'redirect-external', 'redirect-html-type']);
  });

  test('files: exactly the used surrogates ship; every redirect target must be packaged', () => {
    const rules: DnrRule[] = [{ id: 1, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } }, condition: {} }];
    expect(surrogatesUsed(rules)).toEqual(['noop.js']);
    const packaged = surrogateFiles(['noop.js'], new Map([['noop.js', bytes(';')], ['other.js', bytes(';')]]));
    expect([...packaged.keys()]).toEqual(['surrogates/noop.js']);
    expect(redirectProblems(rules, packaged)).toEqual([]);
    expect(redirectProblems(rules, new Map())).toEqual(['redirect target /surrogates/noop.js is not packaged']);
    expect(() => surrogateFiles(['gone.js'], new Map())).toThrow(/gone.js/);
  });

  test('HTML surrogates: allowlist, pinned hash and an independent content gate (D-24)', () => {
    const poisoned = ['<html><script>alert(1)</script></html>', '<body onload="x()">', '<meta http-equiv="refresh" content="0;url=https://x">', '<a href="javascript:x">'];
    for (const p of poisoned) expect(htmlSurrogateProblems('noop.html', bytes(p)).join()).toMatch(/contains/);
    expect(htmlSurrogateProblems('click2load.html', bytes('<html></html>')).join()).toMatch(/allowlist/);
    expect(() => surrogateFiles(['noop.html'], new Map([['noop.html', bytes('<html></html>')]]))).toThrow(/pinned/);
  });
});

describe.skipIf(!VENDOR_PRESENT)('the vendored resources (P1-30)', () => {
  test('every redirect name of the pinned default lists maps to a uBO file (none = no file by design); noop.html passes its gate', async () => {
    const lock = await loadVendorLock();
    const read = vendorReader(lock);
    const idx = resourceIndex(readRedirectResources((await read('src/js/redirect-resources.js')).toString('utf8')));
    const golden = JSON.parse(readFileSync(new URL('../../../golden/compiler/redirect-names.json', import.meta.url), 'utf8')) as { names: Record<string, string | null> };
    const got = Object.fromEntries(Object.keys(golden.names).map((n) => [n, n === 'none' ? null : idx.get(n) ?? 'UNKNOWN']));
    expect(got).toEqual(golden.names);
    for (const file of Object.values(got)) if (file !== null) expect(Object.hasOwn(lock.files, `src/web_accessible_resources/${file}`)).toBe(true);
    expect(htmlSurrogateProblems('noop.html', await read('src/web_accessible_resources/noop.html'))).toEqual([]);
  });
});
