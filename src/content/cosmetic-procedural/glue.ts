/**
 * `cosmetic-procedural` (P1-36, cosmetic notes §3, ADR-005): our glue for uBO's procedural engine
 * (`cosmetic/procedural-engine.js`, vendored verbatim, listed just before this file). It reads — never
 * takes — the ISOLATED shard data of its registration (`cosmetic-specific`, listed last, takes it),
 * looks the frame's host up and hands the programs to the engine. Message-free by construction: the
 * engine's only worker messages sit in its `reset()` paths, which nothing here calls (the instance's
 * `reset` is replaced), and the `cssAPI` it writes through is ours, adopting constructed sheets
 * instead of asking the worker (uBOL's `css-api.js` does). Its MutationObserver is replaced by one
 * that runs the engine under the observer budget (`scheduler.ts`). No work at module top level.
 */
import { frameHost, type FrameLocation } from '../../core/content/frame.js';
import { isShardData, ownValue } from '../../core/content/guard.js';
import { lookupHost, SHARD_QUEUE } from '../../core/content/shard-data.js';
import { createScheduler, type Scheduler, type SchedulerClock } from './scheduler.js';

/** Where the glue keeps its one engine instance per frame (ISOLATED world: the page cannot see it). */
export const STATE_KEY = '__cs_pf';

interface EngineApi {
  addDeclaratives(programs: readonly object[]): void;
  addProcedurals(programs: readonly object[]): void;
  reset: () => Promise<void>;
  domObserver: { disconnect(): void } | null;
  proceduralFilterer: { uBOL_commit(): void } | null;
}

type EngineClass = new () => EngineApi;

interface SheetLike {
  replaceSync(css: string): void;
}

export interface ProceduralEnv {
  readonly scope: object;
  readonly document: Pick<Document, 'addEventListener' | 'visibilityState'> & { adoptedStyleSheets?: readonly unknown[] };
  readonly location: FrameLocation;
  readonly clock: SchedulerClock;
  readonly newObserver: (cb: (records: readonly MutationRecord[]) => void) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly newSheet: () => SheetLike;
}

interface State {
  readonly api: EngineApi;
  readonly scheduler: Scheduler;
  readonly observer: Pick<MutationObserver, 'observe' | 'disconnect'>;
}

const isPlainObject = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o);

/** Programs for this frame's host across the queued shards, parsed; malformed ones are skipped. */
export function programsFor(scope: object, location: FrameLocation): readonly Record<string, unknown>[] {
  const queue = ownValue(scope, SHARD_QUEUE.ISOLATED);
  const host = frameHost(location);
  if (!Array.isArray(queue) || host === null) return [];
  const texts = new Set<string>();
  for (const d of queue as readonly unknown[]) {
    if (!isShardData(d)) continue;
    for (const i of lookupHost(d, host).procedural) texts.add(d.procedural[i] ?? '');
  }
  return [...texts].flatMap((text) => {
    try {
      const o: unknown = JSON.parse(text);
      return isPlainObject(o) ? [o] : [];
    } catch {
      // Quiet by design: the compiler emits valid JSON, so a bad program is dropped, never reported to the page.
      return [];
    }
  });
}

/** The engine's `cssAPI`, message-free: each insert is one constructed, adopted sheet. */
function cssApi(env: ProceduralEnv): { insert(css: string): void } {
  return {
    insert(css: string): void {
      const current = env.document.adoptedStyleSheets;
      if (!Array.isArray(current)) return;
      const sheet = env.newSheet();
      try {
        sheet.replaceSync(css);
      } catch {
        // Quiet by design: CSS the frame's engine refuses hides nothing; the other sheets stay.
        return;
      }
      env.document.adoptedStyleSheets = [...(current as readonly unknown[]), sheet];
    },
  };
}

/** Any element added or removed; plain loops, no copies (hot on busy pages, perf review). */
function touchesElements(records: readonly MutationRecord[]): boolean {
  for (const r of records) {
    for (const n of r.addedNodes) if (n.nodeType === 1) return true;
    for (const n of r.removedNodes) if (n.nodeType === 1) return true;
  }
  return false;
}

function start(env: ProceduralEnv, Engine: EngineClass): State {
  Reflect.set(env.scope, 'cssAPI', cssApi(env));
  const api = new Engine();
  api.reset = () => Promise.resolve();
  const scheduler = createScheduler(() => { api.proceduralFilterer?.uBOL_commit(); }, env.clock);
  const observer = env.newObserver((records) => { if (touchesElements(records)) scheduler.notify(); });
  const watch = (): void => { observer.observe(env.document as unknown as Node, { childList: true, subtree: true }); };
  env.document.addEventListener('visibilitychange', () => {
    const hidden = env.document.visibilityState === 'hidden';
    if (hidden) observer.disconnect();
    else watch();
    scheduler.setHidden(hidden);
  });
  watch();
  const state = { api, scheduler, observer };
  Reflect.set(env.scope, STATE_KEY, state);
  return state;
}

/** Runs once per injection; returns how many programs it handed to the engine. */
export function runProcedural(env: ProceduralEnv): number {
  const programs = programsFor(env.scope, env.location);
  const Engine = ownValue(env.scope, 'ProceduralFiltererAPI');
  if (programs.length === 0 || typeof Engine !== 'function') return 0;
  const state = (ownValue(env.scope, STATE_KEY) as State | undefined) ?? start(env, Engine as EngineClass);
  const declaratives = programs.filter((p) => p['cssable'] === true);
  const procedurals = programs.filter((p) => p['cssable'] !== true);
  if (declaratives.length > 0) state.api.addDeclaratives(declaratives);
  if (procedurals.length > 0) {
    state.api.addProcedurals(procedurals);
    // The engine made its own unbudgeted observer on the first call; ours replaces it.
    if (state.api.domObserver !== state.observer) {
      state.api.domObserver?.disconnect();
      state.api.domObserver = state.observer;
    }
  }
  return programs.length;
}
