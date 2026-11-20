/**
 * Catalog reader (P1-05): shape check with Valibot, then the cross-references a schema cannot
 * express. Every problem is reported, not only the first.
 */
import * as v from 'valibot';
import { isCanonicalHostname } from '../hostname/validate.js';
import { isUnsafeRulesetId, parsePackId, parseRulesetId, type Hostname, type PackId, type RulesetId } from '../ids.js';
import { MAX_DECLARED_RULESETS, STATIC_REGEX_POOL } from '../limits.js';
import { err, ok, type Result } from '../result.js';
import { REGISTRATIONS_FILE, registrationErrors, RegistrationSchema, type CatalogRegistration } from './registrations.js';
import { CATALOG_SCHEMA, type Catalog, type CatalogPack, type CatalogRuleset } from './types.js';
import { own } from '../record.js';

const count = v.pipe(v.number(), v.integer(), v.minValue(0));

const RulesetSchema = v.strictObject({
  needsHostAccess: v.boolean(),
  maxRules: count,
  maxRegex: v.pipe(count, v.maxValue(STATIC_REGEX_POOL)),
});

const PackSchema = v.strictObject({
  rulesets: v.array(v.string()),
  default: v.boolean(),
  licence: v.picklist(['cleared', 'owner-pending']),
  registrations: v.optional(v.array(RegistrationSchema), []),
  generic: v.optional(v.boolean(), false),
});

/** At most this many `$generichide` hosts (≈ 900 in today's lists). */
const MAX_GENERIC_OFF = 20_000;

const CatalogSchema = v.strictObject({
  schema: v.literal(CATALOG_SCHEMA),
  /** Where the host lists are (D-26); the catalog port merges that file in before this check. */
  registrations: v.optional(v.strictObject({ path: v.literal(REGISTRATIONS_FILE), sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) })),
  rulesets: v.record(v.string(), RulesetSchema),
  packs: v.record(v.string(), PackSchema),
  /** From `registrations.json` (merged by the catalog port) or inline (test catalogs). */
  genericOff: v.optional(v.pipe(v.array(v.string()), v.maxLength(MAX_GENERIC_OFF))),
});

type RawCatalog = v.InferOutput<typeof CatalogSchema>;

function rulesetErrors(raw: RawCatalog): string[] {
  const ids = Object.keys(raw.rulesets);
  const tooMany = ids.length > MAX_DECLARED_RULESETS ? [`more than ${String(MAX_DECLARED_RULESETS)} rulesets`] : [];
  return [
    ...tooMany,
    ...ids.flatMap((id) => {
      const parsed = parseRulesetId(id);
      if (!parsed) return [`invalid ruleset id "${id}"`];
      const unsafe = isUnsafeRulesetId(parsed);
      return own(raw.rulesets, id)?.needsHostAccess === unsafe
        ? []
        : [`ruleset "${id}": needsHostAccess must be ${String(unsafe)}`];
    }),
  ];
}

function packErrors(raw: RawCatalog): string[] {
  const owners = new Map<string, string>();
  return Object.entries(raw.packs).flatMap(([id, pack]) => [
    ...(parsePackId(id) ? [] : [`invalid pack id "${id}"`]),
    ...pack.rulesets.flatMap((ruleset) => {
      if (!Object.hasOwn(raw.rulesets, ruleset)) return [`pack "${id}" references missing ruleset "${ruleset}"`];
      const owner = owners.get(ruleset);
      owners.set(ruleset, owner ?? id);
      return owner === undefined ? [] : [`ruleset "${ruleset}" is listed by packs "${owner}" and "${id}"`];
    }),
  ]);
}

/** Canonical, sorted and unique, like every host list the worker reads. */
function genericOffErrors(raw: RawCatalog): string[] {
  const hosts = raw.genericOff ?? [];
  const bad = hosts.filter((h, i) => !isCanonicalHostname(h) || (i > 0 && (hosts[i - 1] ?? '') >= h));
  return bad.slice(0, 3).map((h) => `genericOff: invalid, unsorted or repeated host "${h}"`);
}

function allRegistrationErrors(raw: RawCatalog): string[] {
  return Object.entries(raw.packs).reduce<{ errors: string[]; seen: ReadonlySet<string> }>(
    (acc, [id, pack]) => ({
      errors: [...acc.errors, ...registrationErrors(id, pack.registrations, acc.seen)],
      seen: new Set([...acc.seen, ...pack.registrations.map((r) => r.id)]),
    }),
    { errors: [], seen: new Set() },
  ).errors;
}

function freezeRegistration(r: RawCatalog['packs'][string]['registrations'][number]): CatalogRegistration {
  return Object.freeze({
    ...r,
    js: Object.freeze([...r.js]),
    hosts: Object.freeze([...r.hosts]) as CatalogRegistration['hosts'],
  });
}

function freezeCatalog(raw: RawCatalog): Catalog {
  const rulesets = Object.fromEntries(
    Object.entries(raw.rulesets).map(([id, r]) => [id, Object.freeze({ ...r })]),
  ) as Record<RulesetId, CatalogRuleset>;
  const packs = Object.fromEntries(
    Object.entries(raw.packs).map(([id, p]) => [
      id,
      Object.freeze({
        ...p,
        rulesets: Object.freeze([...p.rulesets]) as readonly RulesetId[],
        registrations: Object.freeze(p.registrations.map(freezeRegistration)),
      }),
    ]),
  ) as Record<PackId, CatalogPack>;
  return Object.freeze({
    schema: CATALOG_SCHEMA,
    rulesets: Object.freeze(rulesets),
    packs: Object.freeze(packs),
    genericOff: raw.genericOff === undefined ? null : (Object.freeze([...raw.genericOff]) as readonly Hostname[]),
  });
}

/** Validates an untrusted catalog value (parsed JSON). Returns a frozen catalog or every error found. */
export function readCatalog(input: unknown): Result<Catalog> {
  const parsed = v.safeParse(CatalogSchema, input);
  if (!parsed.success) {
    return err(parsed.issues.map((issue) => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`));
  }
  const errors = [
    ...rulesetErrors(parsed.output),
    ...packErrors(parsed.output),
    ...allRegistrationErrors(parsed.output),
    ...genericOffErrors(parsed.output),
  ];
  return errors.length > 0 ? err(errors) : ok(freezeCatalog(parsed.output));
}
