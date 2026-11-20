import { describe, expect, test, vi } from 'vitest';
import { LIVE_COALESCE_MS, runUserCosmetic, type UserCosmeticEnv } from '../../../../src/content/user-cosmetic/apply.js';

/** A constructed sheet as far as the live path uses it: its whole text replaced at once. */
class FakeSheet {
  text = '';
  replaceSync(text: string): void { this.text = text; }
}

type Changed = (keys: readonly string[], area: string) => void;

/**
 * D-80 (P3-17 item A): the frame's own `uf:` keys changing in `storage.local` re-read the mirror through
 * `readMirrorEntry` → `hideRule` and replace the one adopted sheet; foreign keys cost nothing.
 */
function live(initial: Readonly<Record<string, unknown>>) {
  let store: Readonly<Record<string, unknown>> = initial;
  const doc: { adoptedStyleSheets?: unknown[] } = { adoptedStyleSheets: [] };
  const read = vi.fn((keys: readonly string[]) => Promise.resolve(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))));
  const listeners: Changed[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const sheets: FakeSheet[] = [];
  const e: UserCosmeticEnv = {
    document: doc,
    location: { hostname: 'a.news.example.com', protocol: 'https:' },
    read,
    newSheet: () => { const s = new FakeSheet(); sheets.push(s); return s; },
    onChanged: (listener) => { listeners.push(listener); },
    setTimer: (run, ms) => { timers.push({ run, ms }); },
  };
  const fire = (keys: readonly string[], area = 'local'): void => { for (const l of listeners) l(keys, area); };
  const flush = async (): Promise<void> => {
    for (const t of timers.splice(0)) t.run();
    await new Promise((r) => { setTimeout(r, 0); });
  };
  const set = (next: Readonly<Record<string, unknown>>): void => { store = next; };
  return { e, doc, read, listeners, timers, sheets, fire, flush, set };
}

const OWN = 'uf:news.example.com';
const rulesOf = (sheet: FakeSheet | undefined): string => sheet?.text ?? '';

describe('user-cosmetic live apply (D-80)', () => {
  test('one sheet, adopted once; an own key changing rebuilds it with replaceSync', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    expect(await runUserCosmetic(r.e)).toBe(1);
    expect(r.doc.adoptedStyleSheets).toHaveLength(1);
    expect(rulesOf(r.sheets[0])).toBe('.ad{display:none!important}');
    r.set({ [OWN]: { v: 1, s: ['.ad', '#top'] } });
    r.fire([OWN]);
    expect(r.timers.map((t) => t.ms)).toEqual([LIVE_COALESCE_MS]);
    await r.flush();
    expect(r.read).toHaveBeenCalledTimes(2);
    expect(r.sheets).toHaveLength(1);
    expect(r.doc.adoptedStyleSheets).toHaveLength(1);
    expect(rulesOf(r.sheets[0])).toBe('#top{display:none!important}\n.ad{display:none!important}');
  });

  test('a foreign uf: key, another key or another area: no read, no timer', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    await runUserCosmetic(r.e);
    r.fire(['uf:other.example']);
    r.fire(['uf:a.news.example.com.evil']);
    r.fire(['e2e.boots', 'reconcile.last']);
    r.fire([OWN], 'session');
    expect(r.timers).toEqual([]);
    expect(r.read).toHaveBeenCalledTimes(1);
  });

  test('a malformed or unsafe entry empties the sheet (the sheet stays adopted)', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    await runUserCosmetic(r.e);
    r.set({ [OWN]: { v: 1, s: ['body{background:red}', '.x{color:red} body'] } });
    r.fire([OWN]);
    await r.flush();
    expect(rulesOf(r.sheets[0])).toBe('');
    r.set({ [OWN]: 'body' });
    r.fire([OWN]);
    await r.flush();
    expect(rulesOf(r.sheets[0])).toBe('');
    expect(r.doc.adoptedStyleSheets).toHaveLength(1);
  });

  test('a removal (key gone) clears the sheet', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    await runUserCosmetic(r.e);
    r.set({});
    r.fire([OWN]);
    await r.flush();
    expect(rulesOf(r.sheets[0])).toBe('');
  });

  test('a burst of 20 events reads at most twice (trailing coalesce, ≤ 1 rebuild per 250 ms)', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    await runUserCosmetic(r.e);
    r.read.mockClear();
    for (let i = 0; i < 20; i += 1) {
      r.set({ [OWN]: { v: 1, s: [`.ad${String(i)}`] } });
      r.fire([OWN]);
    }
    expect(r.timers).toHaveLength(1);
    await r.flush();
    expect(r.read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(rulesOf(r.sheets[0])).toBe('.ad19{display:none!important}');
  });

  test('a host with no rules at start adopts its sheet on the first rule that arrives', async () => {
    const r = live({});
    expect(await runUserCosmetic(r.e)).toBe(0);
    expect(r.doc.adoptedStyleSheets).toEqual([]);
    r.set({ [OWN]: { v: 1, s: ['.late'] } });
    r.fire([OWN]);
    await r.flush();
    expect(r.doc.adoptedStyleSheets).toHaveLength(1);
    expect(rulesOf(r.sheets[0])).toBe('.late{display:none!important}');
  });

  test('a stale read never overwrites a newer one', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.old'] } });
    let release: () => void = () => undefined;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const readOnce = r.e.read;
    let calls = 0;
    const e = { ...r.e, read: async (keys: readonly string[]) => { calls += 1; const out = await readOnce(keys); if (calls === 1) await first; return out; } };
    const started = runUserCosmetic(e);
    r.set({ [OWN]: { v: 1, s: ['.new'] } });
    r.fire([OWN]);
    await r.flush();
    release();
    await started;
    expect(rulesOf(r.sheets[0])).toBe('.new{display:none!important}');
  });

  test('without onChanged (a page that cannot listen) it applies once, as before', async () => {
    const r = live({ [OWN]: { v: 1, s: ['.ad'] } });
    const once: UserCosmeticEnv = { document: r.e.document, location: r.e.location, read: r.e.read, newSheet: r.e.newSheet };
    expect(await runUserCosmetic(once)).toBe(1);
    expect(r.listeners).toEqual([]);
  });
});
