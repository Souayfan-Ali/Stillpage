/**
 * Content checks of the verify stage (testing notes §4, P1-27…P1-29), over the emitted bytes: every
 * registration host is a valid match-pattern host (one bad pattern fails a whole register call,
 * S-04), the layout rule (a host once per pack and world, never under a listed parent), every listed
 * file is packaged, the pattern and registration budgets, and every data file parses back with
 * sanitised selectors and declarations within the shard size budget.
 */
import { z } from 'zod';
import type { CatalogRegistration } from '../../src/core/catalog/registrations.js';
import { RUNTIME_SCRIPTS } from '../../src/core/content/files.js';
import { commonDataPath } from '../../src/core/content/files.js';
import { SHARD_DATA_VERSION, shardFileWrap, type HostEntry, type ShardData } from '../../src/core/content/shard-data.js';
import { parseHostname } from '../../src/core/hostname/validate.js';
import { parentDomains } from '../../src/core/hostname/walk.js';
import type { Hostname } from '../../src/core/ids.js';
import { DEFAULT_REGISTRATION_BUDGET, MAX_SHARD_BYTES, REGISTERED_SCRIPT_BYTES_BUDGET, REGISTRATION_BUDGET } from '../../src/core/limits.js';
import { genericSizeProblems, patternBudgetProblems, scriptBytes } from './patterns.js';
import { sanitiseDeclarations } from '../../src/core/sanitise/declaration.js';
import { sanitiseSelector } from '../../src/core/sanitise/selector.js';
import { isPatternHost } from '../content/hosts.js';

export interface ContentVerifyInput {
  readonly files: ReadonlyMap<string, string>;
  readonly registrations: ReadonlyMap<string, readonly CatalogRegistration[]>;
  readonly defaultPacks: ReadonlySet<string>;
  /** Regional packs (their own pattern line, P2-32); none when absent. */
  readonly regionalPacks?: ReadonlySet<string>;
  /** Patterns and registrations of the fixed registrations (pop-up guard, GPC), counted with every pack on. */
  readonly fixed?: { readonly patterns: number; readonly registrations: number };
}

const RUNTIME = new Set<string>(Object.values(RUNTIME_SCRIPTS));
/** Per-shard data files (`cosmetic/<pack>/<n>.js`, `scriptlets/<pack>/main/<n>.js`); common tables are checked by size. */
const SHARD_FILE = /^(?:cosmetic\/[a-z0-9-]+|scriptlets\/[a-z0-9-]+\/main)\/\d+\.js$/;

const index = z.number().int();
const Invocation = z.tuple([z.number().int().min(0)], z.string());
const EntrySchema = z.strictObject({ h: z.array(index).optional(), u: z.array(index).optional(), s: z.array(index).optional(),
  p: z.array(index).optional(), j: z.array(index).optional(), n: z.array(index).optional() })
  .transform((e): HostEntry => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)));
const ShardSchema = z.strictObject({
  v: z.literal(SHARD_DATA_VERSION), pack: z.string(), shard: z.number().int().min(0),
  hosts: z.array(z.string().refine((h) => parseHostname(h) === h, 'not a hostname').transform((h) => h as Hostname)), entries: z.array(EntrySchema),
  selectors: z.array(z.string()), styles: z.array(z.tuple([z.string(), z.string()])), procedural: z.array(z.string()), invocations: z.array(Invocation),
});
const CommonSchema = z.strictObject({ v: z.literal(SHARD_DATA_VERSION), pack: z.string(), common: z.literal(true), invocations: z.array(Invocation) });

const unwrap = (text: string, world: 'ISOLATED' | 'MAIN'): unknown => {
  const wrap = [shardFileWrap(world), shardFileWrap(world, true)].find((w) => text.startsWith(w.prefix) && text.endsWith(w.suffix));
  if (wrap === undefined) return undefined;
  const { prefix, suffix } = wrap;
  try {
    return JSON.parse(text.slice(prefix.length, -suffix.length));
  } catch {
    return undefined;
  }
};

/** Every index inside its table (negative `j`/`n` inside the common table), hosts sorted and unique. */
function indicesInRange(d: z.infer<typeof ShardSchema>, common: number): boolean {
  const within = (xs: readonly number[] | undefined, n: number, neg = 0): boolean => (xs ?? []).every((x) => x < n && x >= -neg);
  const sorted = d.hosts.every((h, i) => i === 0 || (d.hosts[i - 1] ?? '') < h);
  return sorted && d.hosts.length === d.entries.length && d.entries.every((e) => within(e.h, d.selectors.length) && within(e.u, d.selectors.length)
    && within(e.s, d.styles.length) && within(e.p, d.procedural.length) && within(e.j, d.invocations.length, common) && within(e.n, d.invocations.length, common));
}

/**
 * Parses a data file back with a strict schema and range checks; `null` when its wrapper, shape or
 * indices are not what the compiler writes. `common` is the size of the pack's common table.
 */
export function readShardFile(text: string, world: 'ISOLATED' | 'MAIN', common = Infinity): ShardData | null {
  const parsed = ShardSchema.safeParse(unwrap(text, world));
  return parsed.success && indicesInRange(parsed.data, common) ? parsed.data : null;
}

/** Number of invocations in a common table file, or null when it is malformed. */
function readCommonFile(text: string, world: 'ISOLATED' | 'MAIN'): number | null {
  const parsed = CommonSchema.safeParse(unwrap(text, world));
  return parsed.success ? parsed.data.invocations.length : null;
}

function layoutProblems(pack: string, regs: readonly CatalogRegistration[]): string[] {
  return (['ISOLATED', 'MAIN'] as const).flatMap((world) => {
    const hosts = regs.filter((r) => r.world === world).flatMap((r) => r.hosts);
    const listed = new Set<Hostname>(hosts);
    const twice = hosts.length - listed.size;
    const nested = hosts.filter((h) => parentDomains(h).slice(1).some((p) => listed.has(p)));
    return [
      ...(twice > 0 ? [`${pack} ${world}: ${String(twice)} host(s) in more than one registration`] : []),
      ...(nested.length > 0 ? [`${pack} ${world}: ${String(nested.length)} host(s) listed under a listed parent (e.g. ${nested[0] ?? ''})`] : []),
    ];
  });
}

function dataProblems(path: string, text: string, world: 'ISOLATED' | 'MAIN', common: number): string[] {
  const data = readShardFile(text, world, common);
  if (data === null) return [`${path}: not a shard data file`];
  const size = Buffer.byteLength(text);
  const unsafe = [...data.selectors.filter((s) => sanitiseSelector(s) !== s),
    ...data.styles.filter(([s, d]) => sanitiseSelector(s) !== s || sanitiseDeclarations(d)?.css !== d).map(([s]) => s)];
  return [
    ...(size > MAX_SHARD_BYTES ? [`${path}: ${String(size)} B > ${String(MAX_SHARD_BYTES)}`] : []),
    ...(unsafe.length > 0 ? [`${path}: ${String(unsafe.length)} selector(s) or style(s) the sanitiser refuses`] : []),
    ...(data.hosts.some((h) => !isPatternHost(h)) ? [`${path}: a host that is not a pattern host`] : []),
  ];
}

/** Common tables: well-formed and within the shard size budget (review MEDIUM 3). */
function commonProblems(files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([p]) => p.endsWith('/common.js')).flatMap(([p, t]) => {
    const world = p.includes('/main/') ? 'MAIN' : 'ISOLATED';
    const size = Buffer.byteLength(t);
    return [...(readCommonFile(t, world) === null ? [`${p}: not a common table`] : []), ...(size > MAX_SHARD_BYTES ? [`${p}: ${String(size)} B > ${String(MAX_SHARD_BYTES)}`] : [])];
  });
}

/**
 * Upper bound of one runtime script (`cosmetic-specific.js` 6.3 kB, `cosmetic-procedural.js` 5.0 kB today;
 * WXT builds them after the compiler, so the gate counts this allowance).
 */
const RUNTIME_SCRIPT_ALLOWANCE = 8_000;

/** Bytes of a registered file: the compiler's own, or the runtime-script allowance. */
export const registeredFileBytes = (files: ReadonlyMap<string, string>) => (path: string): number =>
  RUNTIME.has(path) ? RUNTIME_SCRIPT_ALLOWANCE : Buffer.byteLength(files.get(path) ?? '');

function scriptByteProblems(defaultRegs: readonly CatalogRegistration[], files: ReadonlyMap<string, string>): string[] {
  const { summed } = scriptBytes(defaultRegs, registeredFileBytes(files));
  return summed > REGISTERED_SCRIPT_BYTES_BUDGET ? [`${String(summed)} registered script bytes summed over the default registrations > ${String(REGISTERED_SCRIPT_BYTES_BUDGET)} (D-41)`] : [];
}

function budgetProblems(i: ContentVerifyInput): string[] {
  const all = [...i.registrations.values()].flat();
  const count = (regs: readonly CatalogRegistration[]): number => regs.reduce((n, r) => n + r.hosts.length, 0);
  const defaultRegs = [...i.registrations].filter(([p]) => i.defaultPacks.has(p)).flatMap(([, r]) => r);
  return [
    ...genericSizeProblems(i.files),
    ...patternBudgetProblems(Object.fromEntries([...i.registrations].map(([p, r]) => [p, count(r)])), { defaults: i.defaultPacks, regional: i.regionalPacks ?? new Set() }, i.fixed?.patterns ?? 0),
    ...(all.length + (i.fixed?.registrations ?? 0) > REGISTRATION_BUDGET ? [`${String(all.length + (i.fixed?.registrations ?? 0))} registrations > ${String(REGISTRATION_BUDGET)}`] : []),
    ...(defaultRegs.length > DEFAULT_REGISTRATION_BUDGET ? [`${String(defaultRegs.length)} registrations for the default packs > ${String(DEFAULT_REGISTRATION_BUDGET)} (D-23, D-41)`] : []),
    ...scriptByteProblems(defaultRegs, i.files),
  ];
}

/** Every content failure found (none means the content artefacts pass). */
export function verifyContent(i: ContentVerifyInput): readonly string[] {
  const regs = [...i.registrations].flatMap(([pack, r]) => r.map((x) => ({ pack, r: x })));
  const badHosts = regs.flatMap(({ r }) => r.hosts.filter((h) => !isPatternHost(h)));
  const missing = [...new Set(regs.flatMap(({ r }) => r.js))].filter((p) => !i.files.has(p) && !RUNTIME.has(p));
  const ids = regs.map(({ r }) => r.id);
  const dataFiles = new Map(regs.flatMap(({ r }) => r.js.filter((p) => SHARD_FILE.test(p)).map((p) => [p, r.world] as const)));
  return [
    ...(badHosts.length > 0 ? [`${String(badHosts.length)} registration host(s) are not valid match-pattern hosts (e.g. ${badHosts.slice(0, 3).join(', ')})`] : []),
    ...(new Set(ids).size === ids.length ? [] : ['duplicate registration ids']),
    ...missing.map((p) => `a registration lists ${p}, which is not packaged`),
    ...[...i.registrations].flatMap(([pack, r]) => layoutProblems(pack, r)),
    ...[...dataFiles].flatMap(([path, world]) => {
      const t = i.files.get(path);
      const pack = path.split('/')[1] ?? '';
      const commonText = i.files.get(commonDataPath(pack, world));
      const common = commonText === undefined ? 0 : readCommonFile(commonText, world) ?? 0;
      return t === undefined ? [] : dataProblems(path, t, world, common);
    }),
    ...commonProblems(i.files),
    ...budgetProblems(i),
  ];
}
