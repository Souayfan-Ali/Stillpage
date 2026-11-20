/**
 * Backup (P2-37, UI notes §8, D-32): save the settings to a file; restore one with a preview of what
 * will change and the packs left out, restored only after "Restore". When the settings were reset,
 * the section says so first (the reset notice links here: "Restore a backup").
 */
import type { JSX } from 'preact';
import { PRODUCT_SLUG } from '../../../core/brand.js';
import type { Dashboard } from '../../../core/messaging/dashboard.js';
import { exportBackup } from '../../../core/state/backup.js';
import { storeOfSites, type HiddenSite } from '../../../core/userFilters/list.js';
import type { BackupPreview } from './backupStore.js';
import { Banner } from '../../../ui/Banner.js';
import { Button } from '../../../ui/Button.js';
import type { RestoreStore } from './backupStore.js';
import { backupFileName, saveTextFile } from './download.js';
import { BACKUP_STRINGS as S, changeText, droppedText, warningsOf } from './strings.js';
import styles from '../Dashboard.module.css';

export interface BackupSectionProps {
  readonly data: Dashboard;
  readonly restore: RestoreStore;
  readonly now: () => number;
  /** Writes the status line. */
  readonly say: (text: string) => void;
}

function PreviewList({ preview }: { readonly preview: BackupPreview }): JSX.Element {
  const lines = [...preview.changes.map(changeText), ...preview.dropped.map(droppedText)];
  const warnings = warningsOf(preview);
  return (
    <>
      {warnings.length === 0 ? null : <Banner tone="warning" icon="warning" text={`${S.warningsHeading} ${warnings.join(' ')}`} />}
      <Lines lines={lines} />
    </>
  );
}

function Lines({ lines }: { readonly lines: readonly string[] }): JSX.Element {
  return lines.length === 0 ? (
    <p>{S.noChanges}</p>
  ) : (
    <ul>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function RestoreFlow({ restore }: { readonly restore: RestoreStore }): JSX.Element | null {
  const state = restore.state.value;
  if (state.kind === 'idle' || state.kind === 'reading') return state.kind === 'reading' ? <p role="status">{S.reading}</p> : null;
  if (state.kind === 'problem') {
    return (
      <p class={styles['error']} id="backup-problem" role="alert">
        {state.text}
      </p>
    );
  }
  if (state.kind === 'done') {
    if (state.filtersKept) return <Banner tone="warning" icon="warning" text={S.filtersKept} textRole="status" />;
    return state.applied ? <Banner tone="info" icon="on" text={S.restored} textRole="status" /> : <Banner tone="warning" icon="warning" text={S.restoredNotApplied} textRole="status" />;
  }
  return (
    <section class={styles['block']} aria-labelledby="preview-heading">
      <h3 class={styles['heading']} id="preview-heading">
        {S.previewHeading}
      </h3>
      <PreviewList preview={state.preview} />
      <div class={styles['row']}>
        <Button variant="primary" disabled={state.kind === 'restoring'} onClick={() => void restore.restore()}>
          {S.restore}
        </Button>
        <Button
          disabled={state.kind === 'restoring'}
          onClick={() => {
            restore.cancel();
          }}
        >
          {S.cancel}
        </Button>
      </div>
    </section>
  );
}

export function BackupSection({ data, restore, now, say }: BackupSectionProps): JSX.Element {
  const problem = restore.state.value.kind === 'problem';
  return (
    <div class={styles['section']}>
      <section class={styles['block']} aria-labelledby="export-heading">
        <h2 class={styles['heading']} id="export-heading">
          {S.exportHeading}
        </h2>
        <p class={styles['muted']}>{S.exportNote}</p>
        <div>
          <Button
            onClick={() => {
              saveTextFile(backupFileName(`${PRODUCT_SLUG}-backup`, now()), exportBackup(data.settings, now(), data.hidden === null ? null : storeOfSites(data.hidden as readonly HiddenSite[])));
              // The cast attaches the Hostname brand: every host was checked by the q/dashboard answer schema.
              say(S.exported);
            }}
          >
            {S.exportButton}
          </Button>
        </div>
      </section>
      <section class={styles['block']} aria-labelledby="import-heading">
        <h2 class={styles['heading']} id="import-heading">
          {S.importHeading}
        </h2>
        {data.settingsReset ? <Banner tone="warning" icon="warning" text={S.resetNote} /> : null}
        <div class={styles['field']}>
          <label for="backup-file">{S.file}</label>
          <input
            id="backup-file"
            type="file"
            accept="application/json,.json"
            aria-describedby={problem ? 'backup-file-note backup-problem' : 'backup-file-note'}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file !== undefined) void restore.choose(file);
            }}
          />
          <p class={styles['muted']} id="backup-file-note">
            {S.fileNote}
          </p>
        </div>
        <RestoreFlow restore={restore} />
      </section>
    </div>
  );
}
