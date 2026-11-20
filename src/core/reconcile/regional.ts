/**
 * Regional pack suggestion (P2-29, ADR-015 item 3): computed locally from the browser's UI language,
 * which the onboarding page passes in (`[chrome.i18n.getUILanguage()]`; an array so it can widen later).
 * The primary subtag decides; `es` and `pt` share one pack. Only packs the catalog of this build has.
 */
import type { PackId } from '../ids.js';

const PACK_OF_LANGUAGE: Readonly<Record<string, string>> = {
  de: 'reg-de',
  it: 'reg-it',
  ja: 'reg-ja',
  nl: 'reg-nl',
  zh: 'reg-zh',
  es: 'reg-es-pt',
  pt: 'reg-es-pt',
};

/** Suggested regional packs for `languages` (BCP-47 tags), de-duplicated, in input order. */
export function suggestRegionalPacks(languages: readonly string[], catalogPacks: readonly PackId[]): readonly PackId[] {
  const available = new Set<string>(catalogPacks);
  const packs = languages
    .map((tag) => tag.split('-')[0]?.toLowerCase() ?? '')
    .filter((primary) => Object.hasOwn(PACK_OF_LANGUAGE, primary))
    .map((primary) => PACK_OF_LANGUAGE[primary] ?? '')
    .filter((pack) => available.has(pack));
  return [...new Set(packs)] as PackId[];
}
