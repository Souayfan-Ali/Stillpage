/**
 * Provider allowlist for the pop-up guard (pop-up notes §8, rule G5): sign-in and payment endpoints as
 * host + path-prefix pairs. `loadAllowlist` takes the already-parsed list (no file access in core),
 * runs the admission lint and compiles it to `host → prefixes`, the form the sentinel carries
 * (P2-57). Lint rules: design review, P2-56 notes. Matching is on a parsed URL, never a string prefix.
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';
import { parentDomains } from '../hostname/walk.js';
import type { Hostname } from '../ids.js';
import { own } from '../record.js';
import { err, ok, type Result } from '../result.js';
import { isIpv4, isSuffix, siteOf } from './site.js';

/** pop-up notes §8: at most 60 entries, compiled form ≤ 1 kB gzip. */
export const MAX_ALLOW_ENTRIES = 60;
export const MAX_COMPILED_GZIP_BYTES = 1_024;
const MAX_REVIEWER_LENGTH = 100;
/** Path segments that mark an open redirector, a tracker or an affiliate hop (whole segment, any case). */
const REDIRECT_SEGMENTS: ReadonlySet<string> = new Set(['url', 'redirect', 'out', 'r', 'link', 'away', 'click', 'go', 'goto', 'redir', 'track', 'aff']);
/** Providers whose documentation lives on another of their sites: entry site → accepted source sites. */
const SOURCE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'microsoftonline.com': ['microsoft.com'], 'live.com': ['microsoft.com'], 'linkedin.com': ['microsoft.com'], 'twitter.com': ['x.com'],
};
/** Query, fragment, escapes, dot-dot, empty segments and anything outside printable ASCII. */
const BAD_PATH = /[?#%]|\.\.|\/\/|[^!-~]/;

const EntrySchema = v.strictObject({
  host: v.string(), pathPrefix: v.string(), wholeHost: v.exactOptional(v.literal(true)), reviewer: v.string(), source: v.string(),
});
export type AllowEntry = v.InferOutput<typeof EntrySchema>;

/** `host → sorted path prefixes`; `/` means the whole host. */
export type CompiledAllowlist = Readonly<Record<string, readonly string[]>>;

export interface LoadOptions {
  /** Pop-up destinations and other known ad hosts; an entry on one of them or under one is refused. */
  readonly adHosts: ReadonlySet<string>;
  /** Gzip size of a text (Node's zlib at build and test time); without it the size line is not checked. */
  readonly gzipBytes?: (text: string) => number;
}

function hostProblems(host: string, adHosts: ReadonlySet<string>): string[] {
  if (parseHostname(host) !== host) return ['host is not a lower-case ASCII hostname'];
  if (isSuffix(host) || isIpv4(host)) return ['host is a suffix, a single label or an IP literal'];
  return parentDomains(host as Hostname).some((h) => adHosts.has(h)) ? ['host is an ad host or under one'] : [];
}

function pathProblems(e: AllowEntry): string[] {
  const site = siteOf(e.host);
  if (e.pathPrefix === '/') {
    if (e.wholeHost !== true) return ['pathPrefix "/" needs wholeHost: true'];
    return e.host === site || e.host === `www.${site}` ? ['a whole host may not be the bare site or its www'] : [];
  }
  if (e.wholeHost === true) return ['wholeHost needs pathPrefix "/"'];
  if (!e.pathPrefix.startsWith('/') || e.pathPrefix.endsWith('/') || BAD_PATH.test(e.pathPrefix)) {
    return ['pathPrefix must be "/…" without a trailing "/", "?", "#", "%", "..", "//" or non-ASCII'];
  }
  const redirect = e.pathPrefix.split('/').find((s) => REDIRECT_SEGMENTS.has(s.toLowerCase()));
  return redirect === undefined ? [] : [`pathPrefix has a redirect segment "${redirect}"`];
}

function sourceProblems(e: AllowEntry): string[] {
  let url: URL;
  try {
    url = new URL(e.source);
  } catch {
    return ['source is not a URL'];
  }
  if (url.protocol !== 'https:') return ['source is not https'];
  const site = siteOf(e.host);
  const accepted = [site, ...(own(SOURCE_ALIASES, site) ?? [])];
  return accepted.includes(siteOf(url.hostname)) ? [] : ['source is not on the provider’s site'];
}

function entryProblems(raw: unknown, index: number, adHosts: ReadonlySet<string>): string[] {
  const parsed = v.safeParse(EntrySchema, raw);
  if (!parsed.success) return [`entry ${String(index)}: not { host, pathPrefix, wholeHost?, reviewer, source }`];
  const e = parsed.output;
  const reviewer = e.reviewer.trim() === '' || e.reviewer.length > MAX_REVIEWER_LENGTH ? ['reviewer missing'] : [];
  return [...hostProblems(e.host, adHosts), ...pathProblems(e), ...sourceProblems(e), ...reviewer]
    .map((p) => `entry ${String(index)} (${e.host}${e.pathPrefix}): ${p}`);
}

/** Groups entries by host, prefixes sorted; hosts sorted (deterministic). */
export function compileAllowlist(entries: readonly Pick<AllowEntry, 'host' | 'pathPrefix'>[]): CompiledAllowlist {
  const hosts = [...new Set(entries.map((e) => e.host))].sort();
  return Object.fromEntries(hosts.map((h) => [h, [...new Set(entries.filter((e) => e.host === h).map((e) => e.pathPrefix))].sort()]));
}

/** The text the sentinel carries. */
export const compiledText = (compiled: CompiledAllowlist): string => JSON.stringify(compiled);

function listProblems(entries: readonly AllowEntry[], options: LoadOptions): string[] {
  const keys = entries.map((e) => `${e.host}${e.pathPrefix}`);
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => `duplicate entry ${k}`);
  const count = entries.length > MAX_ALLOW_ENTRIES ? [`at most ${String(MAX_ALLOW_ENTRIES)} entries (${String(entries.length)})`] : [];
  const gzip = options.gzipBytes?.(compiledText(compileAllowlist(entries))) ?? 0;
  const size = gzip > MAX_COMPILED_GZIP_BYTES ? [`compiled allowlist is ${String(gzip)} B gzip (≤ ${String(MAX_COMPILED_GZIP_BYTES)})`] : [];
  return [...duplicates, ...count, ...size];
}

/** Lints and compiles the allowlist; every problem is reported, nothing partial is returned. */
export function loadAllowlist(raw: unknown, options: LoadOptions): Result<CompiledAllowlist> {
  if (!Array.isArray(raw)) return err(['allowlist is not an array']);
  const list: readonly unknown[] = raw;
  const problems = list.flatMap((e, i) => entryProblems(e, i, options.adHosts));
  if (problems.length > 0) return err(problems);
  const entries = list as readonly AllowEntry[];
  const more = listProblems(entries, options);
  return more.length > 0 ? err(more) : ok(compileAllowlist(entries));
}

/** G5: https, default port, exact host, path on a segment boundary of a listed prefix. */
export function matchesAllowlist(compiled: CompiledAllowlist, url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '') return false;
  const prefixes = own(compiled, url.hostname) ?? [];
  return prefixes.some((p) => p === '/' || url.pathname === p || url.pathname.startsWith(`${p}/`));
}
