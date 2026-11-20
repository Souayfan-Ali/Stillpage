/**
 * `chrome.i18n.getMessage` over a `messages.json` catalog, with Chrome's rules (P2-40): named
 * placeholders (`$NAME$`, case-insensitive) resolve to their `content`, then `$1`…`$9` take the
 * substitutions (a missing one is empty), `$$` is a literal `$`, and an unknown key gives "". Used by the
 * unit-test setup and by E2E specs that read English copy in Node.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface CatalogEntry {
  readonly message: string;
  readonly description?: string;
  readonly placeholders?: Readonly<Record<string, { readonly content: string; readonly example?: string }>>;
}
export type Catalog = Readonly<Record<string, CatalogEntry>>;

export interface I18nFake {
  readonly getMessage: (key: string, substitutions?: string | readonly string[]) => string;
  readonly getUILanguage: () => string;
}

const ROOT = path.resolve(import.meta.dirname, '../..');

/** The shipped English catalog. */
export function englishCatalog(): Catalog {
  return JSON.parse(readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8')) as Catalog;
}

function withPlaceholders(entry: CatalogEntry): string {
  const placeholders = Object.fromEntries(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), p.content]));
  return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name: string) => placeholders[name.toLowerCase()] ?? whole);
}

/** Resolves one message as Chrome does. */
export function resolveMessage(catalog: Catalog, key: string, substitutions: string | readonly string[] = []): string {
  const entry = catalog[key];
  if (entry === undefined) return '';
  const subs = typeof substitutions === 'string' ? [substitutions] : substitutions;
  return withPlaceholders(entry).replace(/\$(\$|[1-9])/g, (_whole, ref: string) => (ref === '$' ? '$' : (subs[Number(ref) - 1] ?? '')));
}

export function createI18n(catalog: Catalog, uiLanguage = 'en-GB'): I18nFake {
  return {
    getMessage: (key, substitutions) => resolveMessage(catalog, key, substitutions),
    getUILanguage: () => uiLanguage,
  };
}

/** English copy in Node (E2E specs): the message as the extension shows it. */
export const english = (key: string, ...substitutions: readonly string[]): string => resolveMessage(englishCatalog(), key, substitutions);
