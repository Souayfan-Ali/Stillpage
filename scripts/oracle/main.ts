/**
 * `npx jiti scripts/oracle/main.ts --today YYYY-MM-DD --oracle-failed true|false [--body-file <file>]` (D-40): prints
 * the streak decision as JSON for the daily workflow (dry run there: it echoes what it would do with the PR and issue).
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { decide } from './streak.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { today: { type: 'string' }, 'oracle-failed': { type: 'string' }, 'body-file': { type: 'string' } } });
  if (values.today === undefined || (values['oracle-failed'] !== 'true' && values['oracle-failed'] !== 'false')) {
    throw new Error('--today YYYY-MM-DD and --oracle-failed true|false are required');
  }
  const body = values['body-file'] === undefined ? null : await readFile(values['body-file'], 'utf8').catch(() => null);
  process.stdout.write(`${JSON.stringify(decide(body, values.today, values['oracle-failed'] === 'true'))}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`oracle streak failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
