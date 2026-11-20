/**
 * The packaged pop-up host lists (`popup-destinations.json`, `popup-strict-sites.json`, filter-pipeline notes §7a;
 * `popup-lifted.json`, D-55a: justifying ruleset id → lifted destinations):
 * read by the worker from its own package, still checked here (a boundary): a JSON array of canonical
 * hostnames, or nothing.
 */
import { isCanonicalHostname } from '../hostname/validate.js';
import { parseRulesetId, type Hostname } from '../ids.js';

/** The hosts of a packaged list, or `null` when the text is not a list of canonical hostnames. */
export function parseHostList(text: string): readonly Hostname[] | null {
  return hostsOf(parse(text));
}

/** `popup-lifted.json`: an object of ruleset id → canonical hostnames, or `null`. */
export function parseLiftedList(text: string): Readonly<Record<string, readonly Hostname[]>> | null {
  const value = parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).map(([id, list]) => [id, parseRulesetId(id) === null ? null : hostsOf(list)] as const);
  return entries.every(([, hosts]) => hosts !== null) ? Object.fromEntries(entries) as Record<string, readonly Hostname[]> : null;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function hostsOf(value: unknown): readonly Hostname[] | null {
  if (!Array.isArray(value)) return null;
  const hosts: unknown[] = value;
  return hosts.every((h): h is string => typeof h === 'string' && isCanonicalHostname(h)) ? (hosts as Hostname[]) : null;
}
