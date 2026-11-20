/**
 * `npm run release -- <command> …` — release tooling (update-strategy notes §3, P2-01…P2-04). Local and dry-run only for
 * now: nothing here publishes unless a later, owner-enabled step passes live credentials.
 * Commands: `record`, `repack`, `gate`, `state`, `version`, `assets`, `verify-store`, `match`, `drill-bad-rule`, `status`, `publish-ruleset`, `upload-full`, `submit-full` (store commands dry-run by default).
 */
import path from 'node:path';
import { gateCommand } from './cli-gate.js';
import { publishRulesetCommand, statusCommand, submitFullCommand, uploadFullCommand } from '../store/cli-store.js';
import { liftDriftCommand } from './cli-lift.js';
import { drillBadRuleCommand, matchCommand } from './cli-match.js';
import { recordCommand, repackCommand } from './cli-repack.js';
import { assetsCommand, stateCommand, verifyStoreCommand, versionCommand } from './cli-state.js';
import { errorText } from '../cli/errors.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

const COMMANDS: Readonly<Record<string, (args: readonly string[]) => Promise<void>>> = {
  record: (args) => recordCommand(args),
  repack: (args) => repackCommand(args, ROOT),
  gate: (args) => gateCommand(args, ROOT),
  state: (args) => stateCommand(args, ROOT),
  version: (args) => versionCommand(args),
  assets: (args) => assetsCommand(args),
  'verify-store': (args) => verifyStoreCommand(args),
  match: (args) => matchCommand(args),
  'drill-bad-rule': (args) => drillBadRuleCommand(args),
  'lift-drift': (args) => liftDriftCommand(args),
  status: (args) => statusCommand(args),
  'publish-ruleset': (args) => publishRulesetCommand(args),
  'upload-full': (args) => uploadFullCommand(args),
  'submit-full': (args) => submitFullCommand(args),
};

async function main(): Promise<void> {
  const [name = '', ...args] = process.argv.slice(2);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) throw new Error(`usage: npm run release -- <${Object.keys(COMMANDS).join('|')}> …`);
  await command(args);
}

main().catch((e: unknown) => {
  process.stderr.write(`release failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
