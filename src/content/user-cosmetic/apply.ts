/**
 * `user-cosmetic` (P2-20, cosmetic notes §7, architecture notes §6, §9): applies the user's element-hider filters at
 * `document_start`. It reads `uf:<host>` for the frame's host and its parents (≤ 8 keys, one read) from
 * `storage.local`, which content scripts can also write: every entry is shape-checked and every selector
 * sanitised (`readMirrorEntry`), and rules are only `selector{display:none!important}`, one adopted sheet.
 *
 * Live (D-80, P3-17): a change to one of the frame's own `uf:` keys re-reads them the same way (never the
 * event's values) and replaces the sheet's text; foreign keys return without a read; rebuilds are
 * trailing-coalesced to one per `LIVE_COALESCE_MS`. No message, no DOM write, no event, no attribute: the
 * mirror only feeds CSS, the vault stays authoritative.
 */
import { frameHost, type FrameLocation } from '../../core/content/frame.js';
import { parentDomains } from '../../core/hostname/walk.js';
import { hideRule } from '../../core/sanitise/selector.js';
import { mirrorKey, readMirrorEntry } from '../../core/userFilters/mirror.js';
import type { AdoptTarget } from '../cosmetic-specific/apply.js';

/** Most `uf:` keys one frame reads (its host and parents). */
const MAX_KEYS = 8;
/** At most one live rebuild per this many ms (D-80). */
export const LIVE_COALESCE_MS = 250;

/** A constructed sheet as used here (`CSSStyleSheet`). */
interface ReplaceableSheet {
  replaceSync(text: string): void;
}

/** `storage.onChanged`, reduced to the changed key names and the area (values are never handed over). */
type OnChanged = (listener: (keys: readonly string[], area: string) => void) => void;

export interface UserCosmeticEnv {
  readonly document: AdoptTarget;
  readonly location: Pick<FrameLocation, 'hostname'> & Partial<FrameLocation> & { readonly protocol?: string };
  /** `storage.local.get(keys)`. */
  readonly read: (keys: readonly string[]) => Promise<Readonly<Record<string, unknown>>>;
  readonly newSheet: () => ReplaceableSheet;
  /** Live apply (D-80); without it (or without a timer) the frame applies once, as before. */
  readonly onChanged?: OnChanged;
  readonly setTimer?: (run: () => void, ms: number) => void;
}

/** The sanitised hide rules of `keys`, or `null` when the mirror cannot be read (the sheet is then kept). */
async function readRules(env: UserCosmeticEnv, keys: readonly string[]): Promise<readonly string[] | null> {
  const stored = await env.read(keys).catch(() => null);
  if (stored === null) return null;
  const selectors = new Set(keys.flatMap((key) => (Object.hasOwn(stored, key) ? readMirrorEntry(stored[key]) : [])));
  return [...selectors].sort().map(hideRule).filter((r): r is string => r !== null);
}

/** The one sheet of this frame: adopted on its first non-empty text, then only replaced. */
function sheetHolder(env: UserCosmeticEnv): (rules: readonly string[]) => boolean {
  let sheet: ReplaceableSheet | null = null;
  return (rules) => {
    if (sheet !== null) {
      sheet.replaceSync(rules.join('\n'));
      return true;
    }
    const current = env.document.adoptedStyleSheets;
    if (rules.length === 0 || !Array.isArray(current)) return false;
    sheet = env.newSheet();
    sheet.replaceSync(rules.join('\n'));
    env.document.adoptedStyleSheets = [...(current as readonly unknown[]), sheet];
    return true;
  };
}

/** Rebuilds once, `LIVE_COALESCE_MS` after the first change of an own key; other changes cost nothing. */
function listen(env: UserCosmeticEnv, own: ReadonlySet<string>, rebuild: () => Promise<unknown>): void {
  const { onChanged, setTimer } = env;
  if (onChanged === undefined || setTimer === undefined) return;
  let pending = false;
  onChanged((keys, area) => {
    if (pending || area !== 'local' || !keys.some((k) => own.has(k))) return;
    pending = true;
    setTimer(() => {
      pending = false;
      // Quiet by design: a failed rebuild keeps the sheet as it was; the next change or load tries again.
      void rebuild().catch(() => undefined);
    }, LIVE_COALESCE_MS);
  });
}

/** Applies the user filters of this frame and keeps them live; resolves with the number of rules first applied. */
export async function runUserCosmetic(env: UserCosmeticEnv): Promise<number> {
  const host = frameHost({ hostname: env.location.hostname, origin: env.location.origin ?? '', ...(env.location.ancestorOrigins && { ancestorOrigins: env.location.ancestorOrigins }) });
  if (host === null) return 0;
  const keys = parentDomains(host).slice(0, MAX_KEYS).map(mirrorKey);
  const apply = sheetHolder(env);
  let generation = 0;
  const build = async (): Promise<number> => {
    generation += 1;
    const mine = generation;
    const rules = await readRules(env, keys);
    // Only the newest read is applied; an unreadable mirror changes nothing.
    if (mine !== generation || rules === null) return 0;
    return apply(rules) ? rules.length : 0;
  };
  listen(env, new Set(keys), build);
  return build();
}
