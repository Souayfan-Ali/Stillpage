/**
 * The toolbar panel (P1-40, P1-41, UI notes §3). Renders its shell synchronously, before any
 * `chrome.*` call (S-06), then fills in when the worker answers `q/tabState`.
 */
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { PRODUCT_NAME } from '../../core/brand.js';
import { BrandMark } from '../../ui/BrandMark.js';
import { Footer } from './Footer.js';
import { isWeb, MainView, type Ready } from './MainView.js';
import type { PrivacyStore } from './privacy/privacyStore.js';
import { PrivacyView } from './privacy/PrivacyView.js';
import { useScreens, type Screens } from './screens.js';
import type { BreakageDeps, BreakageScreen as BreakageScreenType } from './breakage/BreakageScreen.js';
import { useChunk, type Chunk as ChunkOf } from './lazy.js';
import type { PopupRowDeps } from './popupRow/PopupRow.js';
import type { HiddenDeps, HiddenView as HiddenViewType } from './hidden/HiddenView.js';
import type { Hostname } from '../../core/ids.js';
import type { PopupStore, View } from './store.js';
import { STRINGS } from './strings.js';
import type { TabState } from '../../core/messaging/tabState.js';
import styles from './Popup.module.css';

export interface PopupAppProps {
  readonly store: PopupStore;
  readonly now: () => number;
  /** Applies the theme setting to the document (manual override of `prefers-color-scheme`). */
  readonly applyTheme?: (theme: TabState['theme']) => void;
  /** This build's version, for the rules date in the footer. */
  readonly version?: string;
  /** The privacy panel's data (P2-12); without it the card and view are not drawn. */
  readonly privacy?: PrivacyStore;
  /** The breakage flow's ports (P2-14); without them "Something wrong with this page?" is not drawn. */
  readonly breakage?: BreakageDeps;
  /** The pop-up row's ports (P2-60b); without them the row is not drawn. */
  readonly popupRow?: PopupRowDeps;
  /** "Show on page" (P2-22b); without it the hidden-items view is not drawn. */
  readonly hidden?: HiddenDeps;
}

/** The breakage view is its own chunk, loaded when first opened (design review, P2-14: popup JS budget). */
type Chunk = ChunkOf<typeof BreakageScreenType>;
const loadBreakage = (): Promise<typeof BreakageScreenType> => import('./breakage/BreakageScreen.js').then((m) => m.BreakageScreen);
/** "Show on page" is its own chunk, loaded when first opened (P2-22b). */
type HiddenChunk = ChunkOf<typeof HiddenViewType>;
const loadHidden = (): Promise<typeof HiddenViewType> => import('./hidden/HiddenView.js').then((m) => m.HiddenView);

interface SubViewProps {
  readonly screens: Screens;
  readonly view: View;
  readonly privacy: PrivacyStore | undefined;
  readonly breakage: BreakageDeps | undefined;
  readonly Breakage: Chunk;
  readonly hidden: HiddenDeps | undefined;
  readonly Hidden: HiddenChunk;
  readonly reload: () => void;
}

interface HiddenPartProps { readonly deps: HiddenDeps; readonly view: Ready; readonly Hidden: HiddenChunk; readonly back: () => void; readonly reload: () => void }

function HiddenPart({ deps, view, Hidden, back, reload }: HiddenPartProps): JSX.Element {
  if (Hidden === 'failed') return <p role="status">{STRINGS.chunkFailed}</p>;
  if (Hidden === null) return <p>{STRINGS.loading}</p>;
  return <Hidden deps={deps} tabId={view.tabId} host={view.state.host ?? ''} selectors={view.state.hidden} onBack={back} onRemoved={reload} />;
}

/** The open view stays drawn when its last item is removed there (P3-17); the entry needs one item. */
const canStayInHidden = (view: View): view is Ready => isWeb(view) && view.state.host !== null;

function SubView({ screens, view, privacy, breakage, Breakage, hidden, Hidden, reload }: SubViewProps): JSX.Element | null {
  const back = (): void => {
    screens.back();
  };
  const host = view.kind === 'ready' ? view.state.host : null;
  if (screens.screen === 'privacy' && privacy !== undefined) return <PrivacyView store={privacy} host={host} onBack={back} />;
  if (screens.screen === 'hidden' && hidden !== undefined && canStayInHidden(view)) return <HiddenPart deps={hidden} view={view} Hidden={Hidden} back={back} reload={reload} />;
  if (screens.screen === 'breakage' && breakage !== undefined && isWeb(view) && host !== null) {
    if (Breakage === 'failed') return <p role="status">{STRINGS.chunkFailed}</p>;
    return Breakage === null ? <p>{STRINGS.loading}</p> : <Breakage deps={breakage} tabId={view.tabId} host={host as Hostname} onBack={back} />;
  }
  return null;
}

export function PopupApp({ store, now, applyTheme, version, privacy, breakage, popupRow, hidden }: PopupAppProps): JSX.Element {
  const view = store.view.value;
  const theme = view.kind === 'ready' ? view.state.theme : 'system';
  const screens = useScreens();
  const webTab = isWeb(view) ? view.tabId : null;
  useEffect(() => {
    applyTheme?.(theme);
  }, [theme, applyTheme]);
  useEffect(() => {
    if (webTab !== null) void privacy?.load(webTab);
  }, [webTab, privacy]);
  const canFix = breakage !== undefined && isWeb(view) && view.state.host !== null;
  const Breakage = useChunk(screens.screen === 'breakage', loadBreakage);
  const Hidden = useChunk(screens.screen === 'hidden', loadHidden);
  // A sub-view that can no longer be drawn (the tab left the page) falls back to the main view (review MEDIUM).
  const sub = SubView({ screens, view, privacy, breakage, Breakage, hidden, Hidden, reload: () => void store.load() });
  return (
    <div class={styles['panel']}>
      <header class={styles['top']}>
        <span class={styles['markTile']}>
          <BrandMark size={20} />
        </span>
        <h1 class={styles['brand']}>{PRODUCT_NAME}</h1>
      </header>
      <main class={styles['main']}>
        {screens.screen === 'main' || sub === null ? <MainView store={store} view={view} now={now} privacy={privacy} canFix={canFix} screens={screens} popupRow={popupRow} hidden={hidden} /> : sub}
      </main>
      {version === undefined ? null : <Footer version={version} hiddenLink={view.kind === 'ready'} />}
    </div>
  );
}
