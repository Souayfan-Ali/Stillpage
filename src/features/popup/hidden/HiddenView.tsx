/**
 * The toolbar panel's "Show on page" view (P2-22b, D-50, UI notes §5): the hidden items that apply on this
 * tab's site, each with a toggle that outlines it on the page for a while (`showOnPage`, injected by the
 * panel itself) and, with the `remove` port, Remove (P3-17: `c/removeUserFilter`, as the dashboard's
 * Remove: no confirmation, no undo). Selectors are drawn as text only. Leaving the view, or the panel
 * closing, reverts the page. After a removal, focus goes to the Remove button now at the same place, or
 * to the heading when the list is empty (WCAG 2.4.3, as the dashboard). No dashboard link of its own: the
 * panel footer's "Hidden items" stays on screen and is the one path there (D-103).
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from '../../../ui/Button.js';
import { createPreview, SHOW_MS, type Preview } from './preview.js';
import { showOnPage } from './showOnPage.js';
import { SHOW_STRINGS } from './strings.js';
import styles from './Hidden.module.css';

/** Runs a packaged function in the tab's top frame (`scripting.executeScript`); resolves with its answer. */
type InjectInTab = (tabId: number, func: typeof showOnPage, args: Parameters<typeof showOnPage>) => Promise<unknown>;

export interface HiddenDeps {
  readonly inject: InjectInTab;
  /** `c/removeUserFilter` for `host` (P3-17); resolves true when the worker removed it. No port, no Remove. */
  readonly remove?: (host: string, selector: string) => Promise<boolean>;
}

export interface HiddenViewProps {
  readonly deps: HiddenDeps;
  readonly tabId: number;
  readonly host: string;
  readonly selectors: readonly string[];
  readonly onBack: () => void;
  /** An item was removed: the panel reads its state again (counts, the entry). */
  readonly onRemoved?: () => void;
}

/** The Remove buttons of the list (Show is a toggle: it always carries `aria-pressed`). */
const REMOVE_BUTTONS = 'li button:not([aria-pressed])'; // i18n-exempt: a selector

/** Reverts on unmount and when the panel's page goes away (best effort: the page's own timer is the guarantee). */
function useRevertOnLeave(preview: Preview): void {
  useEffect(() => {
    const stop = (): void => {
      preview.stop();
    };
    addEventListener('pagehide', stop);
    return () => {
      removeEventListener('pagehide', stop);
      stop();
    };
  }, [preview]);
}

interface ItemProps {
  readonly selector: string;
  readonly host: string;
  readonly preview: Preview;
  readonly onShow: (selector: string) => void;
  readonly onRemove: ((selector: string) => void) | null;
}

function Item({ selector, host, preview, onShow, onRemove }: ItemProps): JSX.Element {
  return (
    <li class={styles['item']}>
      <code>{selector}</code>
      <span class={styles['actions']}>
        <Button
          pressed={preview.active.value === selector}
          label={SHOW_STRINGS.showLabel(selector)}
          onClick={() => {
            onShow(selector);
          }}
        >
          {SHOW_STRINGS.show}
        </Button>
        {onRemove === null ? null : (
          <Button label={SHOW_STRINGS.removeLabel(selector, host)} onClick={() => { onRemove(selector); }}>
            {SHOW_STRINGS.remove}
          </Button>
        )}
      </span>
    </li>
  );
}

/** Removal state: items gone (immutable set), the last word, and where focus goes once the list is drawn. */
function useRemoval(props: HiddenViewProps, preview: Preview, list: { readonly current: HTMLUListElement | null }, heading: { readonly current: HTMLElement | null }) {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState<string | null>(null);
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const shown = props.selectors.filter((s) => !gone.has(s));
  useEffect(() => {
    if (focusAt === null) return;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(REMOVE_BUTTONS) ?? [];
    const target = buttons.length === 0 ? heading.current : buttons[Math.min(focusAt, buttons.length - 1)];
    target?.focus();
    setFocusAt(null);
  }, [focusAt, shown.length, list, heading]);
  const { remove } = props.deps;
  const onRemove = remove === undefined ? null : (selector: string): void => {
    if (preview.active.value === selector) preview.stop();
    const at = shown.indexOf(selector);
    void remove(props.host, selector).catch(() => false).then((ok) => {
      setSaid(ok ? SHOW_STRINGS.removed : SHOW_STRINGS.removeFailed);
      if (!ok) return;
      setGone((before) => new Set([...before, selector]));
      setFocusAt(Math.max(at, 0));
      props.onRemoved?.();
    });
  };
  return { shown, said, onRemove, clearSaid: () => { setSaid(null); } };
}

export function HiddenView(props: HiddenViewProps): JSX.Element {
  const { deps, tabId, host, onBack } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const preview = useMemo(() => createPreview((selector, ms) => deps.inject(tabId, showOnPage, [selector, ms, host])), [deps, tabId, host]);
  useRevertOnLeave(preview);
  const { shown, said, onRemove, clearSaid } = useRemoval(props, preview, list, heading);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  // A press of Show speaks for itself again: the last word on a removal gives way.
  const onShow = (selector: string): void => {
    clearSaid();
    void preview.toggle(selector);
  };
  return (
    <section class={styles['view']} aria-labelledby="hidden-title">
      <div class={styles['bar']}>
        <Button variant="quiet" onClick={onBack}>
          <span class="mirror-rtl" aria-hidden="true">←</span>{' '}
          {SHOW_STRINGS.back}
        </Button>
        <h2 id="hidden-title" class={styles['title']} tabIndex={-1} ref={heading}>
          {SHOW_STRINGS.title(host)}
        </h2>
      </div>
      <p class={styles['note']}>{shown.length === 0 ? SHOW_STRINGS.empty : SHOW_STRINGS.intro(SHOW_MS)}</p>
      <ul class={styles['list']} ref={list}>
        {shown.map((selector) => (
          <Item key={selector} selector={selector} host={host} preview={preview} onShow={onShow} onRemove={onRemove} />
        ))}
      </ul>
      <p class={styles['status']} role="status" aria-live="polite">
        {said ?? preview.status.value}
      </p>
    </section>
  );
}
