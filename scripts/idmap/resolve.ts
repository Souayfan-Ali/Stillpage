/**
 * Id-resolution bot, pure part (P2-16, filter-pipeline notes §10, ADR-011): reads a breakage report from an issue
 * body, resolves its `ruleset#id` tokens through that version's id maps, and writes one comment with
 * the source filters, plus an `upstream:<project>` label when every resolved filter comes from one
 * upstream project. Everything in the issue body and in the filter text is untrusted (design review, P2-16):
 * strict regexes, capped counts, no `@` mentions, fences longer than any backtick run, labels from a
 * fixed allowlist only.
 */

/** Hidden marker of our one comment per issue; an edit updates it instead of posting again. */
export const COMMENT_MARKER = '<!-- glassmere-idmap -->';
export const MAX_REFS = 30;
const MAX_FILTER_CHARS = 300;
const MAX_FILTERS_PER_RULE = 5;
const MAX_COMMENT_CHARS = 60_000;
const MAX_BODY_CHARS = 20_000;

/** The version scheme `MAJOR.MINOR.RULES_DAY.RULES_HHMM` (P2-03): four integers, no leading zeros. */
const VERSION = /^Version: ((?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){3})\b/m;
const RULES_LINE = /^Matched rules: (.{1,2000})$/m;
const REF = /(?:^|[\s,])([a-z0-9][a-z0-9-]{0,63})#([1-9]\d{0,8})(?=$|[\s,])/g;
/** Ruleset ids that may become an asset file name (static rulesets only, never `_dynamic`). */
export const RULESET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Fixed label allowlist: upstream project of a list id. Never a label made from parsed text. */
const UPSTREAMS: readonly (readonly [RegExp, string])[] = [
  [/^ubo-/, 'upstream:ubo'],
  [/^easylist(?:-|$)/, 'upstream:easylist'],
  [/^easyprivacy$/, 'upstream:easylist'],
  [/^adguard-/, 'upstream:adguard'],
  [/^urlhaus$/, 'upstream:urlhaus'],
];
export const KNOWN_LABELS: ReadonlySet<string> = new Set(UPSTREAMS.map(([, label]) => label));

export interface RuleRef {
  readonly rulesetId: string;
  readonly ruleId: number;
}

export interface ParsedReport {
  readonly version: string | null;
  readonly refs: readonly RuleRef[];
}

/** One source filter of a rule (an id map entry). */
export interface SourceFilter {
  readonly list: string;
  readonly line: number;
  readonly text: string;
}

/** Reads the version and the rule references of a report; nothing else of the body is used. */
export function parseReport(body: string): ParsedReport {
  const text = body.slice(0, MAX_BODY_CHARS).replace(/\r\n?/g, '\n');
  const version = VERSION.exec(text)?.[1] ?? null;
  const line = RULES_LINE.exec(text)?.[1] ?? '';
  const seen = new Set<string>();
  const refs: RuleRef[] = [];
  for (const m of line.matchAll(REF)) {
    const [, rulesetId = '', id = ''] = m;
    const key = `${rulesetId}#${id}`;
    if (seen.has(key) || refs.length >= MAX_REFS) continue;
    seen.add(key);
    refs.push({ rulesetId, ruleId: Number(id) });
  }
  return { version, refs };
}

/** Validates one id map file's content: `{ "<id>": [{ list, line, text }] }`. */
export function readIdMap(raw: unknown): ReadonlyMap<number, readonly SourceFilter[]> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out = new Map<number, readonly SourceFilter[]>();
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[1-9]\d{0,8}$/.test(key) || !Array.isArray(value)) return null;
    const filters = value.filter(
      (f): f is SourceFilter =>
        typeof f === 'object' && f !== null && typeof (f as SourceFilter).list === 'string' && Number.isInteger((f as SourceFilter).line) && typeof (f as SourceFilter).text === 'string',
    );
    if (filters.length !== value.length) return null;
    out.set(Number(key), filters);
  }
  return out;
}

const upstreamOf = (list: string): string | null => UPSTREAMS.find(([pattern]) => pattern.test(list))?.[1] ?? null;

/** `upstream:<project>` when every resolved filter comes from one known project, else none. */
export function labelsFor(resolved: ReadonlyMap<string, readonly SourceFilter[]>): readonly string[] {
  const filters = [...resolved.values()].flat();
  const upstreams = new Set(filters.map((f) => upstreamOf(f.list)));
  const [only] = [...upstreams];
  return filters.length > 0 && upstreams.size === 1 && only !== null && only !== undefined && KNOWN_LABELS.has(only) ? [only] : [];
}

/** Untrusted text made inert for a comment: no mentions, no control characters, capped. */
function inert(text: string, max: number): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    // Bidi overrides and invisible format characters (security review LOW), before the `@` defusing below.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\n/g, ' ')
    .replace(/@/g, '@​');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** A fence one backtick longer than the longest run inside `text` (at least three). */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const label = (ref: RuleRef): string => `${ref.rulesetId}#${String(ref.ruleId)}`;

function block(ref: RuleRef, filters: readonly SourceFilter[] | undefined): string {
  if (filters === undefined || filters.length === 0) return `${label(ref)}: not in the id map of this version`;
  const lines = filters.slice(0, MAX_FILTERS_PER_RULE).map((f) => `${inert(f.list, 64)}:${String(f.line)}  ${inert(f.text, MAX_FILTER_CHARS)}`);
  const more = filters.length > MAX_FILTERS_PER_RULE ? [`(+${String(filters.length - MAX_FILTERS_PER_RULE)} more)`] : [];
  const body = [...lines, ...more].join('\n');
  const fence = fenceFor(body);
  return `${label(ref)}:\n${fence}text\n${body}\n${fence}`;
}

export type CommentInput =
  | { readonly kind: 'resolved'; readonly version: string; readonly refs: readonly RuleRef[]; readonly maps: ReadonlyMap<string, ReadonlyMap<number, readonly SourceFilter[]>> }
  | { readonly kind: 'no-version' }
  | { readonly kind: 'no-refs'; readonly version: string }
  | { readonly kind: 'no-release'; readonly version: string };

/** The bot's comment (always starts with the marker). */
export function commentFor(input: CommentInput): string {
  const head = `${COMMENT_MARKER}\n**Rule ids resolved by the id-map bot**\n\n`;
  switch (input.kind) {
    case 'no-version':
      return `${head}No \`Version:\` line was found in the report, so the rule ids cannot be resolved.`;
    case 'no-refs':
      return `${head}Version ${input.version}: the report names no matched rules.`;
    case 'no-release':
      return `${head}Version ${input.version}: no id map is published for this version.`;
    case 'resolved': {
      const blocks = input.refs.map((ref) => block(ref, input.maps.get(ref.rulesetId)?.get(ref.ruleId)));
      const text = `${head}Version ${input.version}:\n\n${blocks.join('\n\n')}`;
      return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS)}\n\n(cut at ${String(MAX_COMMENT_CHARS)} characters)` : text;
    }
  }
}

/** The filters of every resolved reference, keyed by `ruleset#id`, for the label decision. */
export function resolvedFilters(refs: readonly RuleRef[], maps: ReadonlyMap<string, ReadonlyMap<number, readonly SourceFilter[]>>): ReadonlyMap<string, readonly SourceFilter[]> {
  return new Map(refs.flatMap((ref) => {
    const filters = maps.get(ref.rulesetId)?.get(ref.ruleId);
    return filters === undefined ? [] : [[label(ref), filters] as const];
  }));
}
