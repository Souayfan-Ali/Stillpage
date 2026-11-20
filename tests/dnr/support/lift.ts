/**
 * Test extensions for the lift suite (D-55 / D-55a): the shipped default rulesets with some switched off,
 * and the pop-up realm the reconciler builds for them, once without the lift (`popup-lifted.json`
 * empty: exactly the rules of the build before D-55) and once with it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import type { Hostname } from '../../../src/core/ids.js';
import { popupRules, type PopupInputs } from '../../../src/core/reconcile/popups.js';
import type { DnrRule } from '../../../src/core/reconcile/types.js';
import { createDefaultSettings } from '../../../src/core/state/defaults.js';
import type { EpochMs, Settings } from '../../../src/core/state/types.js';
import type { ExtensionSpec, TestRuleset } from './launch.js';

const PUBLIC = path.resolve(import.meta.dirname, '../../../public');
const readJson = (file: string): unknown => JSON.parse(readFileSync(path.join(PUBLIC, file), 'utf8'));
export const NOW = 1_800_000_000_000 as EpochMs;

export const destinations = (): readonly Hostname[] => readJson('popup-destinations.json') as Hostname[];
export const liftedFile = (): Readonly<Record<string, readonly Hostname[]>> => readJson('popup-lifted.json') as Record<string, Hostname[]>;

/** Default settings with one opener site on "Allow pop-ups" (its allow sits at 3, pop-up notes §8). */
export function liftSettings(allowOpener: string): Settings {
  return { ...createDefaultSettings(), popups: { mode: 'off', sites: { [allowOpener]: 'allow' } as Settings['popups']['sites'], notice: true } };
}

export interface Variant {
  readonly name: string;
  /** Default rulesets switched off in this extension. */
  readonly off: readonly string[];
}

export function variantSpec(v: Variant, defaults: readonly TestRuleset[], lifted: boolean): ExtensionSpec {
  return { name: `${v.name}-${lifted ? 'after' : 'before'}`, rulesets: defaults.map((r) => ({ ...r, enabled: !v.off.includes(r.id) })), hostAccess: true };
}

/** The realm rules `popupRules` builds for this variant, with or without the lift. */
export function realmRules(v: Variant, defaults: readonly TestRuleset[], lifted: boolean, extensionId: string, settings: Settings): readonly DnrRule[] {
  const inputs: PopupInputs = {
    destinations: destinations(),
    lifted: lifted ? liftedFile() : {},
    strictSites: [],
    blockedPageUrl: `chrome-extension://${extensionId}/blocked.html`,
    guardShipped: true,
    listStrict: false,
  };
  const enabled = defaults.map((r) => r.id).filter((id) => !v.off.includes(id));
  return popupRules(settings, NOW, inputs, true, enabled);
}

export const extensionIdOf = (w: Worker): string => new URL(w.url()).host;

/** Replaces the worker's dynamic and session rules. */
export async function installRules(w: Worker, dynamic: readonly DnrRule[], session: readonly DnrRule[] = []): Promise<void> {
  await w.evaluate(async ([d, s]) => {
    const dnr = (globalThis as unknown as { chrome: { declarativeNetRequest: {
      getDynamicRules: () => Promise<{ id: number }[]>; getSessionRules: () => Promise<{ id: number }[]>;
      updateDynamicRules: (o: object) => Promise<void>; updateSessionRules: (o: object) => Promise<void>; } } }).chrome.declarativeNetRequest;
    await dnr.updateDynamicRules({ removeRuleIds: (await dnr.getDynamicRules()).map((r) => r.id), addRules: d });
    await dnr.updateSessionRules({ removeRuleIds: (await dnr.getSessionRules()).map((r) => r.id), addRules: s });
  }, [dynamic, session] as const);
}

const HOST_ONLY = /^\|\|([a-z0-9.-]+)\^$/;
const UNCONDITIONAL: ReadonlySet<string> = new Set(['requestDomains', 'resourceTypes', 'urlFilter']);

/** Hosts a badware / urlhaus rule blocks as whole documents (`requestDomains` or `||host^`, nothing else). */
export function malwareDocumentHosts(defaults: readonly TestRuleset[]): ReadonlySet<string> {
  const rules = defaults.filter((r) => r.id === 'badware' || r.id === 'urlhaus').flatMap((r) => r.rules as (DnrRule & { condition: { urlFilter?: string } })[]);
  return new Set(rules.filter((r) => r.action.type === 'block' && (r.condition.resourceTypes ?? []).includes('main_frame')
    && Object.keys(r.condition).every((k) => UNCONDITIONAL.has(k)))
    .flatMap((r) => r.condition.requestDomains ?? (HOST_ONLY.exec(r.condition.urlFilter ?? '')?.slice(1) ?? [])));
}
