/**
 * Id-resolution bot, orchestration (P2-16): one issue event in, one comment (created or updated by its
 * marker) and at most one allowlisted label out. GitHub is reached only through `Gh`, so the logic is
 * tested on a sample payload without the network; `main.ts` wires the `gh` CLI.
 */
import { commentFor, COMMENT_MARKER, labelsFor, parseReport, readIdMap, resolvedFilters, RULESET_ID, type SourceFilter } from './resolve.js';

export interface BotComment {
  readonly id: number;
  readonly body: string;
  /** Written by this workflow's token (`github-actions[bot]`). */
  readonly ours: boolean;
}

export interface Gh {
  /** The id map of one ruleset in release `rules/<version>`, parsed JSON, or `null` when there is none. */
  idMap(version: string, rulesetId: string): Promise<unknown>;
  comments(issue: number): Promise<readonly BotComment[]>;
  createComment(issue: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  addLabels(issue: number, labels: readonly string[]): Promise<void>;
}

export interface IssueEvent {
  readonly action: 'opened' | 'edited';
  readonly issue: number;
  readonly body: string;
}

/** The fields of a GitHub `issues` event this bot reads; `null` for anything else or a bot's own event. */
export function readEvent(raw: unknown): IssueEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as { action?: unknown; issue?: { number?: unknown; body?: unknown }; sender?: { type?: unknown } };
  if (e.action !== 'opened' && e.action !== 'edited') return null;
  if (e.sender?.type === 'Bot') return null;
  const issue = e.issue?.number;
  if (typeof issue !== 'number' || !Number.isSafeInteger(issue) || issue < 1) return null;
  const body = typeof e.issue?.body === 'string' ? e.issue.body : '';
  return { action: e.action, issue, body };
}

async function maps(gh: Gh, version: string, rulesetIds: readonly string[]): Promise<ReadonlyMap<string, ReadonlyMap<number, readonly SourceFilter[]>> | null> {
  const ids = [...new Set(rulesetIds)].filter((id) => RULESET_ID.test(id));
  const loaded = await Promise.all(ids.map(async (id) => [id, readIdMap(await gh.idMap(version, id))] as const));
  const found = loaded.filter((entry): entry is readonly [string, ReadonlyMap<number, readonly SourceFilter[]>] => entry[1] !== null);
  return found.length === 0 && ids.length > 0 ? null : new Map(found);
}

/** Handles one event; returns what was written (for the log and the tests). */
export async function handle(event: IssueEvent, gh: Gh): Promise<{ readonly comment: string; readonly labels: readonly string[] }> {
  const report = parseReport(event.body);
  let comment: string;
  let labels: readonly string[] = [];
  if (report.version === null) comment = commentFor({ kind: 'no-version' });
  else if (report.refs.length === 0) comment = commentFor({ kind: 'no-refs', version: report.version });
  else {
    const loaded = await maps(gh, report.version, report.refs.map((r) => r.rulesetId));
    if (loaded === null) comment = commentFor({ kind: 'no-release', version: report.version });
    else {
      comment = commentFor({ kind: 'resolved', version: report.version, refs: report.refs, maps: loaded });
      labels = labelsFor(resolvedFilters(report.refs, loaded));
    }
  }
  const existing = (await gh.comments(event.issue)).find((c) => c.ours && c.body.startsWith(COMMENT_MARKER));
  if (existing === undefined) await gh.createComment(event.issue, comment);
  else if (existing.body !== comment) await gh.updateComment(existing.id, comment);
  if (labels.length > 0) await gh.addLabels(event.issue, labels);
  return { comment, labels };
}
