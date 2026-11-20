/** One row of the Sites table (P2-35): select box, host, level select, pause, pop-up policy, remove. */
import type { JSX } from 'preact';
import { LEVELS, type Level } from '../../../core/state/types.js';
import { Button } from '../../../ui/Button.js';
import type { DashboardStore } from '../store.js';
import type { SiteRow } from './rows.js';
import { LEVEL_LABELS, SITE_STRINGS } from './strings.js';
import styles from '../Dashboard.module.css';
import sites from './Sites.module.css';

const INHERIT = 'inherit';

export interface SiteRowViewProps {
  readonly row: SiteRow;
  readonly selected: boolean;
  readonly onSelect: (selected: boolean) => void;
  readonly onRemove: () => void;
  readonly store: DashboardStore;
}

/** A short visible label whose accessible name names the row (WCAG 2.5.3: the visible words come first). */
function Labelled({ visible, full }: { readonly visible: string; readonly full: string }): JSX.Element {
  return (
    <>
      <span aria-hidden="true">{visible}</span>
      <span class="visually-hidden">{full}</span>
    </>
  );
}

/** Per-site pop-up choice (P2-60): Default (follows the mode), Allowed, Strict, via `c/setSitePopupPolicy`. */
function PopupCell({ row, store }: { readonly row: SiteRow; readonly store: DashboardStore }): JSX.Element {
  return (
    <select
      aria-label={SITE_STRINGS.popupsOf(row.host)}
      aria-describedby="site-popups-note"
      value={row.popupPolicy ?? INHERIT}
      onChange={(event) => {
        const value = event.currentTarget.value;
        const policy = value === 'allow' || value === 'strict' ? value : INHERIT;
        void store.run('c/setSitePopupPolicy', { hostname: row.host, policy });
      }}
    >
      <option value={INHERIT}>{SITE_STRINGS.inherit}</option>
      <option value="allow">{SITE_STRINGS.popupAllow}</option>
      <option value="strict">{SITE_STRINGS.popupStrict}</option>
    </select>
  );
}

function LevelCell({ row, store }: { readonly row: SiteRow; readonly store: DashboardStore }): JSX.Element {
  return (
    <div class={styles['field']}>
      <select
        aria-label={SITE_STRINGS.levelOf(row.host)}
        value={row.level ?? INHERIT}
        onChange={(event) => {
          const value = event.currentTarget.value;
          void store.run('c/setSiteLevel', { hostname: row.host, level: value === INHERIT ? INHERIT : (value as Level) });
        }}
      >
        <option value={INHERIT}>{SITE_STRINGS.inherit}</option>
        {LEVELS.map((level) => (
          <option key={level} value={level}>
            {LEVEL_LABELS[level]}
          </option>
        ))}
      </select>
      {row.pausedUntil === null ? null : (
        <span class={styles['row']}>
          <span>{SITE_STRINGS.pausedUntil(row.pausedUntil)}</span>
          <Button
            variant="quiet"
            onClick={() => {
              void store.run('c/setSiteLevel', { hostname: row.host, level: INHERIT });
            }}
          >
            <Labelled visible={SITE_STRINGS.resume} full={SITE_STRINGS.resumeLabel(row.host)} />
          </Button>
        </span>
      )}
    </div>
  );
}

export function SiteRowView({ row, selected, onSelect, onRemove, store }: SiteRowViewProps): JSX.Element {
  return (
    <tr>
      <td>
        <label class={sites['hit']}>
          <input
            type="checkbox"
            aria-label={SITE_STRINGS.select(row.host)}
            checked={selected}
            onChange={(event) => {
              onSelect(event.currentTarget.checked);
            }}
          />
        </label>
      </td>
      <th scope="row">{row.host}</th>
      {/* data-label: the column name above the control when the table is drawn as cards on a narrow screen. */}
      <td data-label={SITE_STRINGS.level}>
        <LevelCell row={row} store={store} />
      </td>
      <td data-label={SITE_STRINGS.popups}>
        <PopupCell row={row} store={store} />
      </td>
      <td>
        <Button onClick={onRemove}>
          <Labelled visible={SITE_STRINGS.remove} full={SITE_STRINGS.removeLabel(row.host)} />
        </Button>
      </td>
    </tr>
  );
}
