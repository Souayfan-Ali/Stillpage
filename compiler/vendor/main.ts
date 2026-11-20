/**
 * `npm run vendor:fetch [-- --from <uBO checkout>]` — fills `vendor/resources/` from the lock, each
 * file hash-checked. Without `--from` the files come from GitHub at the locked commit.
 * `npm run vendor:fetch -- --pin <commit> --from <checkout> [--add <path> …]` re-pins the lock (a
 * reviewed code change, tooling notes §9) and prints which files changed.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { COMMIT_PATTERN } from '../config/schema.js';
import { serialiseVendorLock } from './lock.js';
import { checkoutSource, loadVendorLock, networkSource, VENDOR_LOCK_FILE, vendorPorts } from './node-ports.js';
import { pinVendor, syncVendor } from './sync.js';
import { errorText } from '../cli/errors.js';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { from: { type: 'string' }, pin: { type: 'string' }, add: { type: 'string', multiple: true, default: [] } } });
  const lock = await loadVendorLock();
  const source = values.from === undefined ? networkSource(lock.repo) : checkoutSource(values.from);
  if (values.pin !== undefined) {
    if (!COMMIT_PATTERN.test(values.pin) || values.from === undefined) throw new Error('--pin needs a 40-hex commit and --from <checkout>');
    const next = await pinVendor(lock, values.pin, [...Object.keys(lock.files), ...values.add], vendorPorts(source));
    const changed = Object.keys(next.files).filter((f) => next.files[f] !== lock.files[f]);
    await writeFile(VENDOR_LOCK_FILE, serialiseVendorLock(next), 'utf8');
    say(`vendor.lock.json pinned to ${next.commit}; changed or new: ${changed.join(', ') || 'none'}`);
  }
  const result = await syncVendor(await loadVendorLock(), vendorPorts(source));
  say(`vendor: ${String(result.present.length)} present, fetched: ${result.fetched.length === 0 ? 'none' : String(result.fetched.length)}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`vendor:fetch failed: ${errorText(e)}\n`);
  process.exitCode = 1;
});
