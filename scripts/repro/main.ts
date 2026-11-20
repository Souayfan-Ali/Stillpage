/**
 * `npm run repro -- [--second container|local] [--keep] [--out <dir>]`
 *
 * Reproducible-build gate (P2-48, tooling notes §8, security notes §8): two clean checkouts of `HEAD` (`git archive`),
 * each with every file's mtime set to a different date, built from the same lock files, list cache and
 * vendored resources — `npm ci`, `lists:build`, `build`, `zip`. The first builds here (TZ UTC); the
 * second in a `node:22-bookworm-slim` container (TZ Asia/Tokyo, other locale and umask; `npm ci` with
 * network, the build itself with `--network none`), standing in for the second machine
 * (`--second local` builds it here with the same variations). Compares `public/` and the unpacked
 * extension file by file, text and binary, and the zips; prints the published tree digest; fails if
 * anything differs or the production build carries the log-only path. Never writes into this checkout.
 */
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { diffTrees, forbiddenMarkers, hashTree, treeDigest, type TreeDiff } from './compare.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** Inputs that are not in git: hash-checked against `lists.lock.json` / `vendor.lock.json` by the build. */
const INPUTS = ['.cache/lists', '.cache/regex', 'vendor/resources'];
const IMAGE = 'node:22-bookworm-slim';
const DATES = { first: new Date('2026-01-02T03:04:05Z'), second: new Date('2026-11-13T23:59:59Z') };
const BUILD = 'npm run -s lists:build -- --no-chromium-load && npm run -s build && npm run -s zip';
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function touchAll(dir: string, when: Date): Promise<void> {
  const entries = await readdir(dir, { recursive: true });
  await Promise.all(entries.map((rel) => utimes(path.join(dir, rel), when, when)));
}

/** A clean checkout of HEAD plus the build inputs git does not hold, every mtime set to `when`. */
async function checkout(dir: string, when: Date): Promise<void> {
  await mkdir(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive --format=tar HEAD | tar -x -C "${dir}"`]);
  for (const input of INPUTS) await cp(path.join(ROOT, input), path.join(dir, input), { recursive: true });
  await touchAll(dir, when);
}

function run(dir: string, command: string, env: NodeJS.ProcessEnv): void {
  const options: ExecFileSyncOptions = { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] };
  execFileSync('sh', ['-c', command], options);
}

function buildInContainer(dir: string): void {
  const { uid, gid } = userInfo();
  const docker = (network: string[], command: string): void => {
    execFileSync('docker', ['run', '--rm', ...network, '--user', `${String(uid)}:${String(gid)}`, '-e', 'HOME=/tmp', '-e', 'TZ=Asia/Tokyo', '-e', 'LANG=C.UTF-8',
      '-v', `${dir}:/work`, '-w', '/work', IMAGE, 'sh', '-c', `umask 077 && ${command}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  };
  docker([], 'npm ci --no-audit --no-fund');
  docker(['--network', 'none'], BUILD);
}

async function zipHash(dir: string): Promise<string> {
  const out = path.join(dir, '.output');
  const zip = (await readdir(out)).find((n) => n.endsWith('-chrome.zip'));
  if (zip === undefined) throw new Error(`no zip in ${out}`);
  return createHash('sha256').update(await readFile(path.join(out, zip))).digest('hex');
}

const empty = (d: TreeDiff): boolean => d.differ.length + d.onlyA.length + d.onlyB.length === 0;

interface Side {
  readonly publicTree: ReadonlyMap<string, string>;
  readonly unpacked: ReadonlyMap<string, string>;
  readonly zip: string;
}

async function measure(dir: string): Promise<Side> {
  return { publicTree: await hashTree(path.join(dir, 'public')), unpacked: await hashTree(path.join(dir, '.output/chrome-mv3')), zip: await zipHash(dir) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { second: { type: 'string', default: 'container' }, keep: { type: 'boolean', default: false }, out: { type: 'string', default: path.join(ROOT, 'dist/repro') } } });
  if (values.second !== 'container' && values.second !== 'local') throw new Error('--second must be container or local');
  const work = await mkdtemp(path.join(tmpdir(), 'glassmere-repro-'));
  const [a, b] = [path.join(work, 'a'), path.join(work, 'b')];
  try {
    await Promise.all([checkout(a, DATES.first), checkout(b, DATES.second)]);
    run(a, `npm ci --prefer-offline --no-audit --no-fund && ${BUILD}`, { TZ: 'UTC' });
    say('first build done (here)');
    if (values.second === 'container') buildInContainer(b);
    else run(b, `umask 077 && npm ci --prefer-offline --no-audit --no-fund && ${BUILD}`, { TZ: 'Asia/Tokyo', LANG: 'C.UTF-8' });
    say(`second build done (${values.second})`);
    const [x, y] = [await measure(a), await measure(b)];
    const publicDiff = diffTrees(x.publicTree, y.publicTree);
    const unpackedDiff = diffTrees(x.unpacked, y.unpacked);
    const markers = await forbiddenMarkers(path.join(a, '.output/chrome-mv3'));
    const digest = treeDigest(x.unpacked);
    const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = { commit, second: values.second, image: values.second === 'container' ? IMAGE : null, publicFiles: x.publicTree.size, unpackedFiles: x.unpacked.size,
      binaryFiles: [...x.publicTree.keys()].filter((f) => f.startsWith('surrogates/') && !/\.(?:js|html|txt|json|css|xml)$/.test(f)).length,
      publicDiff, unpackedDiff, zip: { first: x.zip, second: y.zip }, unpackedTreeSha256: digest.sha256, forbiddenMarkers: markers };
    await mkdir(values.out, { recursive: true });
    await writeFile(path.join(values.out, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
    await writeFile(path.join(values.out, 'SHA256SUMS'), digest.manifest);
    say(JSON.stringify({ ...result, publicDiff: empty(publicDiff) ? 'identical' : publicDiff, unpackedDiff: empty(unpackedDiff) ? 'identical' : unpackedDiff }, null, 1));
    const ok = empty(publicDiff) && empty(unpackedDiff) && x.zip === y.zip && markers.length === 0;
    say(ok ? `REPRODUCIBLE: unpacked tree ${digest.sha256}, zip ${x.zip}` : 'NOT REPRODUCIBLE (or log-only marker in the production build)');
    if (!ok) process.exitCode = 1;
  } finally {
    if (values.keep) say(`kept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`repro failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
