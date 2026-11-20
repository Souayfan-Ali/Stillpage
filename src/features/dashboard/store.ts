/**
 * Dashboard state and actions (P2-34…P2-37). Signals hold what is drawn; every change goes to the
 * worker as a command and the snapshot is then read again (`q/dashboard`), so the worker stays the only
 * writer of settings. A refused pack keeps its checkbox where it was and gets an inline error worded
 * from the validated `detail` (P2-26); a pack that benefits from Thorough gets the offer (P2-27).
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import * as v from 'valibot';
import { describeDashboard } from '../../core/messaging/dashboard.js';
import { DashboardAnswerSchema, type Dashboard } from '../../core/messaging/dashboardSchema.js';
import type { MessageType, PayloadOf } from '../../core/messaging/schemas.js';
import { AnySchema, type PageError, type Request } from './client.js';
import { packRefusalText, STRINGS } from './strings.js';

type Snapshot = { readonly kind: 'loading' } | { readonly kind: 'unavailable' } | { readonly kind: 'ready'; readonly data: Dashboard };

interface PackProblem {
  readonly pack: string;
  readonly text: string;
}

/** Commands the sections send through `run` (everything but queries and the pack toggle). */
type Command = Exclude<MessageType, `q/${string}` | `cs/${string}` | 'c/setPack' | 'c/proceedOnce' | 'c/startPicker'>;

export interface DashboardStore {
  readonly snapshot: ReadonlySignal<Snapshot>;
  /** Result of the last action, for the page's one `role="status"` line. */
  readonly status: ReadonlySignal<string>;
  readonly packProblem: ReadonlySignal<PackProblem | null>;
  /** "Use Thorough?" after a pack that benefits from it was turned on; page session only. */
  readonly thoroughOffer: ReadonlySignal<boolean>;
  load(): Promise<void>;
  run<T extends Command>(type: T, payload: PayloadOf<T>): Promise<boolean>;
  setPack(pack: string, enabled: boolean): Promise<void>;
  acceptThorough(): Promise<void>;
  dismissOffer(): void;
  /** Writes the status line (results of page-only actions, such as saving a file). */
  say(text: string): void;
  /** Asks for access to all sites; call synchronously inside the click. */
  requestAllSites(): Promise<void>;
}

export interface DashboardDeps {
  readonly request: Request;
  readonly requestOrigins: (origins: readonly string[]) => Promise<boolean>;
}

const PackAnswerSchema = v.object({ offerThorough: v.optional(v.boolean()) });

function failureText(error: PageError): string {
  // No answer in time: the worker may still be applying it; the snapshot is read again either way.
  if (error.code === 'no-answer') return STRINGS.noAnswer;
  return error.code === 'refused' && error.reason === 'not-implemented' ? STRINGS.notAvailable : STRINGS.saveFailed;
}

export function createDashboardStore(deps: DashboardDeps): DashboardStore {
  const snapshot = signal<Snapshot>({ kind: 'loading' });
  const status = signal('');
  const packProblem = signal<PackProblem | null>(null);
  const thoroughOffer = signal(false);
  let token = 0;
  // Commands run one at a time in click order (a pack command can take tens of seconds), so results and
  // the one status line never interleave (review HIGH 3).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <R>(task: () => Promise<R>): Promise<R> => {
    const next = queue.then(task);
    queue = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<void> => {
    const mine = ++token;
    const result = await deps.request('q/dashboard', {}, v.pipe(DashboardAnswerSchema, v.transform(describeDashboard)));
    if (mine !== token) return;
    if (result.ok) snapshot.value = { kind: 'ready', data: result.data };
    else if (snapshot.value.kind !== 'ready') snapshot.value = { kind: 'unavailable' };
    else status.value = STRINGS.readFailed;
  };

  const run = <T extends Command>(type: T, payload: PayloadOf<T>): Promise<boolean> => {
    status.value = STRINGS.saving;
    return serial(async () => {
      status.value = STRINGS.saving;
      const result = await deps.request(type, payload, AnySchema);
      status.value = result.ok ? STRINGS.saved : failureText(result.error);
      await load();
      return result.ok;
    });
  };

  const setPack = (pack: string, enabled: boolean): Promise<void> => {
    status.value = STRINGS.saving;
    return serial(async () => {
      if (packProblem.value?.pack === pack) packProblem.value = null;
      status.value = STRINGS.saving;
      const result = await deps.request('c/setPack', { pack, enabled }, PackAnswerSchema);
      if (result.ok) {
        status.value = STRINGS.saved;
        thoroughOffer.value = result.data.offerThorough === true;
      } else {
        status.value = result.error.code === 'no-answer' ? STRINGS.noAnswer : '';
        packProblem.value = { pack, text: result.error.reason === 'no-capacity' ? packRefusalText(result.error.detail) : failureText(result.error) };
      }
      await load();
    });
  };

  const acceptThorough = async (): Promise<void> => {
    thoroughOffer.value = false;
    await run('c/setDefaultLevel', { level: 'thorough' });
  };

  const requestAllSites = async (): Promise<void> => {
    let asked: Promise<boolean>;
    try {
      asked = deps.requestOrigins(['<all_urls>']);
    } catch {
      asked = Promise.resolve(false);
    }
    const granted = await asked.catch(() => false);
    status.value = granted ? STRINGS.accessGranted : STRINGS.accessDenied;
    await load();
  };

  return {
    snapshot,
    status,
    packProblem,
    thoroughOffer,
    load,
    run,
    setPack,
    acceptThorough,
    dismissOffer: () => {
      thoroughOffer.value = false;
    },
    say: (text) => {
      status.value = text;
    },
    requestAllSites,
  };
}
