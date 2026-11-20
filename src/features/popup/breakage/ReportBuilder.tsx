/**
 * The report step (P2-15, UI notes §6): an editable preview the user reviews before anything leaves
 * the device. While the public tracker is the placeholder (Q-11) the only action is **Copy report**;
 * once it is set, **Open a new issue** opens a prefilled page in a new tab (`tabs.create`) and the
 * extension itself sends nothing. What we generate names the hostname only.
 */
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { FlowState } from '../../../core/breakage/types.js';
import type { PopupLog } from '../../../core/popup/log.js';
import { buildReport, issueUrl, MAX_REPORT_CHARS, reportTitle } from '../../../core/report/report.js';
import { Button } from '../../../ui/Button.js';
import type { Client } from '../client.js';
import { REPORT_STRINGS } from './strings.js';
import styles from './Breakage.module.css';

export interface ReportDeps {
  readonly client: Pick<Client, 'tabState' | 'matchedRules'>;
  readonly copyText: (text: string) => Promise<void>;
  readonly openTab: (url: string) => Promise<void>;
  readonly version: string;
  readonly chromeMajor: number | null;
  readonly incognito: boolean;
  /** The validated tracker (`trackerOf`), or `null` while it is the placeholder. */
  readonly tracker: string | null;
  /** The page's pop-up log (P2-62); `null` without a sentinel. */
  readonly popupLog?: (tabId: number) => Promise<PopupLog | null>;
}

async function draft(deps: ReportDeps, state: FlowState, tabId: number): Promise<string | null> {
  const [tab, matched, popups] = await Promise.all([
    deps.client.tabState(tabId),
    deps.client.matchedRules(tabId),
    deps.popupLog?.(tabId).catch(() => null) ?? Promise.resolve(null),
  ]);
  if (!tab.ok) return null;
  const counts = matched.ok && matched.data.kind === 'counts' ? matched.data : null;
  return buildReport({
    host: state.host,
    complaint: state.complaint,
    outcomes: state.outcomes,
    fixedBy: null,
    version: deps.version,
    chromeMajor: deps.chromeMajor,
    level: tab.data.level,
    packs: tab.data.packs,
    rules: counts?.rules ?? [],
    moreRules: counts?.moreRules ?? 0,
    popupMode: tab.data.popupMode,
    popups: popups === null ? null : { blocked: popups.blocked, codes: popups.codes },
    access: tab.data.access,
  });
}

export function ReportBuilder({ deps, state }: { readonly deps: ReportDeps; readonly state: FlowState }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const edited = useRef(false);
  const latest = useRef(state);
  latest.current = state;
  // Drafted once per tab and host; a later flow state never replaces what the user typed (review HIGH).
  useEffect(() => {
    let cancelled = false;
    void draft(deps, latest.current, latest.current.tabId).then((t) => {
      if (cancelled || edited.current) return;
      setText(t ?? '');
      if (t === null) setStatus(REPORT_STRINGS.draftFailed);
    });
    return () => {
      cancelled = true;
    };
  }, [deps, state.tabId, state.host]);
  const copy = async (done: string): Promise<boolean> => {
    const ok = await deps.copyText(text ?? '').then(
      () => true,
      () => false,
    );
    setStatus(ok ? done : REPORT_STRINGS.copyFailed);
    return ok;
  };
  const send = async (tracker: string): Promise<void> => {
    const { url, truncated } = issueUrl(tracker, reportTitle(state), text ?? '');
    if (truncated && !(await copy(REPORT_STRINGS.copiedLong))) return;
    await deps.openTab(url).then(
      () => {
        if (!truncated) setStatus(REPORT_STRINGS.opened);
      },
      () => {
        setStatus(REPORT_STRINGS.openFailed);
      },
    );
  };
  const { tracker } = deps;
  return (
    <div class={styles['report']}>
      {deps.incognito ? <p class={styles['warning']}>{REPORT_STRINGS.incognito}</p> : null}
      <label class={styles['label']} for="report-text">
        {REPORT_STRINGS.label}
      </label>
      <textarea
        id="report-text"
        class={styles['preview']}
        rows={8}
        maxLength={MAX_REPORT_CHARS}
        value={text ?? REPORT_STRINGS.drafting}
        disabled={text === null}
        onInput={(event) => {
          edited.current = true;
          setText(event.currentTarget.value);
        }}
      />
      <p class={styles['detail']}>{deps.tracker === null ? REPORT_STRINGS.noTracker : REPORT_STRINGS.review}</p>
      <div class={styles['row']}>
        {tracker === null ? null : (
          <Button variant="primary" onClick={() => void send(tracker)} disabled={text === null}>
            {REPORT_STRINGS.open}
          </Button>
        )}
        <Button variant={deps.tracker === null ? 'primary' : 'secondary'} onClick={() => void copy(REPORT_STRINGS.copied)} disabled={text === null}>
          {REPORT_STRINGS.copy}
        </Button>
      </div>
      <p class={styles['status']} role="status">
        {status}
      </p>
    </div>
  );
}
