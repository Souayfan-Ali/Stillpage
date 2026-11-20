/**
 * The compiled rulesets of the default packs as `npm run lists:build` emitted them into `public/`
 * (the files that ship). The DNR suites load them unpacked with every ruleset on — `-x` included,
 * i.e. the all-sites configuration — exactly as the reconciler enables them by default.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readCatalog } from '../../../src/core/catalog/read.js';
import type { TestRuleset } from './launch.js';

const PUBLIC = path.resolve(import.meta.dirname, '../../../public');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

/** Ruleset ids of the packs that are on by default, in catalog order. */
function defaultRulesetIds(): readonly string[] {
  const catalogFile = path.join(PUBLIC, 'catalog.json');
  if (!existsSync(catalogFile)) throw new Error('public/catalog.json is missing: run `npm run lists:build` first');
  const catalog = readCatalog(readJson(catalogFile));
  if (!catalog.ok) throw new Error(`public/catalog.json is invalid: ${catalog.errors.join('; ')}`);
  return Object.values(catalog.value.packs)
    .filter((pack) => pack.default)
    .flatMap((pack) => pack.rulesets);
}

/** The compiled rules of `ids` from `public/rulesets/` (empty rulesets dropped). */
export function compiledRulesets(ids: readonly string[] = defaultRulesetIds()): readonly TestRuleset[] {
  return ids
    .map((id) => ({ id, rules: readJson(path.join(PUBLIC, 'rulesets', `${id}.json`)) as readonly object[] }))
    .filter((r) => r.rules.length > 0);
}
