/**
 * `node compiler/store/candidate/main.ts --base <zip> --candidate <zip> --base-sha256 <hex> --out <verdict.json>`
 *
 * The publish job's own verdict (D-58): run with plain `node` (Node ≥ 22.18 strips types) before `npm ci`, so
 * no npm package takes part. Writes `{ outcome, candidateSha256, candidateVersion, baseVersion, problems }` to
 * `--out`, which `publish-ruleset --verdict` then reads; the candidate artefact's own verdict is never read.
 * Exit codes: 0 publish, 1 abort or bad arguments.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkRulesetCandidate } from './check.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    base: { type: 'string' }, candidate: { type: 'string' }, 'base-sha256': { type: 'string' }, out: { type: 'string' } } });
  const { base, candidate, out } = values;
  const expected = values['base-sha256'];
  if (base === undefined || candidate === undefined || expected === undefined || out === undefined) {
    throw new Error('--base, --candidate, --base-sha256 and --out are required');
  }
  const verdict = checkRulesetCandidate({
    base: new Uint8Array(await readFile(base)), candidate: new Uint8Array(await readFile(candidate)), expectedBaseSha256: expected,
  });
  const json = `${JSON.stringify(verdict, null, 1)}\n`;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, json);
  process.stdout.write(json);
  process.exitCode = verdict.outcome === 'publish' ? 0 : 1;
}

main().catch((e: unknown) => {
  process.stderr.write(`candidate check failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
