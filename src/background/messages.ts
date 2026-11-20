/**
 * Message handling (P1-13): validate with the envelope, sender policy and payload schemas (P1-12),
 * then dispatch. Handled: `c/reconcile`, the toolbar panel's `q/tabState`, `c/setSiteLevel`,
 * `c/pauseSite` and `c/dismissNotice` (P1-41, P2-10, `panel.ts`), `q/matchedRules` (P2-11, `matched.ts`), `c/setPack` (P2-26, `packs.ts`), the pop-up commands (P2-54, `popups.ts`) and the content scripts' one request
 * `cs/cssFallback` (P1-38). The other setting commands and queries are answered `not-implemented`
 * until their features land (P2). Never throws.
 */
import { parseMessage, type MessageError, type MessageType, type ParsedMessage, type Response, type SenderInfo } from '../core/messaging/parse.js';
import type { Hostname, PackId } from '../core/ids.js';
import type { MatchedRules } from '../core/messaging/matched.js';
import type { TabState } from '../core/messaging/tabState.js';
import { cssFallback } from './cssFallback.js';
import { matchedRules } from './matched.js';
import type { Features } from './features.js';
import { setGpc, setPack } from './packs.js';
import { setPopupMode, setPopupNotice, setSitePopupPolicy } from './popups.js';
import { dismissNotice, pauseSite, setSiteLevel, tabState, type PanelContext, type ReconcileSummary } from './panel.js';
import { dispatchSettingsPage, SETTINGS_PAGE_PAGES_OF } from './settingsPageRoutes.js';

export interface MessageContext extends PanelContext {
  readonly runtimeId: string;
  /** User filters, picker start, "Proceed once" (P2-20, P2-21, P2-55). */
  readonly features?: Features;
}

type Answer = ReconcileSummary | TabState | MatchedRules | { readonly rules: number } | { readonly dismissed: true } | null;

const failure = (error: MessageError): Response<never> => ({ ok: false, error });

/**
 * Extension pages that may ask about a tab or change a site level (security review MEDIUM-1): a tab
 * id is not bound to its caller, so any other page of ours (e.g. `blocked.html`) is refused. The
 * dashboard joins this list when it exists (P2).
 */
const PANEL_PAGES: ReadonlySet<string> = new Set(['/popup.html']);
/** Global settings commands (P2-26, design review 2026-11-14): the pages that show settings; never `blocked.html` or the picker. */
const SETTINGS_PAGES: ReadonlySet<string> = new Set(['/popup.html', '/dashboard.html', '/onboarding.html']);
/** D-32: the settings-reset notice is dismissed where it is shown: the toolbar panel and the dashboard. */
const NOTICE_PAGES: ReadonlySet<string> = new Set(['/popup.html', '/dashboard.html']);
const PAGES_OF: Readonly<Partial<Record<MessageType, ReadonlySet<string>>>> = {
  'q/tabState': PANEL_PAGES,
  'q/matchedRules': PANEL_PAGES,
  'c/setSiteLevel': PANEL_PAGES,
  'c/pauseSite': PANEL_PAGES,
  'c/dismissNotice': NOTICE_PAGES,
  'c/setPack': SETTINGS_PAGES,
  'c/setGpc': SETTINGS_PAGES,
  'c/setPopupMode': SETTINGS_PAGES,
  'c/setPopupNotice': SETTINGS_PAGES,
  'c/setSitePopupPolicy': SETTINGS_PAGES,
  // The handlers re-check sender, frame and tab (P2-20, P2-21, P2-55).
  'c/startPicker': PANEL_PAGES,
  'c/saveUserFilter': new Set(['/picker-panel.html']),
  'c/removeUserFilter': new Set(['/popup.html', '/dashboard.html', '/picker-panel.html']),
  'c/proceedOnce': new Set(['/blocked.html']),
  ...SETTINGS_PAGE_PAGES_OF,
};

/** True when `type` is not page-bound, or `sender` is one of its pages (path on our origin; the origin is checked by the sender policy). */
function fromAllowedPage(type: MessageType, sender: SenderInfo): boolean {
  const pages = PAGES_OF[type];
  if (pages === undefined) return true;
  return sender.url !== undefined && URL.canParse(sender.url) && pages.has(new URL(sender.url).pathname);
}

const notAvailable = (type: string): Promise<Response<never>> => Promise.resolve(failure({ code: 'not-implemented', message: `${type} is not available yet` }));

async function reconcile(ctx: MessageContext): Promise<Response<ReconcileSummary>> {
  try {
    const { status, skippedPacks } = await ctx.reconciler.request('command');
    return status === 'failed'
      ? failure({ code: 'internal', message: 'reconcile failed' })
      : { ok: true, data: { status, skippedPacks } };
  } catch (error) {
    ctx.ports.log.error('command failed', error);
    return failure({ code: 'internal', message: 'command failed' });
  }
}

function dispatch(message: ParsedMessage, sender: SenderInfo, ctx: MessageContext): Promise<Response<Answer>> {
  switch (message.type) {
    case 'c/reconcile':
      return reconcile(ctx);
    case 'q/tabState':
      return tabState(message.payload.tabId, ctx);
    case 'q/matchedRules':
      return matchedRules(message.payload.tabId, ctx.ports);
    case 'c/setSiteLevel':
      return setSiteLevel(message.payload.hostname as Hostname, message.payload.level, ctx);
    case 'c/pauseSite':
      return pauseSite(message.payload.hostname as Hostname, message.payload.minutes, ctx);
    case 'c/dismissNotice':
      return dismissNotice(ctx);
    case 'c/setPack':
      return setPack(message.payload.pack as PackId, message.payload.enabled, ctx);
    case 'c/setGpc':
      return setGpc(message.payload.enabled, ctx);
    case 'c/setPopupNotice':
      return setPopupNotice(message.payload.enabled, ctx);
    case 'c/setPopupMode':
      return setPopupMode(message.payload.mode, ctx);
    case 'c/setSitePopupPolicy':
      return setSitePopupPolicy(message.payload.hostname as Hostname, message.payload.policy, ctx);
    case 'cs/cssFallback':
      return cssFallback(message.payload.registration, sender, ctx.ports);
    case 'c/startPicker':
      return ctx.features?.startPicker(message.payload, sender) ?? notAvailable(message.type);
    case 'c/saveUserFilter':
      return ctx.features?.userFilters.save(message.payload, sender) ?? notAvailable(message.type);
    case 'c/removeUserFilter':
      return ctx.features?.userFilters.remove(message.payload, sender) ?? notAvailable(message.type);
    case 'c/proceedOnce':
      return ctx.features?.proceedOnce.handle(message.payload, sender) ?? notAvailable(message.type);
    default:
      return (dispatchSettingsPage(message, ctx) as Promise<Response<Answer>> | null) ?? notAvailable(message.type);
  }
}

export async function handleMessage(raw: unknown, sender: SenderInfo, ctx: MessageContext): Promise<Response<Answer>> {
  const parsed = parseMessage(raw, sender, ctx.runtimeId);
  if (!parsed.ok) {
    ctx.ports.log.warn(`message rejected: ${parsed.errors.code}`);
    return failure(parsed.errors);
  }
  if (!fromAllowedPage(parsed.value.type, sender)) {
    return failure({ code: 'forbidden-sender', message: `sender may not send ${parsed.value.type}` });
  }
  try {
    return await dispatch(parsed.value, sender, ctx);
  } catch (error) {
    // Handlers answer their own failures; one that throws is a bug, logged with its cause (P2-44).
    ctx.ports.log.error(`${parsed.value.type} failed`, error);
    return failure({ code: 'internal', message: 'internal error' });
  }
}
