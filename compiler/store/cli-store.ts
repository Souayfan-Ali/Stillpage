/**
 * `npm run release -- status [--live] [--fake-published <v>]`
 * `npm run release -- publish-ruleset --zip <zip> --verdict <gate output> [--live] [--fake-published <v>] [--fake-scenario <name>]`
 *
 * `npm run release -- upload-full --zip <zip>` / `submit-full --zip <zip> --version <v>` (P2-06, full release in two steps).
 *
 * Store commands (P2-04). **Dry-run by default** (see `ruleset-cli.ts`, which holds the clients and the ruleset
 * publish command shared with the key job's dependency-free uploader, D-71). The full-release path still runs
 * under `npm ci`: making it dependency-free too is a go-live task (D-71).
 * Exit codes: 0 live (or status printed), 1 failed, 2 failed — manual action required, 5 skipped.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { submitFullRelease, uploadFullRelease, type FullReleaseResult } from './full.js';
import { clientFor, OPTIONS, realClock, say, virtualClock } from './ruleset-cli.js';

export { publishRulesetCommand, statusCommand } from './ruleset-cli.js';

const FULL_EXIT: Readonly<Record<FullReleaseResult['kind'], number>> = { uploaded: 0, submitted: 0, failed: 2, refused: 1 };

/** Full release, step 1 (P2-06): upload the zip as a draft. */
export async function uploadFullCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: OPTIONS });
  if (values.zip === undefined) throw new Error('--zip <release zip> is required');
  const { client, printLog } = await clientFor(values);
  const result = await uploadFullRelease({ client, ...(values.live ? realClock : virtualClock()), log: say }, new Uint8Array(await readFile(values.zip)));
  printLog();
  say(JSON.stringify(result));
  process.exitCode = FULL_EXIT[result.kind];
}

/** Full release, step 2 (P2-06), after the approval: upload the approved `--zip` again and submit it for standard review. */
export async function submitFullCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: OPTIONS });
  if (values.version === undefined || values.zip === undefined) throw new Error('--zip <approved zip> and --version <approved version> are required');
  const zip = new Uint8Array(await readFile(values.zip));
  const { client, printLog } = await clientFor(values);
  const result = await submitFullRelease({ client, ...(values.live ? realClock : virtualClock()), log: say }, zip, values.version);
  printLog();
  say(JSON.stringify(result));
  process.exitCode = FULL_EXIT[result.kind];
}
