/**
 * `npm run release -- repack --base <zip> [--rulesets-dir public] [--snapshot <ISO time>] [--out <dir>]`
 *
 * Candidate for a ruleset release (P2-01): every safe ruleset the base declares is read from
 * `<rulesets-dir>/<path>` (the output of `npm run lists:build`), the version is the base's code line plus
 * the snapshot's day and UTC time, and the candidate zip and its release record are written to `--out`.
 * `npm run release -- record --zip <zip> [--out <file>]` writes the record of an existing zip (the base).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PRODUCT_SLUG } from '../../src/core/brand.js';
import { encodeVersion } from '../../src/core/version.js';
import { manifestOf } from './manifest.js';
import { recordOf } from './record.js';
import { repack, safeRulesetPaths } from './repack.js';
import { readZip } from './zip.js';

const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const json = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;

/** `MAJOR.MINOR` of a base version (`0.0.1` → 0.0). */
function codeLineOf(version: string): { major: number; minor: number } {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return { major, minor };
}

export async function repackCommand(args: readonly string[], root: string): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: {
    base: { type: 'string' }, 'rulesets-dir': { type: 'string', default: path.join(root, 'public') },
    snapshot: { type: 'string' }, out: { type: 'string', default: path.join(root, 'dist/release') } } });
  if (values.base === undefined) throw new Error('--base <zip> is required');
  const base = new Uint8Array(await readFile(values.base));
  const now = new Date();
  const snapshot = values.snapshot === undefined ? now : new Date(values.snapshot);
  const version = encodeVersion(codeLineOf(manifestOf(readZip(base)).version), snapshot, now);
  const paths = safeRulesetPaths(base);
  const dir = path.resolve(values['rulesets-dir']);
  const inside = (p: string): string => {
    const file = path.resolve(dir, p);
    if (!file.startsWith(`${dir}${path.sep}`)) throw new Error(`ruleset path ${p} leaves ${dir}`);
    return file;
  };
  const rulesets = new Map(await Promise.all(paths.map(async (p) => [p, new Uint8Array(await readFile(inside(p)))] as const)));
  const candidate = repack({ base, rulesets, version });
  const name = `${PRODUCT_SLUG}-${version}-chrome`;
  await mkdir(values.out, { recursive: true });
  await writeFile(path.join(values.out, `${name}.zip`), candidate);
  await writeFile(path.join(values.out, `${name}.record.json`), json(recordOf(candidate)));
  say(`repacked ${values.base} → ${path.join(values.out, `${name}.zip`)} (${String(paths.length)} safe rulesets offered)`);
}

export async function recordCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: { zip: { type: 'string' }, out: { type: 'string' } } });
  if (values.zip === undefined) throw new Error('--zip <zip> is required');
  const text = json(recordOf(new Uint8Array(await readFile(values.zip))));
  if (values.out === undefined) say(text.trimEnd());
  else await writeFile(values.out, text);
}
