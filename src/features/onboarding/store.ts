/**
 * Onboarding state (P2-33, UI notes §7, design review 2026-11-14 / D-46). Three steps; closing the tab at any
 * point leaves safe defaults because nothing is applied before the user says so: step 2's choices
 * are local until "Next", which sends only what changed and stays on step 2 if a pack is refused.
 * "Finish" or "Skip setup" stores `onboarding.completedAt`; nothing re-opens the page.
 */
import { signal, type ReadonlySignal } from '@preact/signals';
import * as v from 'valibot';
import { describeDashboard } from '../../core/messaging/dashboard.js';
import { DashboardAnswerSchema, type Dashboard } from '../../core/messaging/dashboardSchema.js';
import { AnySchema, type Request } from '../dashboard/client.js';
import { packRefusalText } from '../dashboard/strings.js';
import { commandsFor, initialChoices, type Choices, type ExtraId, type Step2Command } from './extras.js';
import { ONBOARDING_STRINGS as S } from './strings.js';

export type Step = 1 | 2 | 3 | 'done';

export interface OnboardingStore {
  readonly step: ReadonlySignal<Step>;
  readonly data: ReadonlySignal<Dashboard | null | 'unavailable'>;
  readonly choices: ReadonlySignal<Choices>;
  readonly problems: ReadonlySignal<Readonly<Partial<Record<ExtraId, string>>>>;
  readonly status: ReadonlySignal<string>;
  readonly busy: ReadonlySignal<boolean>;
  load(): Promise<void>;
  choose(extra: ExtraId, on: boolean): void;
  next(): Promise<void>;
  back(): void;
  /** "Finish" on step 3, or "Skip setup" anywhere. */
  complete(): Promise<void>;
  /** Asks for access to all sites; call synchronously inside the click. */
  requestAllSites(): Promise<void>;
}

export interface OnboardingDeps {
  readonly request: Request;
  readonly requestOrigins: (origins: readonly string[]) => Promise<boolean>;
  readonly language: string;
}

async function send(request: Request, command: Step2Command): Promise<string | null> {
  const result =
    command.type === 'c/setGpc'
      ? await request('c/setGpc', { enabled: command.enabled }, AnySchema)
      : await request('c/setPack', { pack: command.pack, enabled: command.enabled }, AnySchema);
  if (result.ok) return null;
  return result.error.reason === 'no-capacity' ? packRefusalText(result.error.detail) : S.applyFailed;
}

export function createOnboardingStore(deps: OnboardingDeps): OnboardingStore {
  const step = signal<Step>(1);
  const data = signal<Dashboard | null | 'unavailable'>(null);
  const choices = signal<Choices>({});
  const problems = signal<Readonly<Partial<Record<ExtraId, string>>>>({});
  const status = signal('');
  const busy = signal(false);
  /** Every step change clears the last status line (D20): it belonged to the step left behind. */
  const go = (to: Step): void => {
    status.value = '';
    step.value = to;
  };

  const read = async (): Promise<Dashboard | null> => {
    const result = await deps.request('q/dashboard', {}, v.pipe(DashboardAnswerSchema, v.transform(describeDashboard)));
    if (result.ok) data.value = result.data;
    else data.value ??= 'unavailable';
    return result.ok ? result.data : null;
  };

  const load = async (): Promise<void> => {
    const fresh = await read();
    if (fresh !== null) choices.value = initialChoices(fresh, deps.language);
  };

  /** Sends step 2's changes one by one; a refusal is kept per extra and stops the step. */
  const applyChoices = async (current: Dashboard): Promise<boolean> => {
    const found: Partial<Record<ExtraId, string>> = {};
    for (const command of commandsFor(current, deps.language, choices.value)) {
      const problem = await send(deps.request, command);
      if (problem !== null) found[command.extra] = problem;
    }
    problems.value = found;
    await read();
    return Object.keys(found).length === 0;
  };

  const next = async (): Promise<void> => {
    const current = data.value;
    if (busy.value || step.value === 'done' || step.value === 3) return;
    if (step.value === 1) {
      go(2);
      return;
    }
    if (current === null) return; // still loading: the choices are not on screen yet (review M8)
    if (current === 'unavailable') {
      go(3);
      return;
    }
    busy.value = true;
    status.value = S.applying;
    const ok = await applyChoices(current);
    busy.value = false;
    if (ok) go(3);
    else status.value = S.someRefused;
  };

  const complete = async (): Promise<void> => {
    busy.value = true;
    const result = await deps.request('c/completeOnboarding', {}, AnySchema);
    busy.value = false;
    if (result.ok) go('done');
    else status.value = S.applyFailed;
  };

  const requestAllSites = async (): Promise<void> => {
    let asked: Promise<boolean>;
    try {
      asked = deps.requestOrigins(['<all_urls>']);
    } catch {
      asked = Promise.resolve(false);
    }
    const granted = await asked.catch(() => false);
    status.value = granted ? S.accessGranted : S.accessDenied;
    await read();
  };

  return {
    step,
    data,
    choices,
    problems,
    status,
    busy,
    load,
    choose: (extra, on) => {
      choices.value = { ...choices.value, [extra]: on };
    },
    next,
    back: () => {
      if (busy.value) return;
      if (step.value === 2) go(1);
      else if (step.value === 3) go(2);
    },
    complete,
    requestAllSites,
  };
}
