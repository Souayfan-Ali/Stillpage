import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { emitPackContent } from '../../../../compiler/content/shards.js';
import { readShardFile } from '../../../../compiler/verify/content.js';
import { isolatedDataPath, PROCEDURAL_ENGINE, RUNTIME_SCRIPTS, scriptletCodePath } from '../../../../src/core/content/files.js';
import { lookupHost } from '../../../../src/core/content/shard-data.js';
import { parentDomains } from '../../../../src/core/hostname/walk.js';
import { SHARD_TARGET_MEAN_BYTES, SHARD_TARGET_WORST_BYTES } from '../../../../src/core/limits.js';
import type { Hostname } from '../../../../src/core/ids.js';
import type { Fact } from '../../../../compiler/content/facts.js';
import { fact } from './helpers.js';

const fnIndex = (_w: string, name: string): number => ['a', 'b', 'c'].indexOf(name);
const emit = (iso: readonly Fact[], main: readonly Fact[] = []) => emitPackContent({ pack: 'ads', isolated: iso, main, fnIndex });

describe('shard files and registrations (P1-27)', () => {
  test('small data: one shard (D-23), one *://*.host/* pattern per listed host, sub-hosts under a listed parent not listed', () => {
    const out = emit([fact('example.com', 'h', '.ad'), fact('www.example.com', 'h', '.b'), fact('other.org', 'h', '.c')]);
    expect(out.files.size).toBe(1);
    const hosts = out.registrations.flatMap((r) => r.hosts).sort();
    expect(hosts).toEqual(['example.com', 'other.org']);
    expect(out.patterns).toBe(2);
    const reg = out.registrations.find((r) => r.hosts.includes('example.com' as Hostname));
    expect(reg).toMatchObject({ id: 'iso:ads:0', world: 'ISOLATED', js: [isolatedDataPath('ads', 0), RUNTIME_SCRIPTS.cosmetic] });
  });

  test('the procedural engine and the ISOLATED scriptlet code are listed only for hosts that need them', () => {
    const out = emit([fact('plain.com', 'h', '.a'), fact('proc.com', 'p', '{"selector":"a"}'), fact('both.net', 'p', '{"selector":"b"}'), fact('both.net', 'j', '["a"]')]);
    const byHost = (h: string) => out.registrations.find((r) => r.hosts.includes(h as Hostname));
    expect(byHost('plain.com')?.js).not.toContain(PROCEDURAL_ENGINE);
    expect(byHost('proc.com')?.js).toContain(PROCEDURAL_ENGINE);
    const js = byHost('proc.com')?.js ?? [];
    expect(js[js.indexOf(PROCEDURAL_ENGINE) + 1]).toBe(RUNTIME_SCRIPTS.procedural);
    expect(byHost('plain.com')?.js).not.toContain(RUNTIME_SCRIPTS.procedural);
    expect(byHost('proc.com')?.id).toMatch(/:f$/);
    expect(byHost('both.net')?.js).toEqual(expect.arrayContaining([PROCEDURAL_ENGINE, scriptletCodePath('ads', 'ISOLATED')]));
  });

  test('P2-47 (D-41): hosts that need code and plain hosts are sharded apart; the code is listed only in the code lane', () => {
    const out = emit([fact('plain.com', 'h', '.a'), fact('proc.com', 'p', '{"selector":"a"}'), fact('js.org', 'j', '["a"]'), fact('both.net', 'p', '{"selector":"b"}'), fact('both.net', 'j', '["a"]')]);
    const iso = out.registrations.filter((r) => r.world === 'ISOLATED');
    expect(iso.map((r) => r.id).sort()).toEqual(['iso:ads:0', 'iso:ads:1:f']);
    expect(iso.find((r) => r.id === 'iso:ads:0')?.js).toEqual([isolatedDataPath('ads', 0), RUNTIME_SCRIPTS.cosmetic]);
    const full = iso.find((r) => r.id.endsWith(':f'));
    expect(full?.hosts).toEqual(['both.net', 'js.org', 'proc.com']);
    expect(full?.js).toEqual(expect.arrayContaining([PROCEDURAL_ENGINE, RUNTIME_SCRIPTS.procedural, scriptletCodePath('ads', 'ISOLATED'), RUNTIME_SCRIPTS.cosmetic]));
  });

  test('P2-47 (D-41): MAIN shards are sized by the worst shard only (each one repeats the code file)', () => {
    const facts = Array.from({ length: 3000 }, (_, i) => fact(`site${String(i)}.com`, 'j', `["b","${'y'.repeat(20)}-${String(i)}"]`));
    const out = emit([], facts);
    const main = out.registrations.filter((r) => r.world === 'MAIN');
    const sizes = [...out.files].filter(([p]) => p.includes('/main/') && !p.endsWith('common.js')).map(([, t]) => Buffer.byteLength(t));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(SHARD_TARGET_WORST_BYTES);
    // The ISOLATED rule (mean ≤ 32 kB) would need twice as many.
    expect(main.length).toBeLessThanOrEqual(Math.ceil(sizes.reduce((a, b) => a + b, 0) / SHARD_TARGET_WORST_BYTES) * 2);
    expect(main.length).toBeLessThan(Math.ceil(sizes.reduce((a, b) => a + b, 0) / SHARD_TARGET_MEAN_BYTES));
  });

  test('MAIN registrations carry the data shard, then the code, and come first', () => {
    const out = emit([fact('a.com', 'h', '.x')], [fact('a.com', 'j', '["b","x"]')]);
    expect(out.registrations[0]).toMatchObject({ world: 'MAIN', hosts: ['a.com'] });
    expect(out.registrations[0]?.js[1]).toBe(scriptletCodePath('ads', 'MAIN'));
    const data = readShardFile(out.files.get(out.registrations[0]?.js[0] ?? '') ?? '', 'MAIN');
    expect(data?.invocations).toEqual([[1, 'x']]);
  });

  test('a shard holding only runtime exceptions registers nothing', () => {
    expect(emit([fact('a.example.com', 'u', '.x')]).registrations).toEqual([]);
  });

  test('large data is spread over more shards, each within the worst-shard target, and lookup still works per host', () => {
    const facts = Array.from({ length: 3000 }, (_, i) => fact(`site${String(i)}.com`, 'h', `.ad-${'x'.repeat(30)}-${String(i)}`));
    const out = emit(facts);
    expect(out.files.size).toBeGreaterThan(2);
    expect(out.worstShardBytes).toBeLessThanOrEqual(SHARD_TARGET_WORST_BYTES);
    const reg = out.registrations.find((r) => r.hosts.includes('site42.com' as Hostname));
    const data = readShardFile(out.files.get(reg?.js[0] ?? '') ?? '', 'ISOLATED');
    expect(data && lookupHost(data, 'site42.com' as Hostname).selectors.map((i) => data.selectors[i])).toEqual([`.ad-${'x'.repeat(30)}-42`]);
    expect(data?.shard).toBeLessThan(256);
  });

  test('P2-32: a shard cap (regional packs: 64 per world) bounds the shard count whatever the data size', () => {
    const facts = Array.from({ length: 3000 }, (_, i) => fact(`site${String(i)}.com`, 'h', `.ad-${'x'.repeat(30)}-${String(i)}`));
    const capped = emitPackContent({ pack: 'ads', isolated: facts, main: [], fnIndex, maxShards: 2 });
    expect(new Set(capped.registrations.map((r) => r.id.split(':')[2])).size).toBeLessThanOrEqual(2);
    expect(capped.patterns).toBe(3000);
  });

  test('deterministic bytes for any input order', () => {
    const facts = [fact('b.com', 'h', '.z'), fact('a.com', 'h', '.y'), fact('a.com', 's', '["b","color:red"]')];
    expect([...emit(facts).files]).toEqual([...emit([...facts].reverse()).files]);
  });

  test('lookup on the emitted data equals brute force over the facts (property)', () => {
    const hostArb = fc.constantFrom('a.com', 'x.a.com', 'y.x.a.com', 'b.co.uk', 'z.b.co.uk', 'c.net');
    const factArb = fc.record({ host: hostArb, kind: fc.constantFrom('h', 'u', 's'), value: fc.constantFrom('.p', '.q', '.r') });
    fc.assert(fc.property(fc.array(factArb, { maxLength: 25 }), hostArb, (raw, query) => {
      const facts = raw.map((f) => fact(f.host, f.kind, f.kind === 's' ? JSON.stringify([f.value, 'color:red']) : f.value));
      const out = emit(facts);
      const ancestors = new Set<string>(parentDomains(query as Hostname));
      const at = (kind: string) => new Set(facts.filter((f) => f.kind === kind && ancestors.has(f.host)).map((f) => f.value));
      const hidden = [...at('h')].filter((v) => !at('u').has(v)).sort();
      const styles = [...at('s')].sort();
      const text = out.files.get(isolatedDataPath('ads', 0));
      const data = text === undefined ? null : readShardFile(text, 'ISOLATED');
      const got = data === null ? { selectors: [], styles: [] } : lookupHost(data, query as Hostname);
      expect(got.selectors.map((i) => data?.selectors[i]).sort()).toEqual(hidden);
      expect(got.styles.map((i) => JSON.stringify(data?.styles[i])).sort()).toEqual(styles);
    }), { numRuns: 300 });
  });
});
