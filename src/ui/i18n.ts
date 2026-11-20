/**
 * The pages' copy (P2-40, UI notes §10): every user-visible string is a message of
 * `_locales/<lang>/messages.json`, read through `chrome.i18n` (synchronous, no worker involved). The
 * catalog also names its own language and direction (`meta_lang`, `meta_dir`), so `lang`, `dir` and
 * `Intl` follow the catalog Chrome picked, not the browser's UI language. Only the type of the English
 * catalog is imported: the text itself never enters a bundle.
 */
import type catalog from '../../_locales/en/messages.json';

export type MessageKey = keyof typeof catalog;

interface I18nApi {
  readonly getMessage: (key: string, substitutions?: string[]) => string;
}

/** Looked up per call: unit tests install it, and Node (E2E specs importing copy modules) has none. */
const api = (): I18nApi | undefined => (globalThis as { chrome?: { i18n?: I18nApi } }).chrome?.i18n;

/** Language of the catalog when none can be read. */
const FALLBACK_LOCALE = 'en';

/**
 * The message `key` with its substitutions (`$1`…`$9`, in the order the English message names them).
 * A missing message shows its key: visible in review, and the catalog test fails on it first.
 */
export function t(key: MessageKey, ...substitutions: readonly string[]): string {
  const text = api()?.getMessage(key, [...substitutions]) ?? '';
  return text === '' ? key : text;
}

/** BCP 47 tag of the catalog in use. */
export function uiLocale(): string {
  const tag = api()?.getMessage('meta_lang') ?? '';
  return tag === '' ? FALLBACK_LOCALE : tag;
}

export const uiDirection = (): 'ltr' | 'rtl' => (api()?.getMessage('meta_dir') === 'rtl' ? 'rtl' : 'ltr');

/** Sets `lang` and `dir` on the page root (UI notes §9: "lang set per locale; RTL via logical CSS"). */
export function applyDocumentLocale(doc: Document): void {
  doc.documentElement.lang = uiLocale();
  doc.documentElement.dir = uiDirection();
}

export const formatNumber = (n: number): string => new Intl.NumberFormat(uiLocale()).format(n);

/** Hours and minutes of `at` (epoch ms) in local time. */
export const formatTime = (at: number): string => new Intl.DateTimeFormat(uiLocale(), { hour: '2-digit', minute: '2-digit' }).format(at);

/** The `one` or `other` key for `n` by the catalog locale's plural rule. */
export const pluralKey = (n: number, one: MessageKey, other: MessageKey): MessageKey =>
  new Intl.PluralRules(uiLocale()).select(n) === 'one' ? one : other;

/** The plural message for `n`, with `n` formatted as its one substitution. */
export const plural = (n: number, one: MessageKey, other: MessageKey): string => t(pluralKey(n, one, other), formatNumber(n));
