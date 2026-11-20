/**
 * The state hero of the toolbar panel (P3-18): one tinted card per state, coloured by it (protected
 * green-teal, paused and needs-attention amber, off and no access neutral), with a large badge whose glyph
 * names the state by shape, the site as the panel's heading and the state line with its actions.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { Glyph, type GlyphName } from '../../ui/Glyph.js';
import type { IconName } from '../../ui/Icon.js';
import type { Header } from './header.js';
import { StateHeader } from './StateHeader.js';
import type { PopupStore, View } from './store.js';
import { STRINGS } from './strings.js';
import styles from './Hero.module.css';

/** The hero's colour: the header's tone, except that a pause reads as amber (it ends by itself). */
type HeroTone = Header['tone'] | 'paused';

const BADGES: Readonly<Record<IconName, GlyphName>> = {
  on: 'shield',
  off: 'power',
  paused: 'pause',
  reduced: 'alert',
  warning: 'alert',
  unavailable: 'lock',
  pending: 'clock',
};

const BADGE_SIZE = 22;

/** An action can remove the button that had focus; then focus goes to the host heading (WCAG 2.4.3). */
function keepFocus(target: HTMLElement | null): void {
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected) target?.focus();
}

function Card({ tone, badge, children }: { readonly tone: HeroTone; readonly badge: GlyphName; readonly children: ComponentChildren }): JSX.Element {
  return (
    <div class={styles['hero']} data-tone={tone}>
      <span class={styles['badge']}>
        <Glyph name={badge} size={BADGE_SIZE} />
      </span>
      <div class={styles['body']}>{children}</div>
    </div>
  );
}

export function Hero({ store, view, header }: { readonly store: PopupStore; readonly view: View; readonly header: Header | null }): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  if (view.kind === 'loading') {
    return (
      <Card tone="neutral" badge="clock">
        <p class={styles['stateText']}>{STRINGS.loading}</p>
      </Card>
    );
  }
  if (view.kind === 'unavailable' || header === null) {
    return (
      <Card tone="neutral" badge="lock">
        <p class={styles['stateText']} data-state="unavailable">
          <span role="status">{STRINGS.unavailable}</span>
        </p>
      </Card>
    );
  }
  return (
    <Card tone={header.kind === 'paused' ? 'paused' : header.tone} badge={BADGES[header.icon]}>
      <h2 class={styles['host']} tabIndex={-1} ref={heading}>
        {view.state.host ?? STRINGS.noHost}
      </h2>
      <StateHeader
        header={header}
        onAction={(action) => {
          void store.act(action).then(() => {
            keepFocus(heading.current);
          });
        }}
      />
      {view.state.lastRun === 'failed' ? (
        <p class={styles['retry']} data-state="retrying">
          <Glyph name="alert" />
          <span>{STRINGS.retrying}</span>
        </p>
      ) : null}
    </Card>
  );
}
