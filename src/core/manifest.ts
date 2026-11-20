import { STORE_NAME } from './brand.js';
import { isUnsafeRulesetId, parseRulesetId } from './ids.js';
import { MIN_CHROME_VERSION, RULESET_SLOTS } from './limits.js';

/** Extension-page CSP (security notes §6): stricter than the MV3 default; no wasm, no remote code. */
export const EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'none'; base-uri 'none'";

/**
 * Permissions declared now: the ADR-007 v1.0 set minus `contextMenus`, which arrives with the picker's
 * context menu (design review, 2026-11-14). `activeTab` came with the privacy panel's `getMatchedRules` (P2-11). The whole set is frozen at the first public
 * release. Every entry has a row in `docs/permissions.md`; a unit test checks both directions.
 */
export const DECLARED_PERMISSIONS = ['declarativeNetRequest', 'scripting', 'storage', 'unlimitedStorage', 'alarms', 'activeTab', 'contextMenus'] as const;
const HOST_PERMISSIONS = ['<all_urls>'] as const;

/** Never declared (ADR-007 item 3), nor the DNR variant that forfeits skip review. */
const BANNED_PERMISSIONS = ['tabs', 'webNavigation', 'webRequest', 'declarativeNetRequestFeedback', 'declarativeNetRequestWithHostAccess'];

/** The parts of manifest.json we set; WXT adds entrypoints, version and `manifest_version`. */
export interface ManifestBase {
  readonly name: string;
  /** `_locales/<lang>/messages.json` (P2-40); the name stays `STORE_NAME`, written once. */
  readonly default_locale: 'en';
  readonly description: string;
  readonly minimum_chrome_version: string;
  readonly permissions: string[];
  readonly host_permissions: string[];
  readonly incognito: 'split';
  readonly content_security_policy: { readonly extension_pages: string };
  readonly declarative_net_request?: { readonly rule_resources: RuleResource[] };
  readonly web_accessible_resources: WebAccessible[];
  readonly commands: { readonly [PICKER_COMMAND]: { readonly suggested_key: { readonly default: string }; readonly description: string } };
  /** The dashboard is the options page, opened in a full tab (UI notes §8, P2-34). */
  readonly options_ui: { readonly page: string; readonly open_in_tab: true };
  /** The store icon (P2-50); WXT adds the panel page to `action`. */
  readonly icons: IconSet;
  readonly action: { readonly default_icon: IconSet };
}

type IconSet = Readonly<Record<number, string>>;

/** One packaged icon: its size, its source in `store/icon/` and its path in the package. */
export interface IconFile {
  readonly size: number;
  readonly source: string;
  readonly path: string;
}

/**
 * The store icon at the sizes Chrome uses (P2-50 follow-up 2): 16/32 for the toolbar button, 48 for the
 * extensions page, 128 for install and the store. `store/icon/` is the source; the build copies these
 * files into `icons/` (`wxt.config.ts`). No paused variant: the plan asks for none and switching it
 * would need the worker on every pause.
 */
export const ICON_FILES: readonly IconFile[] = [16, 32, 48, 128].map((size) => ({ size, source: `icon-${String(size)}.png`, path: `icons/icon-${String(size)}.png` }));
const TOOLBAR_ICON_SIZES: readonly number[] = [16, 32];

const iconSet = (sizes: readonly number[]): IconSet =>
  Object.fromEntries(ICON_FILES.filter((f) => sizes.includes(f.size)).map((f) => [f.size, f.path]));

/** Keyboard shortcut of the element hider (P2-21, UI notes §5; user-configurable in Chrome). */
export const PICKER_COMMAND = 'hide-element';

/** One `web_accessible_resources` entry; every one has `use_dynamic_url` (ADR-007 item 6, security notes T2). */
interface WebAccessible {
  readonly resources: string[];
  readonly matches: string[];
  readonly use_dynamic_url: true;
}

/**
 * What may ever be web-accessible: the redirect surrogates (P1-30; the one inert HTML file among them
 * is gated by the compiler, D-24), and later the picker panel and the blocked page (ADR-007, ADR-016).
 */
const ALLOWED_WAR = ['surrogates/*', 'picker-panel.html', 'blocked.html'];
/**
 * Declared now: the surrogates and the picker panel (P2-19). The panel is framed only by web pages, so
 * its `matches` are http(s) pages, not `<all_urls>` (D-34, design review).
 */
const PICKER_PANEL_MATCHES = ['http://*/*', 'https://*/*'] as const;
const WEB_ACCESSIBLE: readonly WebAccessible[] = [
  { resources: ['surrogates/*'], matches: ['<all_urls>'], use_dynamic_url: true },
  { resources: ['picker-panel.html'], matches: [...PICKER_PANEL_MATCHES], use_dynamic_url: true },
  // The DNR redirect target of listed pop-up destinations (P2-55). Kept on the matches S-19 measured
  // (design review): narrowing is a P2-54 follow-up tested against typed, `about:blank`-opener and `noopener` cases.
  { resources: ['blocked.html'], matches: ['<all_urls>'], use_dynamic_url: true },
];

/** One `rule_resources` entry as the compiler emits it (`dist/compiler/manifest.dnr.json`). */
export interface RuleResource {
  readonly id: string;
  readonly enabled: boolean;
  readonly path: string;
}

const RESOURCE_KEYS = ['enabled', 'id', 'path'];
/** Where every ruleset lives in the package. */
const rulesetPath = (id: string): string => `rulesets/${id}.json`;

function readResource(value: unknown, seen: Set<string>): RuleResource {
  if (!isObject(value)) throw new Error('rule_resources entry is not an object');
  const keys = Object.keys(value).sort();
  if (keys.join() !== RESOURCE_KEYS.join()) throw new Error(`rule_resources entry has key set ${keys.join()}`);
  const id = parseRulesetId(value['id']);
  if (id === null) throw new Error(`invalid ruleset id ${JSON.stringify(value['id'])}`);
  if (seen.has(id)) throw new Error(`duplicate ruleset id ${id}`);
  seen.add(id);
  if (value['path'] !== rulesetPath(id)) throw new Error(`ruleset ${id}: path must be ${rulesetPath(id)}`);
  if (typeof value['enabled'] !== 'boolean') throw new Error(`ruleset ${id}: enabled is not a boolean`);
  if (isUnsafeRulesetId(id) && value['enabled']) throw new Error(`ruleset ${id} must be enabled: false (D-06)`);
  return { id, enabled: value['enabled'], path: rulesetPath(id) };
}

/**
 * Validates the compiler's manifest fragment `{declarative_net_request: {rule_resources}}` (P1-26)
 * before it enters the manifest. Throws on anything unexpected: the build must not package a
 * manifest Chrome would refuse or one that enables an `-x` ruleset.
 */
export function readRuleResources(fragment: unknown): readonly RuleResource[] {
  const dnr = isObject(fragment) ? fragment['declarative_net_request'] : undefined;
  if (!isObject(dnr) || !Array.isArray(dnr['rule_resources'])) throw new Error('manifest fragment is not an object with declarative_net_request.rule_resources');
  const seen = new Set<string>();
  return (dnr['rule_resources'] as readonly unknown[]).map((r) => readResource(r, seen));
}

/** Builds the manifest fields owned by the project. Returns a fresh object each call. */
export function createManifest(ruleResources: readonly RuleResource[] = []): ManifestBase {
  const dnr = ruleResources.length > 0 ? { declarative_net_request: { rule_resources: ruleResources.map((r) => ({ ...r })) } } : {};
  return {
    name: STORE_NAME,
    default_locale: 'en',
    // The store summary (P2-50), from the catalog so a reviewed locale can translate it.
    description: '__MSG_ext_description__',
    minimum_chrome_version: MIN_CHROME_VERSION,
    permissions: [...DECLARED_PERMISSIONS],
    host_permissions: [...HOST_PERMISSIONS],
    incognito: 'split',
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
    web_accessible_resources: WEB_ACCESSIBLE.map((w) => ({ ...w, resources: [...w.resources], matches: [...w.matches] })),
    commands: { [PICKER_COMMAND]: { suggested_key: { default: 'Alt+Shift+H' }, description: '__MSG_command_hide_element__' } },
    options_ui: { page: 'dashboard.html', open_in_tab: true },
    icons: iconSet(ICON_FILES.map((f) => f.size)),
    action: { default_icon: iconSet(TOOLBAR_ICON_SIZES) },
    ...dnr,
  };
}

type Loose = Readonly<Record<string, unknown>>;

const sameSet = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null;

/** Keys the built manifest must not have (review M3): every exposure needs its own ADR first. */
const FORBIDDEN_KEYS = [
  'content_scripts',
  'externally_connectable',
  'optional_permissions',
  'optional_host_permissions',
  'chrome_url_overrides',
  'devtools_page',
  'update_url',
];

function rulesetErrors(manifest: Loose, expectedSlots: number): string[] {
  const dnr = manifest['declarative_net_request'];
  const resources = isObject(dnr) ? asArray(dnr['rule_resources']) : [];
  const count = resources.length === 0 || resources.length === expectedSlots ? [] : [`${String(resources.length)} rulesets declared, expected 0 or ${String(expectedSlots)}`];
  return [...count, ...resources.flatMap((r) => {
    if (!isObject(r)) return ['invalid rule_resources entry'];
    const id = parseRulesetId(r['id']);
    if (id === null) return [`invalid ruleset id ${JSON.stringify(r['id'])}`];
    const path = r['path'] === rulesetPath(id) ? [] : [`ruleset ${id}: path is not ${rulesetPath(id)}`];
    return isUnsafeRulesetId(id) && r['enabled'] !== false ? [...path, `ruleset ${id} must be enabled: false in the manifest`] : path;
  })];
}

/** `<all_urls>` or a narrower list of web pages (D-34: each page sets the narrowest `matches`). */
const WAR_MATCHES: ReadonlySet<unknown> = new Set(['<all_urls>', ...PICKER_PANEL_MATCHES]);
const isAllowedMatches = (matches: readonly unknown[]): boolean =>
  matches.length > 0 && matches.every((m) => WAR_MATCHES.has(m)) && new Set(matches).size === matches.length;

function warErrors(manifest: Loose): string[] {
  const entries = asArray(manifest['web_accessible_resources']);
  return entries.flatMap((e) => {
    if (!isObject(e)) return ['invalid web_accessible_resources entry'];
    const keys = Object.keys(e).sort().join();
    const resources = asArray(e['resources']);
    return [
      ...(keys === 'matches,resources,use_dynamic_url' ? [] : [`web_accessible_resources entry has keys ${keys}`]),
      ...(e['use_dynamic_url'] === true ? [] : ['web_accessible_resources without use_dynamic_url']),
      ...(isAllowedMatches(asArray(e['matches'])) ? [] : ['web_accessible_resources matches other than <all_urls> or http(s) pages']),
      ...resources.filter((r) => typeof r !== 'string' || !ALLOWED_WAR.includes(r)).map((r) => `web-accessible resource ${JSON.stringify(r)} is not allowed (ADR-007 item 6)`),
    ];
  });
}

/** Every store icon size declared at its packaged path, and the toolbar button's icon (P2-50 follow-up 2). */
function iconErrors(manifest: Loose): string[] {
  const icons = manifest['icons'];
  const action = manifest['action'];
  const toolbar = isObject(action) ? action['default_icon'] : undefined;
  const missing = ICON_FILES.filter((f) => !isObject(icons) || icons[String(f.size)] !== f.path);
  return [
    ...(missing.length === 0 ? [] : [`icons lacks ${missing.map((f) => f.path).join(', ')}`]),
    ...(isObject(toolbar) && TOOLBAR_ICON_SIZES.every((size) => typeof toolbar[String(size)] === 'string') ? [] : ['action has no default_icon at 16 and 32 px']),
  ];
}

/** Banned permissions present in a manifest (the build refuses them, P2-11: a test-only copy may add one, the package never). */
export function bannedPermissionsIn(manifest: unknown): readonly string[] {
  const permissions = isObject(manifest) ? asArray(manifest['permissions']) : [];
  return BANNED_PERMISSIONS.filter((p) => permissions.includes(p));
}

function permissionErrors(manifest: Loose): string[] {
  const permissions = asArray(manifest['permissions']);
  const hosts = asArray(manifest['host_permissions']);
  return [
    ...BANNED_PERMISSIONS.filter((p) => permissions.includes(p)).map((p) => `banned permission ${p}`),
    ...(sameSet(permissions, DECLARED_PERMISSIONS) ? [] : [`permissions differ from the declared set: ${JSON.stringify(permissions)}`]),
    ...(sameSet(hosts, HOST_PERMISSIONS) ? [] : ['host_permissions differ from the declared set']),
  ];
}

/**
 * Build-artefact gate (P1-13, security notes §9): no `content_scripts` key (every script is registered by
 * the worker), every `-x` ruleset off in the manifest (the no-access state, D-06), exactly the
 * declared permissions, our CSP, `incognito: split`, the store icon, none of `FORBIDDEN_KEYS`. Returns the problems
 * found; never throws on a malformed manifest. `expectedSlots` is 36, or 32 for the store build made with
 * `--drop-pending` (P2-29: the owner-pending packs' slots are not declared).
 */
export function checkBuiltManifest(manifest: unknown, expectedSlots: number = RULESET_SLOTS): readonly string[] {
  if (typeof manifest !== 'object' || manifest === null) return ['manifest is not an object'];
  const m = manifest as Loose;
  const csp = m['content_security_policy'];
  return [
    ...FORBIDDEN_KEYS.filter((key) => key in m).map((key) => `manifest has ${key}`),
    ...(isObject(csp) && csp['extension_pages'] === EXTENSION_PAGES_CSP ? [] : ['content_security_policy differs']),
    ...(m['incognito'] === 'split' ? [] : ['incognito is not split']),
    ...rulesetErrors(m, expectedSlots),
    ...warErrors(m),
    ...iconErrors(m),
    ...permissionErrors(m),
  ];
}
