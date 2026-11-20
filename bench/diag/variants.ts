/**
 * A/B variants of the built extension for the P2-47 diagnosis: each removes or reshapes one piece so
 * its memory and CPU share can be measured. Pure transforms over the build's text files (manifest,
 * catalog, `registrations.json`, worker bundle); the catalog's SHA-256 of `registrations.json` is
 * recomputed so the worker accepts the variant. Diagnosis builds only — never shipped.
 */
import { createHash } from 'node:crypto';

export const VARIANTS = ['full', 'no-registrations', 'one-host-each', 'two-registrations', 'no-rulesets', 'non-persistent', 'unique-js-only', 'grouped-64', 'grouped-128', 'grouped-256', 'six-one-host'] as const;
export type Variant = (typeof VARIANTS)[number];

interface Registration {
  readonly id: string;
  readonly world: string;
  readonly js: readonly string[];
  readonly hosts: readonly string[];
}

interface RegistrationsFile {
  readonly schema: number;
  readonly packs: Readonly<Record<string, readonly Registration[]>>;
}

/** The files a variant may change, by path in the build. */
export type BuildText = ReadonlyMap<string, string>;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function withRegistrations(files: BuildText, packs: RegistrationsFile['packs']): BuildText {
  const reg = JSON.parse(files.get('registrations.json') ?? '{}') as RegistrationsFile;
  const text = JSON.stringify({ ...reg, packs });
  const catalog = JSON.parse(files.get('catalog.json') ?? '{}') as { registrations: { path: string; sha256: string } };
  return new Map([...files, ['registrations.json', text], ['catalog.json', JSON.stringify({ ...catalog, registrations: { ...catalog.registrations, sha256: sha256(text) } })]]);
}

const packsOf = (files: BuildText): RegistrationsFile['packs'] => (JSON.parse(files.get('registrations.json') ?? '{}') as RegistrationsFile).packs;
const mapPacks = (packs: RegistrationsFile['packs'], f: (rs: readonly Registration[]) => readonly Registration[]): RegistrationsFile['packs'] =>
  Object.fromEntries(Object.entries(packs).map(([p, rs]) => [p, f(rs)]));

/** Every host of a pack in one registration per world; `js` merged (behaviour is not the point here). */
function mergedPerWorld(rs: readonly Registration[]): readonly Registration[] {
  const worlds = [...new Set(rs.map((r) => r.world))];
  return worlds.map((world, i) => {
    const of = rs.filter((r) => r.world === world);
    return { id: `${of[0]?.id ?? 'x'}:merged:${String(i)}`, world, js: [...new Set(of.flatMap((r) => r.js))], hosts: [...new Set(of.flatMap((r) => r.hosts))].sort() };
  });
}

/** Registrations of one (pack, world) merged into consecutive groups so the whole build has about `target`. */
function grouped(packs: RegistrationsFile['packs'], target: number): RegistrationsFile['packs'] {
  const total = Object.values(packs).reduce((n, rs) => n + rs.length, 0);
  const per = Math.max(1, Math.ceil(total / target));
  return mapPacks(packs, (rs) => {
    const worlds = [...new Set(rs.map((r) => r.world))];
    return worlds.flatMap((world) => {
      const of = rs.filter((r) => r.world === world);
      return Array.from({ length: Math.ceil(of.length / per) }, (_, g) => mergedPerWorld(of.slice(g * per, (g + 1) * per))).flat();
    });
  });
}

/** Summed and unique bytes of the script files named by the registrations (`size` of each file). */
export function scriptBytes(packs: RegistrationsFile['packs'], size: (file: string) => number): { summed: number; unique: number; top: readonly (readonly [string, number])[] } {
  const counts = new Map<string, number>();
  for (const r of Object.values(packs).flat()) for (const f of r.js) counts.set(f, (counts.get(f) ?? 0) + 1);
  const repeated = [...counts].map(([f, n]) => [f, n * size(f)] as const).sort((a, b) => b[1] - a[1]);
  return { summed: repeated.reduce((n, [, b]) => n + b, 0), unique: [...counts.keys()].reduce((n, f) => n + size(f), 0), top: repeated.slice(0, 5) };
}

export const registrationsOf = (text: string): RegistrationsFile['packs'] => (JSON.parse(text) as RegistrationsFile).packs;

/** The registrations of the packs `catalog.json` marks default: what a fresh install registers (the D-41 gate's set). */
export function defaultRegistrations(packs: RegistrationsFile['packs'], catalogText: string): RegistrationsFile['packs'] {
  const catalog = JSON.parse(catalogText) as { readonly packs: Readonly<Record<string, { readonly default: boolean }>> };
  return Object.fromEntries(Object.entries(packs).filter(([id]) => catalog.packs[id]?.default === true));
}

/** Each registration keeps only the files no other registration names (its shard data), else its first file. */
function uniqueJsOnly(packs: RegistrationsFile['packs']): RegistrationsFile['packs'] {
  const count = new Map<string, number>();
  for (const r of Object.values(packs).flat()) for (const f of r.js) count.set(f, (count.get(f) ?? 0) + 1);
  return mapPacks(packs, (rs) =>
    rs.map((r) => {
      const own = r.js.filter((f) => count.get(f) === 1);
      return { ...r, js: own.length > 0 ? own : r.js.slice(0, 1) };
    }),
  );
}

function noRulesets(files: BuildText): BuildText {
  const manifest = JSON.parse(files.get('manifest.json') ?? '{}') as { declarative_net_request: { rule_resources: { enabled: boolean }[] } };
  const resources = manifest.declarative_net_request.rule_resources.map((r) => ({ ...r, enabled: false }));
  const catalog = JSON.parse(files.get('catalog.json') ?? '{}') as { packs: Record<string, { rulesets: string[] }> };
  const packs = Object.fromEntries(Object.entries(catalog.packs).map(([id, p]) => [id, { ...p, rulesets: [] }]));
  return new Map([
    ...files,
    ['manifest.json', JSON.stringify({ ...manifest, declarative_net_request: { ...manifest.declarative_net_request, rule_resources: resources } })],
    ['catalog.json', JSON.stringify({ ...catalog, packs })],
  ]);
}

export function applyVariant(files: BuildText, variant: Variant): BuildText {
  switch (variant) {
    case 'full':
      return files;
    case 'no-registrations':
      return withRegistrations(files, mapPacks(packsOf(files), () => []));
    case 'one-host-each':
      return withRegistrations(files, mapPacks(packsOf(files), (rs) => rs.map((r) => ({ ...r, hosts: r.hosts.slice(0, 1) }))));
    case 'two-registrations':
      return withRegistrations(files, mapPacks(packsOf(files), mergedPerWorld));
    case 'no-rulesets':
      return noRulesets(files);
    case 'grouped-64':
      return withRegistrations(files, grouped(packsOf(files), 64));
    case 'grouped-128':
      return withRegistrations(files, grouped(packsOf(files), 128));
    case 'grouped-256':
      return withRegistrations(files, grouped(packsOf(files), 256));
    case 'six-one-host':
      return withRegistrations(files, mapPacks(packsOf(files), (rs) => mergedPerWorld(rs).map((r) => ({ ...r, hosts: r.hosts.slice(0, 1) }))));
    case 'unique-js-only':
      return withRegistrations(files, uniqueJsOnly(packsOf(files)));
    case 'non-persistent':
      return new Map([...files, ['background.js', (files.get('background.js') ?? '').replaceAll('persistAcrossSessions:!0', 'persistAcrossSessions:!1')]]);
  }
}
