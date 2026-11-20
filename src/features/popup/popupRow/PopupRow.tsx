/**
 * The toolbar panel's pop-up row (P2-60b, UI notes §3, §6a): the site's pop-up policy (Default / Allowed /
 * Strict, `c/setSitePopupPolicy`) and what the page's own sentinel blocked — the count, and on demand the list
 * of hosts, each with "Open" (a new tab from the user's click). The count and list come from the page
 * (`x/popupLog`) and vanish with it. The page is asked even when blocking is off for the site (a site on the
 * packaged strict list has a sentinel then, and its count shows). With no sentinel the row says blocking is not
 * running (and that a reload may start it: D-114) only where it should be running; where it is off (Allowed, or
 * Default with the mode Off) it says nothing (D-107). While the guard does not ship the row shows one note only
 * and nothing from the page (D-90). Its own chunk (panel budget).
 */
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Hostname } from '../../../core/ids.js';
import type { TabState } from '../../../core/messaging/tabState.js';
import type { PopupLog } from '../../../core/popup/log.js';
import { Glyph } from '../../../ui/Glyph.js';
import type { Client } from '../client.js';
import { ROW_STRINGS as S } from './strings.js';
import styles from './PopupRow.module.css';

export interface PopupRowDeps {
  readonly client: Pick<Client, 'siteCommand'>;
  readonly popupLog: (tabId: number) => Promise<PopupLog | null>;
  readonly openTab: (url: string) => Promise<void>;
}

export interface PopupRowProps {
  readonly deps: PopupRowDeps;
  readonly state: TabState;
  readonly host: Hostname;
  readonly tabId: number;
  /** Re-reads the tab state after a change (the panel's store). */
  readonly onChanged: () => void;
}

type Policy = 'inherit' | 'allow' | 'strict';
type Log = PopupLog | null | 'loading';

interface BlockedProps {
  readonly log: Log;
  /** Pop-up blocking is off for this site (Allowed, or Default with the mode Off): no sentinel is expected. */
  readonly off: boolean;
  readonly deps: PopupRowDeps;
  readonly onStatus: (text: string) => void;
}

function Blocked({ log, off, deps, onStatus }: BlockedProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (log === 'loading') return null;
  if (log === null) return off ? null : <p class={styles['note']}>{S.noSentinel}</p>;
  if (log.blocked === 0) return <p class={styles['note']}>{S.none}</p>;
  return (
    <>
      <button type="button" class={styles['toggle']} aria-expanded={open} aria-controls="popup-blocked-list" onClick={() => { setOpen(!open); }}>
        {S.blocked(log.blocked)}
        <Glyph name="chevron" class="mirror-rtl" />
      </button>
      <ul id="popup-blocked-list" class={styles['list']} hidden={!open} aria-label={S.listLabel}>
        {log.hosts.map((host) => (
          <li key={host}>
            <button
              type="button"
              class={styles['open']}
              onClick={() => {
                void deps.openTab(`https://${host}/`).then(() => { onStatus(S.opened); }, () => undefined);
              }}
            >
              {S.open(host)}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function PopupRow({ deps, state, host, tabId, onChanged }: PopupRowProps): JSX.Element {
  const [log, setLog] = useState<Log>('loading');
  const [status, setStatus] = useState('');
  useEffect(() => {
    void deps.popupLog(tabId).then(setLog, () => { setLog(null); });
  }, [deps, tabId]);
  const policy: Policy = state.site?.popupPolicy ?? 'inherit';
  const off = policy === 'allow' || (policy === 'inherit' && state.popupMode === 'off');
  const choose = async (next: Policy): Promise<void> => {
    const result = await deps.client.siteCommand('c/setSitePopupPolicy', { hostname: host, policy: next });
    setStatus(result.ok ? S.saved : S.failed);
    if (result.ok) onChanged();
  };
  return (
    <section class={styles['row']} data-state="popup-row">
      <div class={styles['field']}>
        <label class={styles['label']} for="popup-policy">
          <span class={styles['icon']}>
            <Glyph name="popup" />
          </span>
          {S.label}
        </label>
        <select
          id="popup-policy"
          class={styles['select']}
          value={policy}
          aria-describedby={state.popupGuard ? undefined : 'popup-policy-note'}
          onChange={(event) => {
            void choose(event.currentTarget.value as Policy);
          }}
        >
          <option value="inherit">{S.default(state.popupMode)}</option>
          <option value="allow">{S.allow}</option>
          <option value="strict" disabled={!state.popupGuard}>
            {S.strict}
          </option>
        </select>
      </div>
      {state.popupGuard ? (
        <Blocked log={log} off={off} deps={deps} onStatus={setStatus} />
      ) : (
        <p id="popup-policy-note" class={styles['note']}>
          {S.notActive}
        </p>
      )}
      <p class={styles['status']} role="status">
        {status}
      </p>
    </section>
  );
}
