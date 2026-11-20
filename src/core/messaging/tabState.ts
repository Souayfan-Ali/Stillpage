/**
 * The `q/tabState` answer (architecture notes §7, UI notes §3): what the toolbar panel needs to draw its header
 * for one tab. The worker builds it with `describeTab` from what Chrome reports about the tab; the
 * panel validates it with `TabStateSchema` before use (a response is a boundary too). Plain data
 * only; the header text is derived on the panel side.
 *
 * The worker learns a tab's address only from `tabs.get(tabId)` (no `tabs` permission, no tab events,
 * ADR-001/007/012). Chrome reports `url` only when the extension has host access to the page, so a
 * missing address means either a page Chrome hides from every extension (with all-sites access) or
 * an ordinary page we may not see (without it).
 */
import * as v from 'valibot';
import { parseHostname } from '../hostname/validate.js';
import { parsePackId, type Hostname, type PackId } from '../ids.js';
import { resolveLevel } from '../levels/resolve.js';
import { hasAllSitesAccess } from '../reconcile/hostAccess.js';
import type { Grants } from '../reconcile/types.js';
import { siteSnapshotOf } from '../state/site.js';
import { sanitiseSelector } from '../sanitise/selector.js';
import { MAX_KEYS, selectorsOn } from '../userFilters/list.js';
import { MAX_SELECTORS_PER_HOST, type UserFilters } from '../userFilters/store.js';
import { LEVELS, type EpochMs, type Settings } from '../state/types.js';

/**
 * `web`: an http(s) page we may filter. `restricted`: Chrome does not let extensions run there
 * (`chrome://`, the Web Store). `admin`: the organisation blocks extensions on this host (reserved:
 * not detectable in v1, drawn from fixtures only).
 */
const PAGE_KINDS = ['web', 'restricted', 'admin'] as const;
/** Site access for this tab: all sites, this site among some, or none (Light only). */
const ACCESS_KINDS = ['all', 'site', 'none'] as const;
const THEMES = ['system', 'light', 'dark'] as const;
/** Outcome of the last reconcile run of this browser session; `none` before the first one (D-31). */
const LAST_RUNS = ['ok', 'failed', 'none'] as const;
export type LastRun = (typeof LAST_RUNS)[number];
const MAX_PACKS = 64;

const hostname = v.pipe(
  v.string(),
  v.check((h) => parseHostname(h) === h, 'invalid hostname'),
);
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0));

/** A host's own stored values, as the site commands also answer them (P2-10, P2-14). */
export const SiteSnapshotSchema = v.strictObject({
  ownLevel: v.nullable(v.picklist(LEVELS)),
  popupPolicy: v.nullable(v.picklist(['allow', 'strict'])),
  pausedUntil: v.nullable(epochMs),
});

export const TabStateSchema = v.strictObject({
  page: v.picklist(PAGE_KINDS),
  /** `null` when Chrome does not tell us the tab's address (no site access to it). */
  host: v.nullable(hostname),
  /** Effective level from the settings (inheritance and pauses applied), before site access. */
  level: v.picklist(LEVELS),
  /** Host whose setting or pause decided `level`; `null` when it is the default. */
  setOn: v.nullable(hostname),
  pausedUntil: v.nullable(epochMs),
  access: v.picklist(ACCESS_KINDS),
  /** False until the first reconcile of this browser session has finished. */
  ready: v.boolean(),
  /** A "settings were reset" notice is waiting. */
  settingsReset: v.boolean(),
  theme: v.picklist(THEMES),
  /** D-31: the last run failed; the panel says part of the protection is retried. */
  lastRun: v.picklist(LAST_RUNS),
  /** The host's own stored values (P2-14 compare-and-revert); `null` without a host. */
  site: v.nullable(SiteSnapshotSchema),
  /** Packs that are on, for the breakage report (P2-15). */
  packs: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.check((p) => parsePackId(p) === p, 'invalid pack id'),
      ),
    ),
    v.maxLength(MAX_PACKS),
  ),
  popupMode: v.picklist(['off', 'smart', 'strict']),
  /** The pop-up guard scripts ship in this build (P2-58 switch): per-site Strict can take effect (P2-62). */
  popupGuard: v.boolean(),
  /**
   * Element-hider filters that apply on this host, distinct and sorted (P2-22: the footer's "N things hidden"
   * link; P2-22b: the "Show on page" list). Each exactly as the sanitiser leaves it.
   */
  hidden: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.check((s) => sanitiseSelector(s) === s, 'invalid selector'),
      ),
    ),
    v.maxLength(MAX_KEYS * MAX_SELECTORS_PER_HOST),
  ),
});

export type TabState = v.InferOutput<typeof TabStateSchema>;

/** What the worker knows when it answers `q/tabState`. */
export interface TabFacts {
  /** The tab's address as Chrome reports it to us; `null` when Chrome withholds it. */
  readonly url: string | null;
  readonly settings: Settings;
  readonly grants: Grants;
  readonly ready: boolean;
  readonly settingsReset: boolean;
  readonly lastRun: LastRun;
  readonly packs: readonly PackId[];
  readonly popupGuard: boolean;
  readonly userFilters: UserFilters;
  readonly now: EpochMs;
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
/** Chrome blocks extensions on the Web Store, whatever the host permissions say. */
const STORE_HOSTS: ReadonlySet<string> = new Set(['chromewebstore.google.com']);
/** The old store address, `chrome.google.com/webstore` (a regex, so no `chrome` + dot literal sits in core). */
const OLD_STORE = /^https?:\/\/chrome\.google\.com\/webstore(?:\/|$)/;
/** `<scheme>://<host>[:<port>]/<path>`; host `*`, `*.<domain>` or a name. */
const MATCH_PATTERN = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/:*]+|[^/:*]+)(?::(?:\d+|\*))?\//;

function isStore(url: URL): boolean {
  return STORE_HOSTS.has(url.hostname) || OLD_STORE.test(`${url.origin}${url.pathname}`);
}

function patternCovers(pattern: string, scheme: string, host: string): boolean {
  if (pattern === '<all_urls>') return true;
  const m = MATCH_PATTERN.exec(pattern);
  if (m === null) return false;
  const [, patternScheme = '', patternHost = ''] = m;
  const schemeOk = patternScheme === '*' ? WEB_SCHEMES.has(scheme) : `${patternScheme}:` === scheme;
  if (!schemeOk) return false;
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const domain = patternHost.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === patternHost;
}

/** True when one of the granted match patterns covers pages of `host` under `scheme` (`https:`). */
export function grantCoversHost(origins: readonly string[], scheme: string, host: string): boolean {
  return origins.some((pattern) => patternCovers(pattern, scheme, host));
}

interface Page {
  readonly page: TabState['page'];
  readonly host: Hostname | null;
  readonly scheme: string | null;
}

const RESTRICTED: Page = { page: 'restricted', host: null, scheme: null };

function pageOf(url: string | null, allSites: boolean): Page {
  if (url === null) return allSites ? RESTRICTED : { page: 'web', host: null, scheme: null };
  if (!URL.canParse(url)) return RESTRICTED;
  const parsed = new URL(url);
  if (!WEB_SCHEMES.has(parsed.protocol) || isStore(parsed)) return RESTRICTED;
  return { page: 'web', host: parseHostname(parsed.hostname), scheme: parsed.protocol };
}

/** Builds the `q/tabState` answer. Pure. */
export function describeTab(facts: TabFacts): TabState {
  const allSites = hasAllSitesAccess(facts.grants);
  const { page, host, scheme } = pageOf(facts.url, allSites);
  const resolved =
    host === null ? { level: facts.settings.defaultLevel, setOn: null, pausedUntil: null } : resolveLevel(facts.settings, host, facts.now);
  const covered = host !== null && scheme !== null && grantCoversHost(facts.grants.origins, scheme, host);
  return {
    page,
    host,
    level: resolved.level,
    setOn: resolved.setOn,
    pausedUntil: resolved.pausedUntil,
    access: allSites ? 'all' : covered ? 'site' : 'none',
    ready: facts.ready,
    settingsReset: facts.settingsReset,
    theme: facts.settings.ui.theme,
    lastRun: facts.lastRun,
    site: host === null ? null : siteSnapshotOf(facts.settings, host, facts.now),
    packs: [...facts.packs],
    popupMode: facts.settings.popups.mode,
    popupGuard: facts.popupGuard,
    hidden: [...selectorsOn(facts.userFilters, host)],
  };
}
