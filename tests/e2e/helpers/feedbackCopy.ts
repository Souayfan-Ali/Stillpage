/**
 * Test-only patch of a corpus extension copy so the privacy panel can show real counts without a toolbar
 * click (P2-11, design review): `declarativeNetRequestFeedback` in its manifest and a `buckets.json` for the fixture
 * ruleset `fx`. The build refuses that permission (`wxt.config.ts`); never use this on the build itself.
 * Used by `privacyPanel.spec.ts` and `store/storeAssets.spec.ts`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Synthetic company for the fixture ad host (a real name would be a claim about a real company). */
const ACME = { id: 'acme', name: 'Acme Ads', host: 'ads.example' } as const;

interface FxRule {
  readonly id: number;
  readonly condition: { readonly requestDomains?: readonly string[]; readonly urlFilter?: string };
}

/** `buckets.json` for `fx`: rules naming the Acme host → `acme`, every other rule → `other:ads`. */
function bucketsFor(rules: readonly FxRule[]): object {
  const acme = (r: FxRule): boolean => (r.condition.requestDomains ?? []).includes(ACME.host) || (r.condition.urlFilter ?? '').includes(ACME.host);
  const sorted = [...rules].sort((a, b) => a.id - b.id);
  const runs = sorted.map((r) => [r.id, acme(r) ? 0 : 1]);
  const last = sorted.at(-1)?.id ?? 0;
  return {
    schema: 1,
    buckets: [
      { id: ACME.id, name: ACME.name, category: 'company' },
      { id: 'other:ads', name: 'Other', category: 'ads' },
    ],
    rulesets: { fx: [...runs, [last + 1, -1]] },
  };
}

/** Adds the feedback permission and the fixture buckets to the corpus copy in `dir`. */
export async function patchForMatchedRules(dir: string): Promise<void> {
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { permissions: string[] };
  await writeFile(manifestPath, JSON.stringify({ ...manifest, permissions: [...manifest.permissions, 'declarativeNetRequestFeedback'] }));
  const rules = JSON.parse(await readFile(path.join(dir, 'rulesets/fx.json'), 'utf8')) as FxRule[];
  await writeFile(path.join(dir, 'buckets.json'), JSON.stringify(bucketsFor(rules)));
}
