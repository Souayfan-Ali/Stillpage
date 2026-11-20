/**
 * `npm run release -- state --candidate <zip> --base-record <file> [--ledger-dir] [--lock] [--counts] [--idmap-dir] [--out dist/release/state]`
 *
 * Writes what a published ruleset release leaves behind (P2-05): the `ruleset-state` commit's files under
 * `<out>/ruleset-state/`, its tag name and message, and the release assets with `SHA256SUMS` under
 * `<out>/assets/`, among them the compiler's id maps as `idmap-<rulesetId>.json` (P2-16: the id-map bot reads them
 * from the release `rules/<version>`). Dry run: nothing is committed, tagged or uploaded here; the workflow does
 * that once live.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PRODUCT_SLUG } from '../../src/core/brand.js';
import { recordOf, ReleaseRecordSchema } from './record.js';
import { encodeVersion } from '../../src/core/version.js';
import { checksums, codeLineOfTag, idmapAssets, rulesetState } from './state.js';
import { checkedStateInputs } from './stateInputs.js';
import { compareWithRecord, zipOfCrx } from './verify.js';

const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** The id-map files in `dir` (regular files only: the directory may come from a workflow artefact). */
async function readIdmapFiles(dir: string): Promise<ReadonlyMap<string, Uint8Array>> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) throw new Error(`no id maps at ${dir} (run lists:build first, or pass --idmap-dir)`);
  const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
  return new Map(await Promise.all(files.map(async (n) => [n, new Uint8Array(await readFile(path.join(dir, n)))] as const)));
}

/** The id maps in `dir` as release assets. Fails closed: the id-map bot needs them (review MEDIUM). */
function idmapReleaseAssets(files: ReadonlyMap<string, Uint8Array>, dir: string): ReadonlyMap<string, Uint8Array> {
  const assets = idmapAssets(files);
  if (assets.size === 0) throw new Error(`no id map files in ${dir}`);
  return assets;
}

async function writeAll(dir: string, files: ReadonlyMap<string, string | Uint8Array>): Promise<void> {
  for (const [name, data] of files) {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
}

export async function stateCommand(args: readonly string[], root: string): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    candidate: { type: 'string' }, 'base-record': { type: 'string' },
    'ledger-dir': { type: 'string', default: path.join(root, 'lists/ledger') }, out: { type: 'string', default: path.join(root, 'dist/release/state') },
    lock: { type: 'string', default: path.join(root, 'lists/lists.lock.json') },
    'idmap-dir': { type: 'string', default: path.join(root, 'dist/compiler/debug/idmap') } } });
  if (values.candidate === undefined || values['base-record'] === undefined) throw new Error('--candidate and --base-record are required');
  const zip = new Uint8Array(await readFile(values.candidate));
  const candidate = recordOf(zip);
  const base = ReleaseRecordSchema.parse(JSON.parse(await readFile(values['base-record'], 'utf8')));
  // Regular files only: the ledger directory may come from a workflow artefact.
  const names = (await readdir(values['ledger-dir'], { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name).sort();
  const ledgers = new Map(await Promise.all(names.map(async (n) => [n.slice(0, -'.json'.length), await readFile(path.join(values['ledger-dir'], n), 'utf8')] as const)));
  // D-71: ledgers and id maps come from the candidate artefact (untrusted): checked against the zip; counts derived from it.
  const idmapFiles = await readIdmapFiles(values['idmap-dir']);
  const { counts } = checkedStateInputs(zip, ledgers, idmapFiles);
  const state = rulesetState({ lock: await readFile(values.lock, 'utf8'), counts, ledgers, candidate, base });
  const zipName = `${PRODUCT_SLUG}-${candidate.version}-chrome.zip`;
  const assets = new Map<string, Uint8Array>([
    [zipName, zip],
    [`${PRODUCT_SLUG}-${candidate.version}.record.json`, new TextEncoder().encode(json(candidate))],
    ...idmapReleaseAssets(idmapFiles, values['idmap-dir']),
  ]);
  await writeAll(path.join(values.out, 'ruleset-state'), state.files);
  await writeAll(path.join(values.out, 'assets'), new Map<string, string | Uint8Array>([...assets, ['SHA256SUMS', checksums(assets)]]));
  await writeFile(path.join(values.out, 'tag.txt'), `${state.tag}\n`);
  await writeFile(path.join(values.out, 'tag-message.txt'), state.message);
  process.stdout.write(`dry run: ruleset-state commit and tag ${state.tag} written to ${values.out} (not committed, not pushed)\n`);
}

/** `release -- version --tag v1.0 [--snapshot <ISO>]`: prints the full-release version (P2-06). */
export async function versionCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { tag: { type: 'string' }, snapshot: { type: 'string' } } });
  if (values.tag === undefined) throw new Error('--tag v<MAJOR>.<MINOR> is required');
  const now = new Date();
  process.stdout.write(`${encodeVersion(codeLineOfTag(values.tag), values.snapshot === undefined ? now : new Date(values.snapshot), now)}\n`);
  return Promise.resolve();
}

/** `release -- assets --zip <zip> --source <zip> --out <dir> [--idmap-dir <dir>]`: release assets, record, id maps and SHA256SUMS (P2-06, P2-16). */
export async function assetsCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { zip: { type: 'string' }, source: { type: 'string' }, out: { type: 'string' }, 'idmap-dir': { type: 'string' } } });
  if (values.zip === undefined || values.source === undefined || values.out === undefined) throw new Error('--zip, --source and --out are required');
  const zip = new Uint8Array(await readFile(values.zip));
  const record = recordOf(zip);
  const assets = new Map<string, Uint8Array>([
    [`${PRODUCT_SLUG}-${record.version}-chrome.zip`, zip],
    [`${PRODUCT_SLUG}-${record.version}-source.zip`, new Uint8Array(await readFile(values.source))],
    [`${PRODUCT_SLUG}-${record.version}.record.json`, new TextEncoder().encode(json(record))],
    ...(values['idmap-dir'] === undefined ? [] : idmapReleaseAssets(await readIdmapFiles(values['idmap-dir']), values['idmap-dir'])),
  ]);
  await writeAll(values.out, new Map<string, string | Uint8Array>([...assets, ['SHA256SUMS', checksums(assets)]]));
  process.stdout.write(`assets for ${record.version} written to ${values.out}\n`);
}

/**
 * `release -- verify-store --crx <published.crx> --zip <release zip> --record <record> [--issue <file>]` (P2-07):
 * exit 0 when the published package matches the record, 1 otherwise (and the issue body is written).
 */
export async function verifyStoreCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { crx: { type: 'string' }, zip: { type: 'string' }, record: { type: 'string' }, issue: { type: 'string' } } });
  if (values.crx === undefined || values.zip === undefined || values.record === undefined) throw new Error('--crx, --zip and --record are required');
  const record = ReleaseRecordSchema.parse(JSON.parse(await readFile(values.record, 'utf8')));
  const result = compareWithRecord(record, new Uint8Array(await readFile(values.zip)), zipOfCrx(new Uint8Array(await readFile(values.crx))));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.match) return;
  if (values.issue !== undefined) {
    await writeFile(values.issue, `The package the store serves for ${record.version} differs from its release record (zip ${record.zipSha256}).\n\n${result.problems.map((p) => `- ${p}`).join('\n')}\n`);
  }
  process.exitCode = 1;
}
