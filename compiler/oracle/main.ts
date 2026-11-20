/**
 * `npm run oracle:extract -- <uBOL unpacked dir>`: writes `lists/oracle/ubol.json` from uBOL's
 * `rulesets/ruleset-details.json` and judges uBOL's regex rules with our Chromium (counts only;
 * nothing of uBOL's output is kept or shipped, filter-pipeline notes §11).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { chromiumRegexChecker } from '../chromium/node-ports.js';
import { emptyRegexCache, queryKey, queryOf, resolveRegexes } from '../validate/regex.js';
import { DnrRuleSchema } from '../dnr/schema.js';
import { OracleFileSchema, type OracleFile } from './count.js';
import { errorText } from '../cli/errors.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'lists/oracle/ubol.json');
/** Our ruleset → uBOL's ruleset id (filter-pipeline notes §3.1 grouping). */
const MAP: Readonly<Record<string, string>> = { ubo: 'ublock-filters', easylist: 'easylist', easyprivacy: 'easyprivacy', badware: 'ublock-badware', urlhaus: 'urlhaus-full' };

const Details = z.array(z.looseObject({ id: z.string(), rules: z.looseObject({ total: z.number(), regex: z.number() }), popups: z.number().optional() }));
const LooseRules = z.array(z.looseObject({ condition: z.looseObject({}) }));

async function validRegex(dir: string, ubolId: string, checker: ReturnType<typeof chromiumRegexChecker>): Promise<number> {
  let text: string;
  try {
    text = await readFile(path.join(dir, 'rulesets/regex', `${ubolId}.json`), 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return 0;
    throw e;
  }
  const parsed = LooseRules.parse(JSON.parse(text)).map((r) => DnrRuleSchema.safeParse({ id: 1, ...r }));
  const skipped = parsed.filter((r) => !r.success).length;
  if (skipped > 0) throw new Error(`${ubolId}: ${String(skipped)} uBOL regex rule(s) outside our DNR schema`);
  const rules = parsed.flatMap((r) => (r.success ? [r.data] : []));
  const queries = rules.flatMap((r) => { const q = queryOf(r); return q ? [q] : []; });
  const { answers } = await resolveRegexes(queries, emptyRegexCache(checker.id), checker);
  return queries.filter((q) => answers.get(queryKey(q))?.isSupported === true).length;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error('usage: oracle:extract <uBOL unpacked dir>');
  const manifest = z.looseObject({ version: z.string() }).parse(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')));
  const details = Details.parse(JSON.parse(await readFile(path.join(dir, 'rulesets/ruleset-details.json'), 'utf8')));
  const checker = chromiumRegexChecker();
  const rulesets: OracleFile['rulesets'] = {};
  const popups: Record<string, number> = {};
  for (const [ours, ubolId] of Object.entries(MAP)) {
    const d = details.find((x) => x.id === ubolId);
    if (!d) throw new Error(`uBOL has no ruleset "${ubolId}"`);
    rulesets[ours] = { ubolId, rules: d.rules.total, regex: d.rules.regex, regexValid: await validRegex(dir, ubolId, checker) };
    if (d.popups !== undefined) popups[ours] = d.popups;
  }
  const file = OracleFileSchema.parse({ schema: 1, ubol: manifest.version, chromium: checker.id, rulesets, popups });
  await writeFile(OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  process.stdout.write(`oracle: uBOL ${file.ubol} → ${OUT}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`oracle:extract failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
