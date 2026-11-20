/**
 * Pseudo-locales for layout tests (P2-40, UI notes §10): made from the English catalog at test time, never
 * shipped (`_locales` holds English only; `tests/unit/repo/locales.test.ts`).
 *
 * - `long` (like Chrome's en-XA): every letter accented, `[` … `]` around each message so a clipped end
 *   shows, and at least 40 % more characters.
 * - `rtl` (like Chrome's ar-XB): each word forced right-to-left, the catalog's direction `rtl`, so the
 *   pages lay out as they would in Arabic or Hebrew.
 *
 * Placeholders (`$NAME$`) and `$$` are kept as they are: substitutions are data (host names, counts). The
 * manifest's messages stay English: Chrome checks their length when it loads the extension.
 */
import type { Catalog, CatalogEntry } from './chromeI18n.js';

export type PseudoLocale = 'long' | 'rtl';

/** UI notes §10: "a pseudo-locale with 40 % longer strings". */
export const EXPANSION = 0.4;
const KEEP = new Set(['ext_description', 'command_hide_element']);
const META: Readonly<Record<PseudoLocale, { readonly lang: string; readonly dir: string }>> = {
  long: { lang: 'en-XA', dir: 'ltr' },
  rtl: { lang: 'ar', dir: 'rtl' },
};
const TOKEN = /(\$[A-Za-z0-9_]+\$|\$\$)/;
const PLAIN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCENTED = 'áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ';
const FILLER = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const RLO = '‮';
const PDF = '‬';

/** Code points of `text` (the accented letters are all single code points). */
const chars = (text: string): readonly string[] => Array.from(text);
const ACCENTED_CHARS = chars(ACCENTED);

const accent = (text: string): string => chars(text).map((ch) => {
  const i = PLAIN.indexOf(ch);
  return i < 0 ? ch : (ACCENTED_CHARS[i] ?? ch);
}).join('');

/** Applies `fn` to the text between placeholders. */
const outsideTokens = (message: string, fn: (text: string) => string): string =>
  message.split(TOKEN).map((part) => (TOKEN.test(part) ? part : fn(part))).join('');

/** Visible length of a message without its placeholders. */
export const textLength = (message: string): number => chars(message.split(TOKEN).filter((p) => !TOKEN.test(p)).join('')).length;

function padding(length: number): string {
  const words: string[] = [];
  for (let i = 0; words.join(' ').length < Math.ceil(length * EXPANSION); i += 1) words.push(FILLER[i % FILLER.length] ?? '');
  return words.join(' ');
}

function longMessage(message: string): string {
  return `[${outsideTokens(message, accent)} ${accent(padding(textLength(message)))}]`;
}

const rtlMessage = (message: string): string => outsideTokens(message, (text) => text.replace(/[^\s]+/g, (word) => `${RLO}${word}${PDF}`));

function transform(locale: PseudoLocale, key: string, entry: CatalogEntry): CatalogEntry {
  if (key === 'meta_lang') return { ...entry, message: META[locale].lang };
  if (key === 'meta_dir') return { ...entry, message: META[locale].dir };
  if (KEEP.has(key)) return entry;
  return { ...entry, message: locale === 'long' ? longMessage(entry.message) : rtlMessage(entry.message) };
}

/** The pseudo-locale catalog made from `catalog` (a new object; the input is not changed). */
export function pseudoCatalog(catalog: Catalog, locale: PseudoLocale): Catalog {
  return Object.fromEntries(Object.entries(catalog).map(([key, entry]) => [key, transform(locale, key, entry)]));
}
