/**
 * The toolbar panel's main view (P1-40…P2-60b; P3-18 layout): the state hero, the coloured level control,
 * one row of actions ("Hide something" filled, "Pause on this site" tinted), the blocked-requests card, the
 * pop-up row, the sub-view entries as one grouped card of rows (leading glyph, trailing chevron) and the
 * result of the last action as a coloured inline banner. Order is reading and Tab order.
 */
import type { JSX } from 'preact';
import { Button } from '../../ui/Button.js';
import { Glyph, type GlyphName } from '../../ui/Glyph.js';
import type { Hostname } from '../../core/ids.js';
import { headerOf, type Header } from './header.js';
import { Hero } from './Hero.js';
import { LevelSelector } from './LevelSelector.js';
import { PauseMenu } from './PauseMenu.js';
import { BlockedCard } from './privacy/BlockedCard.js';
import type { PrivacyStore } from './privacy/privacyStore.js';
import type { Screens } from './screens.js';
import { useChunk } from './lazy.js';
import type { PopupRow as PopupRowType, PopupRowDeps } from './popupRow/PopupRow.js';
import type { HiddenDeps } from './hidden/HiddenView.js';
import { SHOW_STRINGS } from './hidden/strings.js';
import type { PopupStore, View } from './store.js';
import { STRINGS } from './strings.js';
import styles from './Popup.module.css';

export type Ready = Extract<View, { kind: 'ready' }>;

export const isWeb = (view: View): view is Ready => view.kind === 'ready' && view.state.page === 'web';

/** "What you hid on this site (N)" (P2-22b): on a web page with a host and at least one item. */
const canShowHidden = (view: View): view is Ready => isWeb(view) && view.state.host !== null && view.state.hidden.length > 0;

/** The pop-up row is its own chunk (P2-60b: the panel had ≈ 1.5 kB left). */
const loadPopupRow = (): Promise<typeof PopupRowType> => import('./popupRow/PopupRow.js').then((m) => m.PopupRow);

/** The pop-up row where pop-ups apply: a web page with a host, at Standard or Thorough (UI notes §3). */
function LazyPopupRow({ deps, view, store }: { readonly deps: PopupRowDeps; readonly view: Ready; readonly store: PopupStore }): JSX.Element | null {
  const { host, level } = view.state;
  const shown = host !== null && (level === 'standard' || level === 'thorough');
  const Row = useChunk(shown, loadPopupRow);
  if (!shown || Row === null || Row === 'failed') return null;
  return <Row deps={deps} state={view.state} host={host as Hostname} tabId={view.tabId} onChanged={() => void store.load()} />;
}

/** The level control and the action row (only where a level can be set; "Hide something" on web pages). */
function Controls({ store, view, header }: { readonly store: PopupStore; readonly view: View; readonly header: Header | null }): JSX.Element | null {
  if (view.kind !== 'ready') return null;
  const levels = header?.showsLevels === true;
  const canPause = levels && view.state.host !== null && view.state.level !== 'off';
  const canHide = isWeb(view);
  return (
    <>
      {levels ? <LevelSelector state={view.state} onChoose={(level) => void store.chooseLevel(level)} /> : null}
      {canHide || canPause ? (
        <div class={styles['actionRow']}>
          {canHide ? (
            <Button
              variant="primary"
              onClick={() => {
                // "Hide something" (P2-21): the panel closes so the page (and the picker in it) gets the keyboard.
                void store.hideSomething().then((started) => { if (started) window.close(); });
              }}
            >
              <Glyph name="eyeOff" />
              {STRINGS.hideSomething}
            </Button>
          ) : null}
          {canPause ? <PauseMenu onChoose={(choice) => void store.pause(choice)} /> : null}
        </div>
      ) : null}
    </>
  );
}

function SubViewEntry({ screens, to, text, glyph }: { readonly screens: Screens; readonly to: 'breakage' | 'hidden'; readonly text: string; readonly glyph: GlyphName }): JSX.Element {
  return (
    <button type="button" class={styles['link']} data-opens={to} onClick={() => { screens.open(to); }}>
      <span class={styles['linkIcon']}>
        <Glyph name={glyph} />
      </span>
      <span class={styles['linkText']}>{text}</span>
      <Glyph name="chevron" class={`mirror-rtl ${styles['chevron'] ?? ''}`} />
    </button>
  );
}

/** The last action's result: kept in the tree while empty (its first message is announced), a banner when filled. */
function StatusLine({ store }: { readonly store: PopupStore }): JSX.Element {
  const text = store.status.value;
  const reload = store.reloadOffered.value;
  return (
    <div class={styles['notice']} data-filled={text === '' ? undefined : ''} data-reload={reload ? '' : undefined}>
      {text === '' ? null : <Glyph name={reload ? 'check' : 'info'} class={styles['noticeIcon']} />}
      <p class={styles['status']} role="status" aria-live="polite">
        {text}
      </p>
      {reload ? (
        <Button onClick={() => void store.reload()}>
          {STRINGS.reloadPage}
        </Button>
      ) : null}
    </div>
  );
}

export interface MainViewProps {
  readonly store: PopupStore;
  readonly view: View;
  readonly now: () => number;
  readonly privacy: PrivacyStore | undefined;
  readonly canFix: boolean;
  readonly screens: Screens;
  readonly popupRow: PopupRowDeps | undefined;
  readonly hidden: HiddenDeps | undefined;
}

export function MainView({ store, view, now, privacy, canFix, screens, popupRow, hidden }: MainViewProps): JSX.Element {
  const header = view.kind === 'ready' ? headerOf(view.state, now()) : null;
  const showHidden = hidden !== undefined && canShowHidden(view);
  return (
    <>
      <Hero store={store} view={view} header={header} />
      <Controls store={store} view={view} header={header} />
      {privacy !== undefined && isWeb(view) ? <BlockedCard matched={privacy.matched.value} onOpen={() => { screens.open('privacy'); }} /> : null}
      {popupRow !== undefined && isWeb(view) && header?.showsLevels === true ? <LazyPopupRow deps={popupRow} view={view} store={store} /> : null}
      {showHidden || canFix ? (
        <div class={styles['links']}>
          {showHidden ? <SubViewEntry screens={screens} to="hidden" glyph="eyeOff" text={SHOW_STRINGS.open(view.state.hidden.length)} /> : null}
          {canFix ? <SubViewEntry screens={screens} to="breakage" glyph="wrench" text={STRINGS.somethingWrong} /> : null}
        </div>
      ) : null}
      <StatusLine store={store} />
    </>
  );
}
