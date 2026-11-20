/**
 * Privacy (P2-36, UI notes §8): GPC, tracking parameters and the badge, then the privacy page: no
 * network requests, what is stored, every permission and why (from `permissions.ts`, checked against
 * the manifest), the permissions we never ask for, the pledge and how to verify a build. D-98: the first three
 * parts stay open; the last three are collapsed disclosures.
 */
import type { JSX } from 'preact';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import { PackItem } from '../sections/PackItem.js';
import type { DashboardStore } from '../store.js';
import { NOT_REQUESTED, PERMISSION_ROWS, type PermissionRow } from './permissions.js';
import { PRIVACY_STRINGS as S } from './strings.js';
import styles from '../Dashboard.module.css';

interface SettingProps {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

function Setting({ id, label, note, checked, onChange }: SettingProps): JSX.Element {
  return (
    <li>
      <label class={styles['check']}>
        <input
          type="checkbox"
          class="switch"
          checked={checked}
          aria-describedby={`${id}-note`}
          onChange={(event) => {
            onChange(event.currentTarget.checked);
          }}
        />
        {label}
      </label>
      <p class={styles['muted']} id={`${id}-note`}>
        {note}
      </p>
    </li>
  );
}

function PermissionTable({ rows, caption }: { readonly rows: readonly PermissionRow[]; readonly caption: string }): JSX.Element {
  return (
    <table class={`${styles['table'] ?? ''} ${styles['stack'] ?? ''}`}>
      <caption class="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{S.permissionColumn}</th>
          <th scope="col">{S.whyColumn}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.permission}>
            <th scope="row">
              {row.name}
              <br />
              <code class={styles['muted']}>{row.permission}</code>
            </th>
            <td>{row.why}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Choices({ store, data }: { readonly store: DashboardStore; readonly data: Dashboard }): JSX.Element {
  const params = data.packs.find((p) => p.id === 'params');
  const hasGpc = data.packs.some((p) => p.id === 'gpc');
  const problem = store.packProblem.value;
  return (
    <section class={styles['block']} aria-labelledby="choices-heading">
      <h2 class={styles['heading']} id="choices-heading">
        {S.choices}
      </h2>
      <ul class={styles['list']}>
        {hasGpc ? (
          <Setting id="gpc" label={S.gpc} note={data.allSites ? S.gpcNote : `${S.gpcNote} ${S.needsAccess}`} checked={data.settings.gpc} onChange={(enabled) => void store.run('c/setGpc', { enabled })} />
        ) : null}
        {params === undefined ? null : (
          <PackItem pack={params} problem={problem?.pack === params.id ? problem.text : null} onToggle={(enabled) => void store.setPack(params.id, enabled)} />
        )}
        <Setting id="badge" label={S.badge} note={S.badgeNote} checked={data.settings.ui.showBadge} onChange={(enabled) => void store.run('c/setShowBadge', { enabled })} />
      </ul>
    </section>
  );
}

function Collapsed({ title, children }: { readonly title: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <details>
      <summary>{title}</summary>
      {children}
    </details>
  );
}

function PrivacyPage(): JSX.Element {
  return (
    <section class={[styles['block'], styles['prose']].join(' ')} aria-labelledby="privacy-page-heading">
      <h2 class={styles['heading']} id="privacy-page-heading">
        {S.pageHeading}
      </h2>
      <p class={styles['muted']}>{S.draft}</p>
      <h3 id="dprivacy-requests">{S.requestsHeading}</h3>
      <p>{S.requests}</p>
      <h3 id="dprivacy-stored">{S.storedHeading}</h3>
      <ul>
        {S.stored.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p>{S.notStored}</p>
      <h3 id="dprivacy-permissions">{S.permissionsHeading}</h3>
      <PermissionTable rows={PERMISSION_ROWS} caption={S.permissionsCaption} />
      <Collapsed title={S.notRequestedHeading}>
        <PermissionTable rows={NOT_REQUESTED} caption={S.notRequestedHeading} />
      </Collapsed>
      <Collapsed title={S.pledgeHeading}>
        <ol>
          {S.pledge.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </Collapsed>
      <Collapsed title={S.verifyHeading}>
        <p>{S.verify}</p>
      </Collapsed>
    </section>
  );
}

export function PrivacySection({ store, data }: { readonly store: DashboardStore; readonly data: Dashboard }): JSX.Element {
  return (
    <div class={styles['section']}>
      <Choices store={store} data={data} />
      <PrivacyPage />
    </div>
  );
}
