/**
 * `cosmetic-generic` surveyor (P2-24, cosmetic notes §4–§5): registered at `document_idle` on Thorough hosts
 * after the generic data files of the enabled packs. It takes the data queue, walks the elements that
 * carry an `id` or `class`, looks their tokens up and adds the matched selectors to one adopted
 * constructed stylesheet (`display:none!important`, sanitised). Added nodes are surveyed the same way.
 *
 * Budget (D-28: binding for our own code): every batch stops after 4 ms and carries the rest over to
 * the next frame; batches run through the shared backoff scheduler (`scheduler.ts`), which doubles the
 * interval when work passes 50 ms in a second and steps it back down. Hidden tabs disconnect and rescan
 * once on visible; frames smaller than 2 × 2 px and hosts with nothing to do get no observer. Added
 * subtrees are queued as roots and expanded inside the slice; `id` / `class` changes are observed too
 * (design review, P2-24: late classes are common on banners). No message, no storage read; nothing at module
 * top level. Known limits, as uBOL: shadow roots are not surveyed; a frame that starts smaller than
 * 2 × 2 px is not surveyed even if it grows; without constructed stylesheets nothing is hidden.
 */
import { frameHost, type FrameLocation } from '../../core/content/frame.js';
import { ownValue } from '../../core/content/guard.js';
import { GENERIC_QUEUE } from '../../core/generic/data.js';
import { hideRule } from '../../core/sanitise/selector.js';
import { createScheduler, type Scheduler, type SchedulerClock } from '../cosmetic-procedural/scheduler.js';
import { createMatcher, type Matcher } from './matcher.js';

/** Time slice per batch (cosmetic notes §4, D-28). */
export const SLICE_MS = 4;
/** Elements surveyed between two clock reads. */
const CHECK_EVERY = 32;
/** Frames smaller than this in either dimension are not surveyed (cosmetic notes §4). */
const MIN_FRAME_PX = 2;
/** Where one frame keeps its surveyor (ISOLATED world: the page cannot see it). */
export const STATE_KEY = '__cs_gf';
const TOKEN_SELECTOR = '[id],[class]';

/** Elements are opaque here: every read goes through `SurveyDom`. */
type SurveyedElement = object;

/**
 * Element reads through methods captured from this world's prototypes, never through the element's own
 * properties, which a page can shadow with named form controls (DOM clobbering, security review MEDIUM-1).
 */
export interface SurveyDom {
  isElement(node: unknown): node is SurveyedElement;
  attribute(el: SurveyedElement, name: 'id' | 'class'): unknown;
  descendants(el: SurveyedElement, selector: string): Iterable<SurveyedElement>;
}

/** Items queued at most (security review MEDIUM-2): beyond this the queue restarts as one rescan of the root. */
const MAX_PENDING = 50_000;

/** The parts of `MutationRecord` used here. */
interface ObservedRecord {
  readonly type: string;
  readonly target: unknown;
  readonly addedNodes: Iterable<unknown>;
}

export interface SheetLike {
  insertRule(rule: string, index: number): number;
  readonly cssRules: { readonly length: number };
}

export interface SurveyEnv {
  readonly scope: object;
  readonly document: {
    readonly documentElement: SurveyedElement | null;
    readonly visibilityState: string;
    adoptedStyleSheets?: readonly unknown[];
    addEventListener(type: 'visibilitychange', listener: (event: { readonly isTrusted: boolean }) => void): void;
  };
  readonly dom: SurveyDom;
  readonly location: FrameLocation;
  readonly viewport: () => { readonly width: number; readonly height: number };
  readonly clock: SchedulerClock;
  readonly newObserver: (cb: (records: readonly ObservedRecord[]) => void) => {
    observe(target: unknown, options: { childList: boolean; subtree: boolean; attributes: boolean; attributeFilter: string[] }): void;
    disconnect(): void;
  };
  readonly newSheet: () => SheetLike;
}

/** One queued item: an element, and whether its subtree is still to be expanded. */
interface Pending {
  readonly el: SurveyedElement;
  readonly expand: boolean;
}

interface Survey {
  readonly matcher: Matcher;
  readonly sheet: SheetLike;
  readonly dom: SurveyDom;
  readonly root: SurveyedElement | null;
  /** Elements in `pending` (each queued once until drained). */
  queued: Set<SurveyedElement>;
  /** Items waiting to be surveyed, oldest first; `next` is the read position. */
  pending: Pending[];
  next: number;
  /**
   * The descendants of the root being expanded, read lazily across batches. Never copied into `pending`:
   * a document with more classed elements than `MAX_PENDING` would otherwise overflow, restart as a
   * rescan of the root and expand it again, forever (P2-44, the J15 huge-DOM flake).
   */
  expanding: Iterator<SurveyedElement> | null;
  scheduler: Scheduler | null;
  /** Batches that stopped at the slice with work left (for the perf gate). */
  carried: number;
  batches: number;
}

/** Counters of one frame's surveyor (read by the perf gate through `STATE_KEY`). */
export interface SurveyStats {
  readonly batches: number;
  readonly carried: number;
  readonly backoffs: number;
  readonly intervalMs: number;
}

export function surveyStats(survey: Survey): SurveyStats {
  const s = survey.scheduler?.stats() ?? { backoffs: 0, intervalMs: 0 };
  return { batches: survey.batches, carried: survey.carried, backoffs: s.backoffs, intervalMs: s.intervalMs };
}

function insert(sheet: SheetLike, selectors: readonly string[]): void {
  for (const s of selectors) {
    const rule = hideRule(s);
    if (rule === null) continue;
    try {
      sheet.insertRule(rule, sheet.cssRules.length);
    } catch {
      // Chrome refused this selector; the others still apply.
    }
  }
}

/** Restarts the queue as one rescan of the whole document (overflow, or a page flooding mutations). */
function restart(survey: Survey): void {
  survey.expanding = null;
  survey.pending = survey.root === null ? [] : [{ el: survey.root, expand: true }];
  survey.next = 0;
  survey.queued = new Set(survey.root === null ? [] : [survey.root]);
}

/** Queues an element once; with `expand`, its descendants with an id or a class follow when it is reached. */
function enqueue(survey: Survey, el: SurveyedElement, expand = true): void {
  if (survey.queued.has(el) && !expand) return;
  if (survey.pending.length - survey.next >= MAX_PENDING) {
    restart(survey);
    return;
  }
  survey.queued.add(el);
  survey.pending.push({ el, expand });
}

/**
 * Surveys one item into `found` (inserted once per batch, P3-17); an expanded root opens its descendants
 * for the next steps (inside the slice, not in the observer).
 */
function surveyOne(survey: Survey, item: Pending, found: string[]): void {
  const { dom } = survey;
  for (const s of survey.matcher.matchElement(dom.attribute(item.el, 'id'), dom.attribute(item.el, 'class'))) found.push(s);
  if (item.expand) survey.expanding = dom.descendants(item.el, TOKEN_SELECTOR)[Symbol.iterator]();
}

/** The next item: the open expansion first, then the queue. */
function nextItem(survey: Survey): Pending | undefined {
  if (survey.expanding !== null) {
    const step = survey.expanding.next();
    if (step.done !== true) return { el: step.value, expand: false };
    survey.expanding = null;
  }
  if (survey.next >= survey.pending.length) return undefined;
  const item = survey.pending[survey.next];
  survey.next += 1;
  return item;
}

const hasWork = (survey: Survey): boolean => survey.expanding !== null || survey.next < survey.pending.length;

/** One batch: surveys pending items until the slice is spent; reports whether work is left. */
export function surveyBatch(survey: Survey, now: () => number): boolean {
  const start = now();
  let done = 0;
  survey.batches += 1;
  const found: string[] = [];
  for (let item = nextItem(survey); item !== undefined; item = nextItem(survey)) {
    try {
      surveyOne(survey, item, found);
    } catch {
      // One hostile element skips only itself; the batch and the rest of the queue go on.
    }
    done += 1;
    // Opening an expansion reads thousands of elements in one step: read the clock right after it (review MEDIUM).
    if ((item.expand || done % CHECK_EVERY === 0) && now() - start >= SLICE_MS) break;
  }
  insert(survey.sheet, found);
  if (hasWork(survey)) {
    survey.carried += 1;
    return true;
  }
  survey.pending = [];
  survey.next = 0;
  survey.queued = new Set();
  return false;
}

function observe(env: SurveyEnv, survey: Survey): void {
  const scheduler = createScheduler(() => {
    if (surveyBatch(survey, () => env.clock.now())) scheduler.notify();
  }, env.clock);
  survey.scheduler = scheduler;
  const { root, dom } = survey;
  if (root === null) return;
  const observer = env.newObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (dom.isElement(r.target)) enqueue(survey, r.target, false);
        continue;
      }
      for (const n of r.addedNodes) if (dom.isElement(n)) enqueue(survey, n);
    }
    scheduler.notify();
  });
  let hidden = env.document.visibilityState === 'hidden';
  const watch = (): void => {
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });
  };
  env.document.addEventListener('visibilitychange', (event) => {
    // Page script can dispatch this event too (security review LOW-1): only a real change counts.
    const now = env.document.visibilityState === 'hidden';
    if (!event.isTrusted || now === hidden) return;
    hidden = now;
    scheduler.setHidden(hidden);
    if (hidden) {
      observer.disconnect();
      return;
    }
    // Changes while hidden were not observed: the queue becomes one survey of the whole document,
    // through the slice (cheap: every token already looked up is skipped).
    restart(survey);
    watch();
    scheduler.notify();
  });
  enqueue(survey, root);
  // Injected into a hidden tab (a background tab): no observer and no work until it is shown (review MEDIUM).
  scheduler.setHidden(hidden);
  if (!hidden) watch();
  scheduler.notify();
}

/** Runs once per frame; returns the number of always-on selectors applied, or -1 when it did nothing. */
export function runGenericSurvey(env: SurveyEnv): number {
  const queue = ownValue(env.scope, GENERIC_QUEUE);
  Reflect.deleteProperty(env.scope, GENERIC_QUEUE);
  if (ownValue(env.scope, STATE_KEY) !== undefined || !Array.isArray(queue)) return -1;
  const host = frameHost(env.location);
  const { width, height } = env.viewport();
  const current = env.document.adoptedStyleSheets;
  if (host === null || width < MIN_FRAME_PX || height < MIN_FRAME_PX || !Array.isArray(current)) return -1;
  const matcher = createMatcher(queue as readonly unknown[], host);
  if (matcher === null) return -1;
  const sheet = env.newSheet();
  env.document.adoptedStyleSheets = [...(current as readonly unknown[]), sheet];
  insert(sheet, matcher.always);
  const survey: Survey = {
    matcher, sheet, dom: env.dom, root: env.document.documentElement, queued: new Set(), pending: [], next: 0, expanding: null, scheduler: null, carried: 0, batches: 0,
  };
  Reflect.set(env.scope, STATE_KEY, survey);
  observe(env, survey);
  return matcher.always.length;
}
