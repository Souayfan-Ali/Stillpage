/**
 * The blocked page (P2-55, pop-up notes §6.2, UI notes §6a): no framework. It parses the fragment as hostile
 * input, decides with the §6.2 table, and either closes its own tab (a pop-up nobody asked for; nothing
 * is drawn first) or shows the host as text with Go back / Close tab / Proceed once. "Proceed once"
 * asks the worker (`c/proceedOnce`) and only after it agrees replaces the page with the parsed address.
 * On a lifted destination (D-55a) Proceed once covers one exact address, so that address is shown too,
 * as text and without its fragment, so the user approves what the rule will cover. P3-19: the product name
 * beside the mark in the band (E22); Proceed once is a text link under the two safe buttons (E23).
 */
import { decideBlockedPage, type BlockedDecision } from '../../core/blocked/decide.js';
import { parseBlockedFragment, senderHost, type BlockedTarget } from '../../core/blocked/fragment.js';
import { liftedProceedUrl } from '../../core/blocked/proceed.js';
import { PRODUCT_NAME } from '../../core/brand.js';
import { t } from '../../ui/i18n.js';

export interface BlockedDeps {
  readonly document: Document;
  readonly hash: string;
  readonly referrer: string;
  readonly historyLength: number;
  readonly currentTab: () => Promise<{ readonly id: number; readonly openerTabId?: number } | null>;
  /** The opener sentinel's answers (`x/openedCheck`, `x/linkClickCheck`); both `false` when no sentinel answers in time. */
  readonly askOpener: (openerTabId: number, host: string) => Promise<{ readonly scriptOpened: boolean; readonly linkClick: boolean }>;
  readonly closeTab: (tabId: number) => Promise<void>;
  /** `x/popupClosed` to the opener's sentinel; no sentinel, no notice. */
  readonly notifyOpener?: (openerTabId: number, host: string) => Promise<void>;
  readonly goBack: () => void;
  /** `c/proceedOnce`; resolves `true` only when the worker added the rule. */
  readonly proceed: (host: string) => Promise<boolean>;
  readonly navigate: (url: string) => void;
  /** `window.top !== window`: a framed copy does nothing (security review MEDIUM-3). */
  readonly framed: boolean;
  /**
   * Whether this click on "Proceed once" is the user's (`isRealClick` with `navigator.userActivation.isActive`).
   * Activation alone is not enough: Chromium starts this page with transient activation (J15, measured).
   */
  readonly userActive: (click: Event) => boolean;
  /** Whether `host` is a lifted destination (`popup-lifted.json`, D-55a); absent or failing: not lifted. */
  readonly isLifted?: (host: string) => Promise<boolean>;
}

/** A trusted click while the page has transient activation: never a script's click (J15). */
export const isRealClick = (click: Event, active: boolean): boolean => click.isTrusted && active;

const PROCEED_FAILED = t('blocked_proceed_failed');
type Stay = Extract<BlockedDecision, { kind: 'stay' }>;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The gradient band with the mark (CSS) and the product name beside it, as the first-run page shows it. */
function band(doc: Document): HTMLElement {
  const box = el(doc, 'div');
  box.className = 'band';
  const name = el(doc, 'p', PRODUCT_NAME);
  name.className = 'brand';
  box.append(name);
  return box;
}

function button(doc: Document, text: string, onClick: (e: Event) => void, kind: 'primary' | 'link' | '' = ''): HTMLButtonElement {
  const b = el(doc, 'button', text);
  b.type = 'button';
  if (kind !== '') b.className = kind;
  b.addEventListener('click', onClick);
  return b;
}

/** "Proceed once opens only this address: <url>" for a lifted host; the address is text in `<code>`. */
function exactUrlLine(doc: Document, target: BlockedTarget): HTMLElement | null {
  const url = liftedProceedUrl(target.url, target.host);
  if (url === null) return null;
  const line = el(doc, 'p', `${t('blocked_exact_url')} `);
  line.setAttribute('data-exact-url', '');
  line.append(el(doc, 'code', url));
  return line;
}

function intro(doc: Document, target: BlockedTarget | null, decision: Stay, sender: string | null, lifted: boolean): HTMLElement[] {
  const out: HTMLElement[] = [el(doc, 'h1', t('blocked_heading'))];
  if (target !== null) {
    const p = el(doc, 'p');
    // The host in bold where the message puts it; the host is text, never markup.
    const [before = '', ...after] = t('blocked_listed', target.host).split(target.host);
    p.append(before, el(doc, 'strong', target.host), after.join(target.host));
    out.push(p);
    const exact = lifted ? exactUrlLine(doc, target) : null;
    if (exact !== null) out.push(exact);
  }
  if (decision.reason === 'link') {
    const line = el(doc, 'p', t('blocked_link'));
    line.setAttribute('data-reason', '');
    out.push(line);
  }
  if (sender !== null && decision.primary === 'go-back') {
    const line = el(doc, 'p', t('blocked_sender', sender));
    line.setAttribute('data-sender', '');
    out.push(line);
  }
  return out;
}

/**
 * Where Proceed once goes: on a lifted host exactly the address its rule names, without the fragment
 * (Chromium matches a navigation with its fragment, so `#…` would miss the exact-URL rule, D-55a).
 */
const proceedTo = (target: BlockedTarget, lifted: boolean): string => (lifted ? liftedProceedUrl(target.url, target.host) ?? target.url : target.url);

function proceedButton(deps: BlockedDeps, target: BlockedTarget, alert: HTMLElement, lifted: boolean): HTMLButtonElement {
  const b = button(deps.document, t('blocked_proceed'), (e) => {
    if (!deps.userActive(e)) return;
    b.disabled = true;
    alert.textContent = '';
    void deps.proceed(target.host).catch(() => false).then((ok) => {
      if (ok) deps.navigate(proceedTo(target, lifted));
      else {
        b.disabled = false;
        alert.textContent = PROCEED_FAILED;
      }
    });
  }, 'link');
  return b;
}

function render(deps: BlockedDeps, target: BlockedTarget | null, decision: Stay, tabId: number | null, lifted: boolean): void {
  const doc = deps.document;
  const alert = el(doc, 'p');
  alert.setAttribute('role', 'alert');
  const close = (): void => { if (tabId !== null) void deps.closeTab(tabId); };
  const goBack = button(doc, t('blocked_go_back'), deps.goBack, 'primary');
  const closeTab = button(doc, t('blocked_close_tab'), close, decision.primary === 'close-tab' ? 'primary' : '');
  const actions = el(doc, 'div');
  actions.className = 'actions';
  actions.append(...(decision.primary === 'go-back' ? [goBack, closeTab] : [closeTab]));
  const proceed = el(doc, 'p');
  proceed.className = 'proceed';
  if (target !== null) proceed.append(proceedButton(deps, target, alert, lifted));
  const why = el(doc, 'details');
  why.append(el(doc, 'summary', t('blocked_why')), el(doc, 'p', t('blocked_why_text')));
  const main = el(doc, 'main');
  main.append(band(doc), ...intro(doc, target, decision, senderHost(deps.referrer), lifted), actions, ...(target === null ? [] : [proceed]), alert, why);
  doc.body.replaceChildren(main);
  // Focus on the primary button (UI notes §9): Enter does the safe thing.
  (decision.primary === 'go-back' ? goBack : closeTab).focus();
}

/** Shown when the page itself failed: still a page with a way out, never a blank tab. */
export function renderFallback(deps: Pick<BlockedDeps, 'document' | 'goBack'>): void {
  const main = el(deps.document, 'main');
  const back = button(deps.document, t('blocked_go_back'), deps.goBack, 'primary');
  main.append(band(deps.document), el(deps.document, 'h1', t('blocked_heading')), back);
  deps.document.body.replaceChildren(main);
  back.focus();
}

/** Runs the page; resolves with what it did. A framed copy draws nothing and acts on nothing. */
export async function runBlockedPage(deps: BlockedDeps): Promise<'closed' | 'shown' | 'framed'> {
  if (deps.framed) return 'framed';
  const target = parseBlockedFragment(deps.hash);
  const tab = await deps.currentTab().catch(() => null);
  const opener = tab?.openerTabId;
  const fresh = deps.historyLength <= 1;
  const none = { scriptOpened: false, linkClick: false };
  const answer = target !== null && fresh && opener !== undefined ? await deps.askOpener(opener, target.host).catch(() => none) : none;
  const decision = decideBlockedPage({ historyLength: deps.historyLength, hasOpener: opener !== undefined, openerReportsScriptOpen: answer.scriptOpened, openerReportsLinkClick: answer.linkClick });
  if (decision.kind === 'close' && tab !== null && target !== null) {
    // If Chrome refuses to close the tab, the page is shown instead of a blank tab (security review MEDIUM-2).
    if (opener !== undefined) void deps.notifyOpener?.(opener, target.host).catch(() => undefined);
    if (await deps.closeTab(tab.id).then(() => true, () => false)) return 'closed';
  }
  const stay: Stay = decision.kind === 'stay' ? decision : { kind: 'stay', primary: 'close-tab', reason: 'listed' };
  const lifted = target !== null && deps.isLifted !== undefined ? await deps.isLifted(target.host).catch(() => false) : false;
  render(deps, target, stay, tab?.id ?? null, lifted);
  return 'shown';
}
