import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { parseHostname } from '../../../src/core/hostname/validate.js';
import { FIXTURES_DIR, loadFixtures } from '../../fixtures/manifest.js';
import { GUARD_ALONE, POPUP_FAMILIES, loadPopupFixtures, skippedWhole, type PopupRow } from '../../fixtures/popupManifest.js';
import { compilePopups } from '../../helpers/compilePopups.js';

/** P2-61: the pop-up families of fixtures.json are well-formed and match pop-up notes §14–15. */
const rows = loadPopupFixtures();
const ofFamily = (family: string): readonly PopupRow[] => rows.filter((r) => r.family === family);
const techniques = (family: string): readonly string[] => ofFamily(family).map((r) => r.technique);
const hostOf = (url: string): string => new URL(url).hostname;

describe('pop-up fixture rows', () => {
  test('ids are unique, start with their family and do not collide with the other fixtures', () => {
    const ids = [...rows.map((r) => r.id), ...loadFixtures().map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter((r) => !r.id.startsWith(`${r.family}/`)).map((r) => r.id)).toEqual([]);
  });

  test.each(rows.map((r) => [r.id, r] as const))('%s: page file exists and names the fixture', (_id, row) => {
    const file = path.join(FIXTURES_DIR, row.file);
    expect(existsSync(file)).toBe(true);
    expect(row.file.startsWith(`${row.family}/`)).toBe(true);
    expect(new URL(row.page).pathname).toBe(`/${row.file}`);
    expect(readFileSync(file, 'utf8')).toMatch(new RegExp(`<!-- fixture: ${row.id} · `));
  });

  test.each(rows.map((r) => [r.id, r] as const))('%s: every address is on a valid hostname', (_id, row) => {
    const urls = [row.page, ...(row.target?.startsWith('https://') === true ? [row.target] : []), ...('navigate' in row.act ? [row.act.navigate] : [])];
    expect(urls.filter((u) => parseHostname(hostOf(u)) !== hostOf(u))).toEqual([]);
  });

  test('every HTML file in a pop-up family directory is a row\'s page or used by one', () => {
    const referenced = new Set(rows.flatMap((r) => [r.file, ...(r.uses ?? [])]));
    const helpers = /^(?:popups\/(?:next|real)|popups-allow\/(?:provider-authorize|pay-button|popout|flow-frame|onetap))\.html$/;
    const onDisk = POPUP_FAMILIES.flatMap((f) => readdirSync(path.join(FIXTURES_DIR, f)).filter((n) => n.endsWith('.html')).map((n) => `${f}/${n}`));
    expect(onDisk.filter((file) => !referenced.has(file) && !helpers.test(file))).toEqual([]);
    expect([...referenced].filter((file) => !onDisk.includes(file))).toEqual([]);
  });
});

describe('families against pop-up notes §14–15', () => {
  test('popups/ holds the 14 guard-alone pages, marked as such, and the J19 hostile page', () => {
    expect(ofFamily('popups').filter((r) => r.guardAlone === true).map((r) => r.technique)).toEqual([...GUARD_ALONE]);
    expect(techniques('popups')).toContain('H1');
  });

  test('P8b is the one allowed miss, in both modes', () => {
    const misses = rows.filter((r) => r.expect.smart === 'miss' || r.expect.strict === 'miss');
    expect(misses.map((r) => [r.technique, r.expect.smart, r.expect.strict])).toEqual([['P8b', 'miss', 'miss']]);
  });

  test('P9 (frame overlay) and P10 (scripted form) are destination fixtures, not guard fixtures', () => {
    expect(techniques('popup-destinations')).toEqual(expect.arrayContaining(['P9', 'P10']));
    expect(techniques('popups')).not.toEqual(expect.arrayContaining(['P9']));
    expect(techniques('popups')).not.toEqual(expect.arrayContaining(['P10']));
  });

  test('popups-allow/ holds A1–A13 and the S-21 flows S1–S10, plus nowoif in both orders', () => {
    const want = [...Array.from({ length: 13 }, (_, i) => `A${String(i + 1)}`), ...Array.from({ length: 10 }, (_, i) => `S${String(i + 1)}`), 'A14', 'A15'];
    expect(techniques('popups-allow')).toEqual(expect.arrayContaining(want));
  });

  test('without the guard every must-block page opens its window and every must-pass page works (the fixtures bite)', () => {
    // A `popups/` row with its own filters is a destination row (D14, D-55a): the lists stop it in every mode.
    const bites = [...ofFamily('popups').filter((r) => r.filters === undefined), ...ofFamily('popups-allow').filter((r) => r.filters === undefined)];
    expect(bites.filter((r) => r.expect.guardOff !== 'opened').map((r) => r.id)).toEqual([]);
  });

  test('popup-destinations/ covers window.open, link, 302 chain, typed, same-tab, site access off and the exception', () => {
    expect(techniques('popup-destinations')).toEqual(expect.arrayContaining(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']));
    expect(ofFamily('popup-destinations').find((r) => r.setup?.access === 'none')?.expect.guardOff).toBe('blocked');
  });

  test('blocked-page presentation lives in its own rows, all running since the shim (P2-58)', () => {
    const presentation = rows.filter((r) => r.blockedPage !== undefined);
    expect(presentation.map((r) => r.blockedPage).sort()).toEqual(['close-tab', 'close-tab', 'closed', 'go-back', 'proceed-once']);
    // P2-55 shipped blocked.html and Proceed once, P2-57 the sentinel, P2-58 the shim (d9's link check).
    expect(presentation.filter((r) => r.pending === undefined).map((r) => r.technique)).toEqual(['D8', 'D9', 'D10', 'D11', 'D12']);
  });

  test('notify/ covers a prompt on load and one after a click, pack on and off', () => {
    expect(ofFamily('notify').map((r) => [r.technique, r.expect.packOn, r.expect.packOff])).toEqual([
      ['N1', 'suppressed', 'prompted'],
      ['N2', 'prompted', 'prompted'],
    ]);
  });

  test('a row skipped whole is a pending destination or notify row; guard rows keep their baseline', () => {
    expect(rows.filter(skippedWhole).every((r) => r.family === 'popup-destinations' || r.family === 'notify')).toBe(true);
    expect(ofFamily('popups').some(skippedWhole)).toBe(false);
  });
});

describe('the lifted destination row (D-55 / D-55a)', () => {
  test('a popups/ row whose host is both a $popup destination and document-blocked, stopped in every mode', async () => {
    const lifted = ofFamily('popups').filter((r) => r.filters !== undefined);
    expect(lifted.map((r) => [r.technique, r.expect.guardOff, r.expect.smart, r.expect.strict])).toEqual([['D14', 'blocked', 'blocked', 'blocked']]);
    const row = lifted[0];
    const host = hostOf(row?.target ?? '');
    expect(row?.filters).toEqual([`||${host}^$popup`, `||${host}^$document`]);
    expect((await compilePopups(row?.filters ?? [])).destinations).toEqual([host]);
  });
});

describe('the L2 rows compile into the popups ruleset of the test build', () => {
  test('every listed target is a popups destination; the exception host gets an allow rule', async () => {
    const dest = ofFamily('popup-destinations');
    const compiled = await compilePopups([...new Set(dest.flatMap((r) => r.filters ?? []))]);
    const blocked = dest.filter((r) => r.expect.guardOff === 'blocked').map((r) => hostOf(r.target ?? ''));
    expect([...new Set(blocked)]).toEqual(['popads.example']);
    expect(compiled.destinations).toEqual(['okpop.example', 'popads.example']);
    expect(compiled.rules.some((r) => r.action.type === 'allow' && r.condition.urlFilter === '||okpop.example^')).toBe(true);
  });

  test('no target of a guard row is named by any filter, so only the guard can block it', () => {
    const filters = [...loadFixtures().flatMap((f) => f.filters), ...rows.flatMap((r) => r.filters ?? [])].join('\n');
    const guardRows = [...ofFamily('popups'), ...ofFamily('popups-allow')].filter((r) => !(r.family === 'popups' && r.filters !== undefined));
    const guardTargets = guardRows.flatMap((r) => (r.target?.startsWith('https://') === true ? [hostOf(r.target)] : []));
    expect([...new Set(guardTargets)].filter((h) => filters.includes(h))).toEqual([]);
  });
});
