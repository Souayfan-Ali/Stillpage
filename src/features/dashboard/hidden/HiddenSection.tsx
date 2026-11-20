/**
 * Hidden items (P2-22, UI notes §5, §8): everything hidden with the element hider, grouped by site, each
 * with Remove (`c/removeUserFilter`; the dashboard then reads the snapshot again). Native buttons with
 * names that start with their visible word (WCAG 2.5.3); a heading and a list per site; selectors shown
 * as text. After a removal, focus goes to the Remove button now at the same place, or to the list
 * heading when the list is empty (WCAG 2.4.3). The intro shows only with items; empty, a card says how (C14).
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import { Banner } from '../../../ui/Banner.js';
import { Button } from '../../../ui/Button.js';
import type { DashboardStore } from '../store.js';
import { HIDDEN_STRINGS as S } from './strings.js';
import styles from '../Dashboard.module.css';

export interface HiddenSectionProps {
  readonly store: DashboardStore;
  readonly data: Dashboard;
}

/** The Remove buttons of the list (the only labelled buttons in the section). */
const REMOVE_BUTTONS = 'li button[aria-label]'; // i18n-exempt: a selector

type Site = NonNullable<Dashboard['hidden']>[number];

interface SiteProps {
  readonly site: Site;
  readonly index: number;
  readonly onRemove: (site: Site, selector: string) => void;
}

function SiteBlock({ site, index, onRemove }: SiteProps): JSX.Element {
  const id = `hidden-site-${String(index)}`;
  return (
    <section class={styles['block']} aria-labelledby={id}>
      <h2 class={styles['heading']} id={id}>
        {site.host}
      </h2>
      <ul class={styles['list']}>
        {site.selectors.map((selector) => (
          <li key={selector} class={styles['row']}>
            <code>{selector}</code>
            <Button
              label={S.removeLabel(selector, site.host)}
              onClick={() => {
                onRemove(site, selector);
              }}
            >
              {S.remove}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Focus after a removal: the Remove button at `index` (or the last one), else the heading. */
function useFocusAfterRemove(container: { readonly current: HTMLElement | null }, heading: { readonly current: HTMLElement | null }, data: Dashboard) {
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    if (pending === null) return;
    const buttons = container.current?.querySelectorAll<HTMLButtonElement>(REMOVE_BUTTONS) ?? [];
    const target = buttons.length === 0 ? heading.current : buttons[Math.min(pending, buttons.length - 1)];
    target?.focus();
    setPending(null);
  }, [data, pending, container, heading]);
  return setPending;
}

/** The intro, or the empty card's heading: where focus goes when the list empties. */
interface FocusRef { current: HTMLElement | null }

function Empty({ focusRef }: { readonly focusRef: FocusRef }): JSX.Element {
  return (
    <div class={styles['emptyCard']}>
      <h2 class={styles['heading']} id="hidden-heading" tabIndex={-1} ref={focusRef as { current: HTMLHeadingElement | null }}>
        {S.emptyHeading}
      </h2>
      <p class={styles['muted']}>{S.empty}</p>
    </div>
  );
}

function List({ data, onRemove, focusRef }: { readonly data: Dashboard; readonly onRemove: SiteProps['onRemove']; readonly focusRef: FocusRef }): JSX.Element {
  const hidden = data.hidden ?? [];
  if (data.hidden === null) return <Banner tone="error" icon="unavailable" text={S.unreadable} />;
  if (hidden.length === 0) return <Empty focusRef={focusRef} />;
  const items = hidden.reduce((n, site) => n + site.selectors.length, 0);
  return (
    <>
      <p class={styles['muted']} id="hidden-heading" tabIndex={-1} ref={focusRef as { current: HTMLParagraphElement | null }}>
        {S.intro}
      </p>
      <p>{S.summary(items, hidden.length)}</p>
      {hidden.map((site, index) => (
        <SiteBlock key={site.host} site={site} index={index} onRemove={onRemove} />
      ))}
    </>
  );
}

export function HiddenSection({ store, data }: HiddenSectionProps): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  const focusAt = useFocusAfterRemove(container, heading, data);
  const remove = (site: Site, selector: string): void => {
    const buttons = [...(container.current?.querySelectorAll(REMOVE_BUTTONS) ?? [])];
    const at = buttons.findIndex((b) => b.getAttribute('aria-label') === S.removeLabel(selector, site.host));
    void store.run('c/removeUserFilter', { hostname: site.host, selector }).then((ok) => {
      if (!ok) return;
      store.say(S.removed);
      focusAt(Math.max(at, 0));
    });
  };
  return (
    <div class={styles['section']} ref={container}>
      <List data={data} onRemove={remove} focusRef={heading} />
    </div>
  );
}
