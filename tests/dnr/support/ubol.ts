/**
 * uBO Lite's published release as the oracle (ADR-004, filter-pipeline notes §11): the unpacked build in the cache
 * (`.cache/spikes/ubol/unpacked`, release 2026.1110.1816, downloaded and hash-checked by
 * `scripts/fetch-ubol.sh`, `npm run oracle:fetch`; never an input to our build). Loaded as it runs:
 * its static rulesets plus the dynamic (regex) and session (strict-block) rules its worker registers at
 * start; `pgl` (Peter Lowe's list) is turned off because we exclude that list (Q-02).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import type { PrebuiltExtension } from './launch.js';

const UBOL_DIR = path.resolve(import.meta.dirname, '../../../.cache/spikes/ubol/unpacked');
/** Rulesets of uBOL's default configuration that have no counterpart in ours. */
const EXCLUDED = ['pgl'];
const SETTLE_TIMEOUT_MS = 20_000;
/** Poll interval; uBOL's rule counts must agree over `SETTLE_ROUNDS` consecutive polls. */
const SETTLE_POLL_MS = 1_000;
const SETTLE_ROUNDS = 3;

interface Resource {
  readonly id: string;
  readonly enabled: boolean;
  readonly path: string;
}

export interface UbolRelease {
  readonly extension: PrebuiltExtension;
  readonly version: string;
  /** Default-enabled static rulesets we compare against, with their rules. */
  readonly rulesets: readonly { readonly id: string; readonly rules: readonly object[] }[];
}

export function ubolRelease(): UbolRelease {
  const manifestFile = path.join(UBOL_DIR, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`uBOL release not found in ${UBOL_DIR} (run npm run oracle:fetch)`);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    version: string;
    declarative_net_request: { rule_resources: Resource[] };
  };
  const rulesets = manifest.declarative_net_request.rule_resources
    .filter((r) => r.enabled && !EXCLUDED.includes(r.id))
    .map((r) => ({ id: r.id, rules: JSON.parse(readFileSync(path.join(UBOL_DIR, r.path), 'utf8')) as object[] }));
  return { extension: { name: 'ubol', dir: UBOL_DIR }, version: manifest.version, rulesets };
}

interface UbolDnr {
  getDynamicRules(): Promise<object[]>;
  getSessionRules(): Promise<object[]>;
  updateEnabledRulesets(o: { disableRulesetIds: string[] }): Promise<void>;
  getEnabledRulesets(): Promise<string[]>;
}

/**
 * Waits until uBOL's worker has registered its dynamic and session rules (counts stable over two
 * polls), turns `pgl` off, and returns those rules as rulesets `_dynamic` and `_session` (the ids
 * `testMatchOutcome` reports for them).
 */
export async function settleUbol(worker: Worker): Promise<readonly { readonly id: string; readonly rules: readonly object[] }[]> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  const seen: string[] = [];
  while (seen.length < SETTLE_ROUNDS || new Set(seen.slice(-SETTLE_ROUNDS)).size > 1) {
    if (Date.now() > deadline) throw new Error(`uBOL did not settle (rule counts ${seen.join(', ')})`);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    seen.push(
      await worker.evaluate(async () => {
        const d = (globalThis as unknown as { chrome: { declarativeNetRequest: UbolDnr } }).chrome.declarativeNetRequest;
        return `${String((await d.getDynamicRules()).length)}/${String((await d.getSessionRules()).length)}`;
      }),
    );
  }
  return worker.evaluate(async (excluded) => {
    const d = (globalThis as unknown as { chrome: { declarativeNetRequest: UbolDnr } }).chrome.declarativeNetRequest;
    await d.updateEnabledRulesets({ disableRulesetIds: excluded });
    const still = (await d.getEnabledRulesets()).filter((id) => excluded.includes(id));
    if (still.length > 0) throw new Error(`uBOL kept ${still.join(', ')} enabled`);
    return [
      { id: '_dynamic', rules: await d.getDynamicRules() },
      { id: '_session', rules: await d.getSessionRules() },
    ];
  }, EXCLUDED);
}
