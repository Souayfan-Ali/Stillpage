/** The rules date as the UI shows it (UI notes: "Rules from 13 Nov 2026"); the version codec is `src/core/version.ts`. */
import { rulesDateOf } from '../core/version.js';
import { uiLocale } from './i18n.js';

/** "13 Nov 2026": the rules date in UTC, always day–month–year; undefined when the version has none. */
export function formatRulesDate(version: string, locale = uiLocale()): string | undefined {
  const date = rulesDateOf(version);
  if (date === undefined) return undefined;
  const parts = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}
