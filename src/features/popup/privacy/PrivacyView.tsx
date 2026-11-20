/**
 * The privacy panel, the toolbar panel's second view (P2-12, UI notes §4): what was blocked on this
 * page, per category and company, the "How this is counted" disclosure and "Copy summary". Nothing is
 * fetched from anywhere but our own worker; nothing leaves the device.
 */
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Button } from '../../../ui/Button.js';
import type { PrivacyStore } from './privacyStore.js';
import { CATEGORY_LABELS, PRIVACY_STRINGS } from './strings.js';
import { rowLabel, ruleCount } from './summary.js';
import styles from './Privacy.module.css';

type Counts = Extract<PrivacyStore['matched']['value'], { kind: 'counts' }>;

function Groups({ counts }: { readonly counts: Counts }): JSX.Element {
  if (counts.groups.length === 0) return <p>{PRIVACY_STRINGS.empty}</p>;
  return (
    <dl class={styles['groups']}>
      {counts.groups.map((g) => (
        <div key={g.category} class={styles['group']} data-category={g.category}>
          <dt class={styles['row']}>
            <span>{CATEGORY_LABELS[g.category]}</span>
            <span class={styles['count']}>{g.count}</span>
          </dt>
          {g.buckets.map((b) => (
            <dd key={b.id} class={`${styles['row'] ?? ''} ${styles['bucket'] ?? ''}`}>
              <span>{rowLabel(g.category, b.name)}</span>
              <span class={styles['count']}>{b.count}</span>
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}

function Body({ store, host }: { readonly store: PrivacyStore; readonly host: string | null }): JSX.Element {
  const matched = store.matched.value;
  if (matched.kind === 'idle' || matched.kind === 'loading') return <p>{PRIVACY_STRINGS.loading}</p>;
  if (matched.kind === 'failed') return <p>{PRIVACY_STRINGS.failed}</p>;
  if (matched.kind === 'unavailable') return <p data-state="unavailable">{PRIVACY_STRINGS.unavailable}</p>;
  return (
    <>
      {matched.stale ? <p data-state="stale">{PRIVACY_STRINGS.stale}</p> : null}
      <Groups counts={matched} />
      <p class={styles['note']}>
        {PRIVACY_STRINGS.scope} {PRIVACY_STRINGS.local}
      </p>
      <details class={styles['how']}>
        <summary>{PRIVACY_STRINGS.howTitle}</summary>
        <p>{PRIVACY_STRINGS.precise(matched.total, ruleCount(matched))}</p>
        {PRIVACY_STRINGS.how.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </details>
      <div class={styles['actions']}>
        <Button
          onClick={() => {
            void store.copy(host);
          }}
        >
          {PRIVACY_STRINGS.copy}
        </Button>
        <p class={styles['status']} role="status">
          {store.copyStatus.value}
        </p>
      </div>
    </>
  );
}

export interface PrivacyViewProps {
  readonly store: PrivacyStore;
  readonly host: string | null;
  readonly onBack: () => void;
}

export function PrivacyView({ store, host, onBack }: PrivacyViewProps): JSX.Element {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section class={styles['view']} aria-labelledby="privacy-title">
      <div class={styles['bar']}>
        <Button variant="quiet" onClick={onBack}>
          <span class="mirror-rtl" aria-hidden="true">←</span>{' '}
          {PRIVACY_STRINGS.back}
        </Button>
        <h2 id="privacy-title" class={styles['title']} tabIndex={-1} ref={heading}>
          {host === null ? PRIVACY_STRINGS.titleNoHost : PRIVACY_STRINGS.title(host)}
        </h2>
      </div>
      <Body store={store} host={host} />
      {/* P2-62: from the page's own sentinel, so it shows even when the rule counts are unavailable. */}
      {store.popups.value === null ? null : (
        <p class={styles['note']} data-state="popups">
          {PRIVACY_STRINGS.popupsBlocked(store.popups.value.blocked)}
        </p>
      )}
    </section>
  );
}
