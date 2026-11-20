/**
 * `lists/lists.config.json` (P1-15, filter-pipeline notes §3): where each filter list comes from, its licence
 * state, whether it is trusted (may use `requiresTrust` scriptlets, S-03), and how lists group
 * into rulesets. Zod at the compiler boundary (CONTRIBUTING.md).
 */
import { z } from 'zod';
import type { LicenceState } from '../../src/core/catalog/types.js';
import { parseRulesetId } from '../../src/core/ids.js';
import { STATIC_REGEX_POOL } from '../../src/core/limits.js';

/** Current config schema version. */
const LISTS_CONFIG_SCHEMA = 1;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const LIST_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

const listId = z.string().regex(ID, 'list id: lower-case words joined by hyphens');
const httpsUrl = z.url({ protocol: /^https$/ });

/** A versioned upstream: a git repository whose files are fetched at a pinned commit. */
const GitSourceSchema = z.strictObject({
  kind: z.literal('git'),
  repo: z.string().regex(REPO, 'repo: owner/name'),
  branch: z.string().min(1),
});

const LICENCE_STATES = ['cleared', 'owner-pending'] as const satisfies readonly LicenceState[];

const ListBase = {
  id: listId,
  title: z.string().min(1),
  /** SPDX expression of the licence we take the list under (CREDITS.md, S-13). */
  licence: z.string().min(1),
  licenceState: z.enum(LICENCE_STATES),
  /** Trusted = uBO's own uAssets lists only (S-03): only they may use `requiresTrust` scriptlets. */
  trusted: z.boolean(),
  /** `adblock`: filter syntax. `hosts`: one hostname per line (URLhaus). */
  format: z.enum(['adblock', 'hosts']),
  homepage: httpsUrl,
};

/** A list file inside a git source, fetched at the commit recorded in the lock. */
const GitListSchema = z.strictObject({ ...ListBase, source: listId, path: z.string().regex(LIST_PATH) });
/** A list that is not versioned upstream (URLhaus): pinned by the SHA-256 of an archived snapshot. */
const SnapshotListSchema = z.strictObject({ ...ListBase, url: httpsUrl });

const rulesetId = z.string().refine((v) => parseRulesetId(v) !== null && !v.endsWith('-x'), 'invalid ruleset id');

/** Ceilings of one ruleset slot (filter-pipeline notes §8); they are what the catalog records. */
const BudgetSchema = z.strictObject({
  rules: z.number().int().min(0),
  regex: z.number().int().min(0).max(STATIC_REGEX_POOL),
});

/**
 * A ruleset and its slots: `safe` → `<id>.json`, `unsafe` → `<id>-x.json` (P1-22). A ruleset without
 * lists reserves its slots for a later pack (slots change only in a full release, filter-pipeline notes §8).
 */
const RulesetSchema = z.strictObject({
  id: rulesetId,
  pack: listId,
  category: z.enum(['ads', 'tracking', 'malware', 'annoyance', 'cookies', 'params', 'regional']),
  lists: z.array(listId),
  /** Our own rules instead of lists (P2-31: `gpc`). */
  builtin: z.literal('gpc').optional(),
  slots: z.strictObject({ safe: BudgetSchema.optional(), unsafe: BudgetSchema.optional() })
    .refine((v) => v.safe !== undefined || v.unsafe !== undefined, 'a ruleset needs at least one slot'),
});

const PackSchema = z.strictObject({ title: z.string().min(1), default: z.boolean() });

/** The `popups` ruleset (filter-pipeline notes §7a): built from the pop-up filters of other rulesets. */
const PopupsSchema = z.strictObject({ id: rulesetId, pack: listId, from: z.array(rulesetId).min(1), budget: BudgetSchema });

const ConfigShape = z.strictObject({
  schema: z.literal(LISTS_CONFIG_SCHEMA),
  sources: z.record(listId, GitSourceSchema),
  packs: z.record(listId, PackSchema),
  lists: z.array(z.union([GitListSchema, SnapshotListSchema])).min(1),
  rulesets: z.array(RulesetSchema).min(1),
  popups: PopupsSchema,
  /** Content emitters (P1-27…P1-29). `catalogRegistrations`: write registrations into `catalog.json` (on with P1-35). */
  content: z.strictObject({
    catalogRegistrations: z.boolean(),
    /** Gate on entity names lost by observed expansion (D-20). */
    maxLostEntities: z.number().int().min(0),
  }),
  /** Count oracle against uBOL (filter-pipeline notes §11): tolerances are relative changes; failure at `failFactor` × them. */
  oracle: z.strictObject({
    file: z.string().regex(LIST_PATH),
    rulesMin: z.number().max(0),
    rulesMax: z.number().min(0),
    regexMax: z.number().min(0),
    failFactor: z.number().min(1),
  }),
});

type RawConfig = z.infer<typeof ConfigShape>;

const duplicates = (values: readonly string[]): string[] =>
  values.filter((v, i) => values.indexOf(v) !== i);

/** Cross-references a shape check cannot express; returns every problem. */
function referenceErrors(c: RawConfig): string[] {
  const listIds = c.lists.map((l) => l.id);
  const inRulesets = c.rulesets.flatMap((r) => r.lists);
  return [
    ...duplicates(listIds).map((id) => `duplicate list id "${id}"`),
    ...duplicates(c.rulesets.map((r) => r.id)).map((id) => `duplicate ruleset id "${id}"`),
    ...c.lists.flatMap((l) =>
      'source' in l && !(l.source in c.sources) ? [`list "${l.id}" names unknown source "${l.source}"`] : [],
    ),
    ...inRulesets.filter((id) => !listIds.includes(id)).map((id) => `ruleset references unknown list "${id}"`),
    ...duplicates(inRulesets).map((id) => `list "${id}" is in more than one ruleset`),
    ...listIds.filter((id) => !inRulesets.includes(id)).map((id) => `list "${id}" is in no ruleset`),
    ...packErrors(c),
  ];
}

function packErrors(c: RawConfig): string[] {
  const rulesetIds = c.rulesets.map((r) => r.id);
  const usedPacks = [...c.rulesets.map((r) => r.pack), c.popups.pack];
  return [
    ...usedPacks.filter((p) => !Object.hasOwn(c.packs, p)).map((p) => `unknown pack "${p}"`),
    ...Object.keys(c.packs).filter((p) => !usedPacks.includes(p)).map((p) => `pack "${p}" has no ruleset`),
    ...c.popups.from.filter((id) => !rulesetIds.includes(id)).map((id) => `popups reads unknown ruleset "${id}"`),
    ...(rulesetIds.includes(c.popups.id) ? [`ruleset id "${c.popups.id}" is also the popups id`] : []),
  ];
}

export const ListsConfigSchema = ConfigShape.superRefine((c, ctx) => {
  for (const message of referenceErrors(c)) ctx.addIssue({ code: 'custom', message });
});

export type ListsConfig = z.infer<typeof ListsConfigSchema>;
export type ListConfig = ListsConfig['lists'][number];
export type GitListConfig = Extract<ListConfig, { source: string }>;
export type RulesetConfig = ListsConfig['rulesets'][number];
export type SlotBudget = z.infer<typeof BudgetSchema>;

/** True when the list is fetched from a git source at a pinned commit. */
export function isGitList(list: ListConfig): list is GitListConfig {
  return 'source' in list;
}

export { COMMIT as COMMIT_PATTERN };
