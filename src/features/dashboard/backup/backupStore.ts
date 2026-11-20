/**
 * Restore flow of the Backup section (P2-37): read the chosen file with a size cap, check it locally
 * to word a refusal precisely, ask the worker for the preview, and restore only after the user
 * confirms. The worker re-reads the text from scratch on both steps; the page's own check only words
 * errors and saves a round trip.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import * as v from 'valibot';
import { MAX_BACKUP_BYTES } from '../../../core/limits.js';
import { readBackup } from '../../../core/state/backup.js';
import { changesOf, hiddenChange, type Change, type PackInfo } from '../../../core/state/backupChanges.js';
import { DroppedSchema, PreviewAnswerSchema, type Dropped } from '../../../core/state/backupPreview.js';
import type { Request } from '../client.js';
import { BACKUP_STRINGS, PROBLEM_TEXT } from './strings.js';

type RestoreState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'problem'; readonly text: string }
  | { readonly kind: 'preview'; readonly json: string; readonly digest: string; readonly preview: BackupPreview }
  | { readonly kind: 'restoring'; readonly preview: BackupPreview }
  | { readonly kind: 'done'; readonly preview: BackupPreview; readonly applied: boolean; readonly filtersKept: boolean };

/** What the page needs from a chosen file. */
export interface FileLike {
  readonly size: number;
  text(): Promise<string>;
}

export interface RestoreStore {
  readonly state: ReadonlySignal<RestoreState>;
  choose(file: FileLike): Promise<void>;
  restore(): Promise<void>;
  cancel(): void;
}

const ImportAnswerSchema = v.object({ status: v.string(), dropped: DroppedSchema, filters: v.picklist(['replaced', 'kept', 'none']) });

/** What the preview shows: the changes (worded by the page) and the packs left out. */
export interface BackupPreview {
  readonly changes: readonly Change[];
  readonly dropped: readonly Dropped[];
}

async function readText(file: FileLike): Promise<string | null> {
  try {
    return await file.text();
  } catch {
    return null;
  }
}

/** `onRestored` re-reads the dashboard snapshot; `packs` are its pack rows (defaults, toggleable). */
export function createRestoreStore(request: Request, onRestored: () => Promise<void>, packs: () => readonly PackInfo[]): RestoreStore {
  const state = signal<RestoreState>({ kind: 'idle' });
  const problem = (text: string): void => {
    state.value = { kind: 'problem', text };
  };

  /** Only the newest chosen file is shown (a slower earlier one is dropped; review M4). */
  let token = 0;

  /** The preview of `file`, or the text of why it was refused. */
  const previewOf = async (file: FileLike): Promise<RestoreState> => {
    if (file.size > MAX_BACKUP_BYTES) return { kind: 'problem', text: PROBLEM_TEXT['too-large'] };
    const json = await readText(file);
    if (json === null) return { kind: 'problem', text: PROBLEM_TEXT.unreadable };
    const local = readBackup(json);
    if (!local.ok) return { kind: 'problem', text: PROBLEM_TEXT[local.errors] };
    const answer = await request('q/previewBackup', { json }, PreviewAnswerSchema);
    if (!answer.ok) return { kind: 'problem', text: answer.error.code === 'refused' ? PROBLEM_TEXT.invalid : BACKUP_STRINGS.restoreFailed };
    const { before, after, digest, dropped, filters } = answer.data;
    const hidden = filters === null ? null : hiddenChange(filters.before, filters.after);
    const changes = [...changesOf(before, after, packs()), ...(hidden === null ? [] : [hidden])];
    return { kind: 'preview', json, digest, preview: { changes, dropped } };
  };

  const choose = async (file: FileLike): Promise<void> => {
    if (state.value.kind === 'restoring') return;
    const mine = ++token;
    state.value = { kind: 'reading' };
    const next = await previewOf(file);
    if (mine === token) state.value = next;
  };

  const restore = async (): Promise<void> => {
    const current = state.value;
    if (current.kind !== 'preview') return;
    state.value = { kind: 'restoring', preview: current.preview };
    const answer = await request('c/importBackup', { json: current.json, expect: current.digest }, ImportAnswerSchema);
    if (!answer.ok && answer.error.code === 'no-answer') {
      problem(BACKUP_STRINGS.unknown);
      await onRestored();
      return;
    }
    if (!answer.ok) { problem(answer.error.reason === 'invalid-payload' ? BACKUP_STRINGS.stale : BACKUP_STRINGS.restoreFailed); return; }
    state.value = { kind: 'done', preview: { changes: current.preview.changes, dropped: answer.data.dropped }, applied: answer.data.status !== 'failed', filtersKept: answer.data.filters === 'kept' };
    await onRestored();
  };

  return {
    state,
    choose,
    restore,
    cancel: () => {
      state.value = { kind: 'idle' };
    },
  };
}
