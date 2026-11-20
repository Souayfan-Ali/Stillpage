/**
 * The breakage report (P2-15, UI notes §6): the text the user reviews and edits before anything is
 * sent. What we generate names the **hostname only** — never a path, query, fragment or full address
 * (design review, P2-15: that is the guarantee; what the user types goes out as typed, the preview is the
 * consent). Sending is opening a prefilled new-issue page in a new tab; the extension makes no request.
 */
import type { Complaint, Outcome, Remedy } from '../breakage/types.js';
import { parseHostname } from '../hostname/validate.js';
import { parsePackId } from '../ids.js';
import type { Level } from '../state/types.js';

/** The editable preview's length cap. */
export const MAX_REPORT_CHARS = 4_000;
/** The whole new-issue URL, after percent-encoding (design review: measure the encoded URL). */
export const MAX_ISSUE_URL_BYTES = 8_000;
const MAX_RULES = 20;
const PASTE_BODY = 'Paste the report here: it was copied to your clipboard.';
const RULESET = /^(?:_dynamic|_session|[a-z0-9][a-z0-9-]{0,63})$/;

export interface ReportInput {
  readonly host: string;
  readonly complaint: Complaint;
  readonly outcomes: readonly Outcome[];
  readonly fixedBy: Remedy | null;
  readonly version: string;
  /** Chrome's major version, `null` when unknown. */
  readonly chromeMajor: number | null;
  readonly level: Level;
  readonly packs: readonly string[];
  readonly rules: readonly { readonly rulesetId: string; readonly ruleId: number }[];
  readonly moreRules: number;
  readonly popupMode: 'off' | 'smart' | 'strict';
  /** Blocks and their codes from the page's sentinel (P2-62); `null` without one. Never destination hosts. */
  readonly popups: { readonly blocked: number; readonly codes: readonly string[] } | null;
  readonly access: 'all' | 'site' | 'none';
}

const PROBLEMS: Readonly<Record<Complaint, string>> = {
  broken: 'the page looks broken',
  adThrough: 'an ad or banner got through',
  antiAdblock: 'the site says I use an ad blocker',
  popupOpened: 'an ad opened in a new tab or window',
};

const TRIED: Readonly<Record<Remedy, string>> = {
  allowPopups: 'allowing pop-ups',
  light: 'Light mode',
  off: 'Off on this site',
  reload: 'reloading',
  picker: 'hiding it',
  thorough: 'Thorough here',
  pause: 'a 30-minute pause',
  strictPopups: 'Strict pop-ups',
};

const LEVEL_NAMES: Readonly<Record<Level, string>> = { off: 'Off', light: 'Light', standard: 'Standard', thorough: 'Thorough' };
const ACCESS: Readonly<Record<ReportInput['access'], string>> = { all: 'all sites', site: 'this site only', none: 'none (Light mode)' };

/** The hostname as given when it is exactly a canonical hostname; anything else is left out. */
const siteOf = (host: string): string => (parseHostname(host) === host ? host : '(not included)');

function problemLine(input: ReportInput): string {
  const tried = input.outcomes.filter((o) => o.result === 'still-broken').map((o) => `${TRIED[o.remedy]} (still broken)`);
  const parts = [PROBLEMS[input.complaint], ...(tried.length > 0 ? [`tried: ${tried.join(', ')}`] : []), ...(input.fixedBy === null ? [] : [`fixed by: ${TRIED[input.fixedBy]}`])];
  return `Problem: ${parts.join(' · ')}`;
}

function rulesLine(input: ReportInput): string {
  const valid = input.rules.filter((r) => RULESET.test(r.rulesetId) && Number.isSafeInteger(r.ruleId) && r.ruleId > 0);
  const shown = valid.slice(0, MAX_RULES).map((r) => `${r.rulesetId}#${String(r.ruleId)}`);
  const more = valid.length - shown.length + Math.max(0, Math.floor(input.moreRules));
  if (shown.length === 0) return 'Matched rules: none';
  return `Matched rules: ${shown.join(', ')}${more > 0 ? ` (+${String(more)})` : ''}`;
}

const CODE = /^(?:G(?:[1-9]|1[0-3])|TU|D)$/;

/** "Pop-ups: smart · blocked 2 (G11, G9)": mode, count and codes; destination hosts only if the user types them. */
function popupsLine(input: ReportInput): string {
  if (input.popups === null) return `Pop-ups: ${input.popupMode}`;
  const codes = input.popups.codes.filter((c) => CODE.test(c));
  const count = Math.max(0, Math.floor(input.popups.blocked));
  return `Pop-ups: ${input.popupMode} · blocked ${String(count)}${codes.length > 0 ? ` (${codes.join(', ')})` : ''}`;
}

/** The generated report text (the user may edit it before sending). */
export function buildReport(input: ReportInput): string {
  const packs = input.packs.filter((p) => parsePackId(p) === p).join(', ');
  const chrome = input.chromeMajor === null ? 'Chrome unknown' : `Chrome ${String(input.chromeMajor)}`;
  const version = /^[0-9.]{1,23}$/.test(input.version) ? input.version : 'unknown';
  const text = [
    `Site: ${siteOf(input.host)} (path and query are never included)`,
    problemLine(input),
    `Version: ${version} · ${chrome} · level: ${LEVEL_NAMES[input.level]} · packs: ${packs === '' ? 'none' : packs}`,
    rulesLine(input),
    popupsLine(input),
    `Site access: ${ACCESS[input.access]}`,
  ].join('\n');
  return text.slice(0, MAX_REPORT_CHARS);
}

/** The issue title: the problem and the hostname. */
export function reportTitle(input: Pick<ReportInput, 'host' | 'complaint'>): string {
  const problem = PROBLEMS[input.complaint];
  return `${problem.charAt(0).toUpperCase()}${problem.slice(1)}: ${siteOf(input.host)}`;
}

/**
 * GitHub issue forms prefill a field by its id, not `body` (security review LOW): the form's report
 * field is `report` (`.github/ISSUE_TEMPLATE/breakage.yml`).
 */
function urlOf(tracker: string, title: string, body: string): string {
  const query = new URLSearchParams({ template: 'breakage.yml', title, report: body });
  return `${tracker}/issues/new?${query.toString()}`;
}

/**
 * The prefilled new-issue URL for a validated tracker (`trackerOf`). When the encoded URL would pass
 * the cap, the body asks the user to paste the report, which the caller copies first (`truncated`).
 */
export function issueUrl(tracker: string, title: string, body: string): { readonly url: string; readonly truncated: boolean } {
  const full = urlOf(tracker, title, body);
  if (new TextEncoder().encode(full).length <= MAX_ISSUE_URL_BYTES) return { url: full, truncated: false };
  return { url: urlOf(tracker, title.slice(0, 200), PASTE_BODY), truncated: true };
}
