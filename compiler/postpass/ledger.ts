/**
 * Stable rule ids (filter-pipeline notes §6.7, ADR-011, P1-24). Per ruleset, a ledger maps each rule's key to its
 * id; `nextId` only grows and entries are never removed, so an id is never given to another rule.
 *
 * - Host-only (coalesced) rule: `b:<hash of everything but the request hosts>:<bucket>`, so the id
 *   survives daily changes to its host list (filter-pipeline notes §6.7).
 * - Any other rule: `r:<hash of the canonical rule without id>`.
 * - Rare: host-only rules that differ only in their hosts but were not coalesced (the initiator merge
 *   can leave two such rules) share a `b:` key; each of them is then keyed `c:<hash of the whole rule>`,
 *   which is deterministic but changes with its hosts.
 *
 * Ledgers are release state (the `ruleset-state` branch), written by the build, never by hand.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonWith } from '../config/load.js';
import type { DnrCondition } from '../dnr/schema.js';
import { canonicalKey } from './canonical.js';
import type { BucketedRule } from './coalesce.js';

const LEDGER_SCHEMA = 1;
const HASH_CHARS = 20;
const HOST_ONLY = /^\|\|[a-z0-9._-]+\^$/;

export const LedgerSchema = z
  .strictObject({
    schema: z.literal(LEDGER_SCHEMA),
    ruleset: z.string().min(1),
    nextId: z.number().int().positive(),
    entries: z.record(z.string().regex(/^[brc]:/), z.number().int().positive()),
  })
  .superRefine((l, ctx) => {
    const ids = Object.values(l.entries);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'an id is listed for two keys' });
    if (ids.some((id) => id >= l.nextId)) ctx.addIssue({ code: 'custom', message: 'nextId must be above every id' });
  });
export type Ledger = z.infer<typeof LedgerSchema>;

export const emptyLedger = (ruleset: string): Ledger => ({ schema: LEDGER_SCHEMA, ruleset, nextId: 1, entries: {} });

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_CHARS);

function isHostOnly(c: DnrCondition): boolean {
  return c.regexFilter === undefined && (c.requestDomains !== undefined ? c.urlFilter === undefined : HOST_ONLY.test(c.urlFilter ?? ''));
}

const withoutHosts = (c: DnrCondition): DnrCondition =>
  Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'urlFilter' && k !== 'requestDomains'));

/** The ledger key of a rule (see the file comment). */
export function ruleKey(r: BucketedRule): string {
  const hostOnly = isHostOnly(r.rule.condition);
  const condition: DnrCondition = hostOnly ? withoutHosts(r.rule.condition) : r.rule.condition;
  const signature = canonicalKey({ ...r.rule, id: 1, condition });
  return hostOnly ? `b:${hash(signature)}:${r.bucket}` : `r:${hash(signature)}`;
}

/** Fallback key for rules whose `b:` key collides. */
const fullKey = (r: BucketedRule): string => `c:${hash(canonicalKey({ ...r.rule, id: 1 }))}:${r.bucket}`;

/** Key → rule, with colliding `b:` keys replaced by full keys; identical rules fail the build. */
function keyRules(ruleset: string, rules: readonly BucketedRule[]): ReadonlyMap<string, BucketedRule> {
  const groups = new Map<string, BucketedRule[]>();
  for (const r of rules) {
    const key = ruleKey(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const keyed = new Map<string, BucketedRule>();
  for (const [key, group] of groups) {
    const fallback = group.length > 1 && key.startsWith('b:');
    for (const r of group) {
      const k = fallback ? fullKey(r) : key;
      const other = keyed.get(k);
      if (other) throw new Error(`${ruleset}: two rules have the same ledger key ${k} (${[...other.sources, ...r.sources].map((s) => s.source.text).join(' | ')})`);
      keyed.set(k, r);
    }
  }
  return keyed;
}

export interface AssignedRuleset {
  /** The rules with ledger ids, sorted by id. */
  readonly rules: readonly BucketedRule[];
  readonly ledger: Ledger;
}

/** Gives every rule its ledger id; new keys get ids from `nextId` in key order. Pure. */
export function assignIds(ruleset: string, rules: readonly BucketedRule[], ledger: Ledger): AssignedRuleset {
  if (ledger.ruleset !== ruleset) throw new Error(`ruleset "${ruleset}" was given the ledger of "${ledger.ruleset}"`);
  const keyed = keyRules(ruleset, rules);
  const fresh = [...keyed.keys()].filter((k) => !Object.hasOwn(ledger.entries, k)).sort();
  const added = Object.fromEntries(fresh.map((k, i) => [k, ledger.nextId + i]));
  const entries: Readonly<Record<string, number>> = { ...ledger.entries, ...added };
  const out = [...keyed].map(([key, r]): BucketedRule => {
    const id = entries[key];
    if (id === undefined) throw new Error(`${ruleset}: no ledger id for ${key}`);
    return { ...r, rule: { ...r.rule, id } };
  });
  return {
    rules: out.sort((a, b) => a.rule.id - b.rule.id),
    ledger: { ...ledger, nextId: ledger.nextId + fresh.length, entries },
  };
}

/** Ledger file text: sorted keys, two-space indent, trailing newline. */
export function serialiseLedger(l: Ledger): string {
  const entries = Object.fromEntries(Object.entries(l.entries).sort(([a], [b]) => (a < b ? -1 : 1)));
  return `${JSON.stringify({ schema: l.schema, ruleset: l.ruleset, nextId: l.nextId, entries }, null, 2)}\n`;
}

/** Validated ledger from file text; the error names the file. */
export const parseLedger = (text: string, name: string): Ledger => parseJsonWith(LedgerSchema, text, name);
