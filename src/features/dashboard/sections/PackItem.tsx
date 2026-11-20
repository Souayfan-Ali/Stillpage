/**
 * One pack row (P2-34, UI notes §8): a native checkbox with the pack's outcome as its label, its cost
 * line, an inline error when it was refused (`role="alert"`, tied to the checkbox), and "Details" with
 * the upstream lists, their licences and homepages, and the rule ceiling.
 */
import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import type { PackRow } from '../../../core/messaging/dashboard.js';
import { LISTS, PACK_LISTS } from '../packLists.js';
import { PACK_NOTES, packName, STRINGS } from '../strings.js';
import styles from '../Dashboard.module.css';

export interface PackItemProps {
  readonly pack: PackRow;
  /** The inline error for this pack, or `null`. */
  readonly problem: string | null;
  readonly onToggle: (enabled: boolean) => void;
}

function Details({ pack }: { readonly pack: PackRow }): JSX.Element {
  const lists = PACK_LISTS[pack.id] ?? [];
  return (
    <details class={styles['details']}>
      <summary aria-label={STRINGS.details(packName(pack.id))}>{STRINGS.detailsSummary}</summary>
      <p class={styles['muted']}>{STRINGS.upTo(pack.ceiling)}</p>
      {lists.map((id) => {
        const list = LISTS[id];
        if (list === undefined) return null;
        return (
          <dl key={id} aria-label={list.title}>
            <dt>{STRINGS.listsHeading}</dt>
            <dd translate={false}>{list.title}</dd>
            <dt>{STRINGS.licence}</dt>
            <dd translate={false}>{list.licence}</dd>
            <dt>{STRINGS.homepage}</dt>
            <dd translate={false}>
              <a class={styles['link']} href={list.homepage} target="_blank" rel="noopener noreferrer">
                {list.homepage}
              </a>
            </dd>
          </dl>
        );
      })}
    </details>
  );
}

export function PackItem({ pack, problem, onToggle }: PackItemProps): JSX.Element {
  const base = useId();
  const note = PACK_NOTES[pack.id];
  const skipped = pack.skipped !== null && pack.enabled;
  const described = [note === undefined ? null : `${base}-note`, problem === null ? null : `${base}-problem`, skipped ? `${base}-skipped` : null].filter((id) => id !== null);
  return (
    <li data-pack={pack.id}>
      <div class={styles['row']}>
        <label class={styles['check']}>
          <input
            type="checkbox"
            class="switch"
            checked={pack.enabled}
            disabled={!pack.toggleable}
            aria-describedby={described.length === 0 ? undefined : described.join(' ')}
            onChange={(event) => {
              onToggle(event.currentTarget.checked);
            }}
          />
          {packName(pack.id)}
        </label>
        {pack.toggleable ? null : <span class={styles['badge']}>{STRINGS.alwaysOn}</span>}
        {pack.licence === 'owner-pending' ? <span class={styles['badge']}>{STRINGS.ownerPending}</span> : null}
      </div>
      {note === undefined ? null : (
        <p class={styles['muted']} id={`${base}-note`}>
          {note}
        </p>
      )}
      {skipped ? (
        <p class={styles['error']} id={`${base}-skipped`}>
          {STRINGS.skipped}
        </p>
      ) : null}
      {problem === null ? null : (
        <p class={styles['error']} id={`${base}-problem`} role="alert">
          {problem}
        </p>
      )}
      <Details pack={pack} />
    </li>
  );
}
