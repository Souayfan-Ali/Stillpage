/**
 * `node compiler/store/uploader/main.ts --zip <checked zip> --verdict dist/publish/verdict.json [--live] [--fake-published <v>]`
 *
 * The key job's ruleset uploader (D-71): the same `publish-ruleset` command as the npm `release` CLI, run with
 * plain `node` (Node ≥ 22.18 strips types) and no `npm ci`, so no npm package shares a process tree with the
 * store key. Exit codes as `publish-ruleset`: 0 live, 1 failed or bad arguments, 2 manual action, 5 skipped.
 */
import { publishRulesetCommand } from '../ruleset-cli.ts';

publishRulesetCommand(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`publish-ruleset failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
