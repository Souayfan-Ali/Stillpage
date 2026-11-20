/** Shared build of verify-stage inputs: three slots emitted from a few hand-written rules. */
import { readFileSync } from 'node:fs';
import { loadListsConfig, parseJsonWith } from '../../../../compiler/config/load.js';
import type { DnrRule } from '../../../../compiler/dnr/schema.js';
import { emitBuild } from '../../../../compiler/emit/emit.js';
import { EntitiesSchema } from '../../../../compiler/entities/schema.js';
import { slotsOf } from '../../../../compiler/postpass/budgets.js';
import type { BucketedRule } from '../../../../compiler/postpass/coalesce.js';
import { assignIds, emptyLedger, type Ledger } from '../../../../compiler/postpass/ledger.js';
import { queryKey, queryOf } from '../../../../compiler/validate/regex.js';
import type { VerifyInput } from '../../../../compiler/verify/verify.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const entities = parseJsonWith(EntitiesSchema, readFileSync(`${ROOT}lists/entities.json`, 'utf8'), 'entities');
const src = { text: 't', source: { list: 'l', line: 1, text: 't' }, fixes: [] };
export const b = (rule: Omit<DnrRule, 'id'>): BucketedRule => ({ rule: { id: 1, ...rule }, sources: [src], bucket: 'other:ads' });

export const UBO = [b({ priority: 110, action: { type: 'block' }, condition: { urlFilter: '||a.example/x.js' } }),
  b({ priority: 10, action: { type: 'block' }, condition: { regexFilter: '^https://r\\.example/' } })];
export const UBO_X = [b({ priority: 1110, action: { type: 'redirect', redirect: { extensionPath: '/surrogates/noop.js' } }, condition: { urlFilter: '||a.example/x.js' } })];
export const POPUPS = [b({ priority: 1, action: { type: 'block' }, condition: { resourceTypes: ['main_frame'], requestDomains: ['pop.example'] } }),
  b({ priority: 3, action: { type: 'allow' }, condition: { resourceTypes: ['main_frame'], urlFilter: '||ok.example^' } })];

export async function built(over: { ubo?: BucketedRule[]; uboX?: BucketedRule[]; popups?: BucketedRule[]; destinations?: string[]; lifted?: Readonly<Record<string, readonly string[]>>; badware?: BucketedRule[] } = {}): Promise<VerifyInput> {
  const config = await loadListsConfig(`${ROOT}lists/lists.config.json`);
  const slots = slotsOf(config);
  const ledgers = new Map<string, Ledger>();
  const rules = new Map<string, readonly BucketedRule[]>();
  for (const [id, rs] of [['ubo', over.ubo ?? UBO], ['ubo-x', over.uboX ?? UBO_X], ['popups', over.popups ?? POPUPS], ['badware', over.badware ?? []]] as const) {
    const a = assignIds(id, rs, emptyLedger(id));
    ledgers.set(id, a.ledger);
    rules.set(id, a.rules);
  }
  const out = emitBuild({ config, slots, rules, entities, destinations: over.destinations ?? ['pop.example'], lifted: over.lifted ?? {}, strictSites: [], log: [] });
  const regexResults = Object.fromEntries([...rules.values()].flat().flatMap((r) => { const q = queryOf(r.rule); return q ? [[queryKey(q), true]] : []; }));
  return { slots, popupsId: 'popups', files: out.shipped, ledgers, regexResults };
}
