/**
 * Global Privacy Control (P2-31, filter-pipeline notes §3.2): `gpc-x` holds our one rule, not a fetched list. It sets
 * `Sec-GPC: 1` on every request. `resourceTypes` lists every type: an omitted list would exclude
 * `main_frame`. The lowest stock priority, so Off and pause (`allowAllRequests`, 30,000,000) suppress it.
 */
import type { BucketedRule } from '../postpass/coalesce.js';
import { STOCK_PRIORITY_SHIFT } from '../../src/core/limits.js';
import { RESOURCE_TYPES } from '../dnr/schema.js';

/** The lowest priority of the stock band (stock rules start at 10, ADR-011). */
const GPC_PRIORITY = STOCK_PRIORITY_SHIFT + 1;

export function gpcRules(category: string): readonly BucketedRule[] {
  return [{
    rule: {
      id: 1,
      priority: GPC_PRIORITY,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Sec-GPC', operation: 'set', value: '1' }] },
      condition: { resourceTypes: [...RESOURCE_TYPES] },
    },
    sources: [{ text: 'built-in: Sec-GPC: 1', source: { list: 'gpc', line: 1, text: 'built-in: Sec-GPC: 1' }, fixes: [] }],
    bucket: `other:${category}`,
  }];
}
