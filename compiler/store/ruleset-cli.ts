/**
 * Store CLI pieces shared by the npm `release` CLI (`cli-store.ts`) and the key job's plain-`node` uploader
 * (`uploader/main.ts`, D-71): live and dry-run clients, clocks, the verdict binding and the ruleset publish
 * command. Dependency-free: Node built-ins and relative `.ts` files only (pinned by
 * `tests/unit/compiler/store/uploader.test.ts`), so the job holding the store key runs no npm package.
 *
 * **Dry-run by default**: the recorded-contract fake answers, and the requests a live run would send are
 * printed. `--live` is for the owner only (NEEDS MAINTAINER: S-12, P1-47): it refuses while `store.config.json`
 * holds placeholders or the key-file variable is unset, and has not been run live yet.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { serviceAccountToken, ServiceAccountKeySchema, type ServiceAccountKey } from './auth.ts';
import { createStoreClient, toStoreState, type StoreClient } from './client.ts';
import type { Transport } from './contract.ts';
import { FAKE_ITEM, fakeStore, type FakeScript } from './fake.ts';
import { publishRulesetRelease, type RulesetReleaseResult } from './release.ts';

const CONFIG = path.join(import.meta.dirname, 'store.config.json');
const PLACEHOLDER = 'OWNER_';
const KEY_ENV = /^[A-Z][A-Z0-9_]*$/;
const EXIT: Readonly<Record<RulesetReleaseResult['kind'] | 'manual', number>> = { live: 0, failed: 1, manual: 2, skipped: 5 };

const SCENARIOS: Readonly<Record<string, Omit<FakeScript, 'publishedVersion'>>> = {
  live: { publish: 'live', pollsUntilLive: 1 },
  'stays-in-review': { publish: 'stays-in-review' },
  refused: { publish: 'refused' },
  'pending-full-release': { publish: 'live', pending: { version: '9.9.0.0', state: 'PENDING_REVIEW' } },
};

const REQUEST_TIMEOUT_MS = 120_000;

export const say = (line: string): void => { process.stdout.write(`${line}\n`); };
const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Live `fetch` transport (owner only). Bodies of error answers are parsed, never printed whole. */
const liveTransport: Transport = async (r) => {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(r.body !== undefined && { body: typeof r.body === 'string' ? r.body : new Uint8Array(r.body) }) });
  const text = await res.text();
  let json: unknown;
  try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json };
};

/** Reads the key file; errors never quote it (a JSON syntax error message would). */
async function readKey(file: string): Promise<ServiceAccountKey> {
  try {
    return ServiceAccountKeySchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw new Error('the service-account key file is missing, not JSON, or not a service-account key');
  }
}

/** The verdict (the publish job's recomputed one, D-58c) must say `publish` for exactly these bytes. */
async function checkVerdict(file: string | undefined, zip: Uint8Array): Promise<void> {
  if (file === undefined) throw new Error('--verdict <gate output> is required: a ruleset release is published only after the eligibility gate');
  const v = record(JSON.parse(await readFile(file, 'utf8')));
  if (typeof v['outcome'] !== 'string' || typeof v['candidateSha256'] !== 'string') throw new Error('the gate verdict has no outcome and candidateSha256');
  if (v['outcome'] !== 'publish') throw new Error(`the gate verdict is "${v['outcome']}", not "publish"`);
  if (v['candidateSha256'] !== sha256Hex(zip)) throw new Error('the gate verdict is for another zip');
}

async function liveClient(): Promise<StoreClient> {
  const c = record(JSON.parse(await readFile(CONFIG, 'utf8')));
  const [publisherId, itemId, keyFileEnv] = [c['publisherId'], c['itemId'], c['keyFileEnv']];
  if (typeof publisherId !== 'string' || typeof itemId !== 'string' || typeof keyFileEnv !== 'string' || !KEY_ENV.test(keyFileEnv)) {
    throw new Error(`${CONFIG} needs publisherId, itemId and keyFileEnv`);
  }
  if (publisherId.startsWith(PLACEHOLDER) || itemId.startsWith(PLACEHOLDER)) throw new Error(`live store access needs the owner's ids in ${CONFIG} (NEEDS MAINTAINER)`);
  const keyFile = process.env[keyFileEnv];
  if (keyFile === undefined || keyFile === '') throw new Error(`live store access needs ${keyFileEnv} (path to the service-account key)`);
  const key = await readKey(keyFile);
  return createStoreClient({ publisherId, itemId }, liveTransport, () => serviceAccountToken(key, liveTransport, Date.now));
}

function dryRunClient(published: string, scenario: string, draft?: string): { client: StoreClient; printLog: () => void } {
  const script = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined;
  if (script === undefined) throw new Error(`unknown --fake-scenario ${scenario} (${Object.keys(SCENARIOS).join(', ')})`);
  const fake = fakeStore({ ...script, publishedVersion: published, ...(draft !== undefined && { draft }) });
  const client = createStoreClient(FAKE_ITEM, fake.transport, () => Promise.resolve('dry-run-token'));
  return { client, printLog: () => { for (const l of fake.log) say(`dry-run request: ${l.method} ${l.url}${l.body === undefined ? '' : ` ${JSON.stringify(l.body)}`}`); } };
}

export interface Clock { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> }
export const realClock: Clock = { now: Date.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
/** Dry runs do not wait: sleeping advances a virtual clock, so the 15 / 60 min limits still apply. */
export function virtualClock(): Clock {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve(); } };
}

export const OPTIONS = {
  zip: { type: 'string' }, verdict: { type: 'string' }, live: { type: 'boolean', default: false },
  'fake-published': { type: 'string', default: '0.0.1' }, 'fake-scenario': { type: 'string', default: 'live' },
  'fake-draft': { type: 'string' }, version: { type: 'string' },
} as const;

export async function clientFor(values: { live: boolean; 'fake-published': string; 'fake-scenario': string; 'fake-draft'?: string | undefined }): Promise<{ client: StoreClient; printLog: () => void }> {
  if (values.live) return { client: await liveClient(), printLog: () => undefined };
  say(`dry run: recorded-contract fake (scenario ${values['fake-scenario']}); no request leaves this machine`);
  return dryRunClient(values['fake-published'], values['fake-scenario'], values['fake-draft']);
}

export async function statusCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: OPTIONS });
  const { client, printLog } = await clientFor(values);
  say(JSON.stringify(toStoreState(await client.status())));
  printLog();
}

/** `publish-ruleset --zip <zip> --verdict <verdict.json> [--live] [--fake-published <v>] [--fake-scenario <name>]`; exit 0 live, 1 failed, 2 manual, 5 skipped. */
export async function publishRulesetCommand(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...args], options: OPTIONS });
  if (values.zip === undefined) throw new Error('--zip <candidate zip> is required');
  const zip = new Uint8Array(await readFile(values.zip));
  await checkVerdict(values.verdict, zip);
  const { client, printLog } = await clientFor(values);
  const result = await publishRulesetRelease({ client, ...(values.live ? realClock : virtualClock()), log: say }, zip);
  printLog();
  say(JSON.stringify(result));
  process.exitCode = result.kind === 'failed' && result.manualAction ? EXIT.manual : EXIT[result.kind];
}
