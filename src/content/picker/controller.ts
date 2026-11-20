/**
 * One picker run in a page (P2-18, P2-19): overlay → picked element → ranked candidates (P2-17) →
 * panel. The panel answers with indices: preview, zap ("Hide once"), saved ("Hide always", already sent
 * to the worker by the panel itself) or cancel. This script never sends a save (design review, cosmetic notes §9).
 * Hides are one adopted sheet per purpose, rules built by `hideRule` (sanitised, `display:none` only).
 */
import { generateCandidates } from '../../core/picker/candidates.js';
import type { PickHint } from '../../core/picker/hint.js';
import { MAX_CANDIDATES, type CandidatesMessage, type PanelMessage } from '../../core/picker/protocol.js';
import { bySpread, rankCandidates, type Probe } from '../../core/picker/rank.js';
import { hideRule } from '../../core/sanitise/selector.js';
import { openPanel, type PanelHandle } from './channel.js';
import { createAreaChain, isLarge, type AreaChain, type AreaDeps } from './area.js';
import { rectOf, safeNode } from './dom.js';
import { findHinted } from './hint.js';
import { createOverlay, type Overlay } from './overlay.js';

/** A sheet as far as the picker uses it (`CSSStyleSheet`). */
interface ReplaceableSheet {
  replaceSync(text: string): void;
}

/** The picker's own words in the page, from `_locales` (P2-40): content code reads no catalog itself. */
export interface PickerLabels {
  /** The keyboard focus target's name ("Hide something: arrow keys move, …"). */
  readonly overlay: string;
  /** The panel frame's title. */
  readonly panel: string;
  /** The visible hint pill while choosing (D-104). */
  readonly hint: string;
}

export interface PickerDeps {
  readonly document: Document;
  readonly window: Window;
  readonly elementsFromPoint: (x: number, y: number) => readonly Element[];
  /** `document.querySelectorAll`; may throw on a selector the page's parser refuses. */
  readonly query: (selector: string) => readonly Element[];
  readonly newSheet: () => ReplaceableSheet;
  readonly panelUrl: string;
  readonly panelOrigin: string;
  readonly labels: PickerLabels;
  readonly onEnd: () => void;
  readonly setTimer: (run: () => void, ms: number) => () => void;
  readonly isTrusted?: (e: Event) => boolean;
  readonly hasBox?: (el: Element) => boolean;
  /** Boxes for "Bigger / Smaller area" (D-81); defaults to the native rect. */
  readonly rect?: AreaDeps['rect'];
}

/** The ranking probe for `target`: match count and whether `target` is among the matches. */
export function probeFor(target: Element, query: PickerDeps['query']): Probe {
  return (selector) => {
    try {
      const found = query(selector);
      return { count: found.length, includesTarget: found.includes(target) };
    } catch {
      return null;
    }
  };
}

/** Candidates for the panel: the best `MAX_CANDIDATES` by rank, in slider order, best one marked. */
export function candidatesFor(el: Element, probe: Probe): CandidatesMessage | null {
  const ranked = rankCandidates(generateCandidates(safeNode(el)), probe).slice(0, MAX_CANDIDATES);
  const best = ranked[0];
  if (best === undefined) return null;
  const spread = bySpread(ranked);
  return { type: 'candidates', candidates: spread.map(({ selector, count }) => ({ selector, count })), initial: spread.indexOf(best) };
}

/** The offer for `el` with the area flags of `chain` (D-81), or `null` when nothing usable is found. */
function offerFor(el: Element, chain: AreaChain, deps: PickerDeps): CandidatesMessage | null {
  const found = candidatesFor(el, probeFor(el, deps.query));
  if (found === null) return null;
  const viewport = { width: deps.window.innerWidth, height: deps.window.innerHeight };
  return { ...found, canWiden: chain.canWiden(), canNarrow: chain.canNarrow(), large: isLarge((deps.rect ?? rectOf)(el), viewport) };
}

/** Adopts `sheet`; a document that cannot adopt (no `adoptedStyleSheets`) gets no preview, the picker still runs. */
function adopt(doc: Document, sheet: ReplaceableSheet): void {
  try {
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet as CSSStyleSheet];
  } catch {
    // Nothing to fall back to: preview and "hide once" need an adoptable sheet.
  }
}

/** The hinted element, picked at once when it is on the page and pickable (P3-17); else the picker waits as before. */
function prePick(overlay: Overlay, doc: Document, hint: PickHint | null): void {
  const target = hint === null ? null : findHinted(doc, hint);
  if (target !== null) overlay.pickNow(target);
}

/** One picker run: its sheets and what it has made so far (the panel, the overlay, the offer, the area chain). */
interface Run {
  readonly deps: PickerDeps;
  readonly nonce: string;
  readonly preview: ReplaceableSheet;
  readonly zapped: ReplaceableSheet;
  zappedRules: readonly string[];
  panel: PanelHandle | null;
  overlay: Overlay | null;
  offered: CandidatesMessage | null;
  area: AreaChain | null;
  ended: boolean;
}

function endRun(run: Run): void {
  if (run.ended) return;
  run.ended = true;
  run.panel?.close();
  run.preview.replaceSync('');
  run.overlay?.destroy();
  run.deps.onEnd();
}

const ruleAt = (run: Run, index: number): string | null => hideRule(run.offered?.candidates[index]?.selector ?? '');

function setZapped(run: Run, rules: readonly string[]): void {
  run.zappedRules = rules;
  run.zapped.replaceSync(rules.join('\n'));
}

const hide = (run: Run, index: number): void => {
  const rule = ruleAt(run, index);
  setZapped(run, rule === null ? run.zappedRules : [...run.zappedRules, rule]);
};

/** Saved: the element stays hidden, the overlay goes, the panel shrinks to the undo toast (P2-21). */
function saved(run: Run, index: number): void {
  hide(run, index);
  run.preview.replaceSync('');
  run.overlay?.standDown();
  run.panel?.toast();
}

function undo(run: Run, index: number): void {
  const rule = ruleAt(run, index);
  const at = rule === null ? -1 : run.zappedRules.lastIndexOf(rule);
  setZapped(run, run.zappedRules.filter((_r, i) => i !== at));
  endRun(run);
}

/** "Bigger / Smaller area" (D-81): one step along the chain, then always a fresh offer (the panel waits for it). */
function move(run: Run, wider: boolean): void {
  const { area, panel } = run;
  if (area === null || panel === null || run.offered === null) return;
  const moved = wider ? area.widen() : area.narrow();
  const next = moved ? offerFor(area.at(), area, run.deps) : null;
  if (moved && next === null) {
    if (wider) area.narrow();
    else area.widen();
  }
  if (next !== null) {
    run.offered = next;
    run.overlay?.mark(area.at());
  }
  panel.offer(run.offered);
}

function onMessage(run: Run, m: PanelMessage): void {
  if (m.type === 'widen' || m.type === 'narrow') move(run, m.type === 'widen');
  else if (m.type === 'preview') run.preview.replaceSync(m.index === null ? '' : ruleAt(run, m.index) ?? '');
  else if (m.type === 'cancel' || m.type === 'close') endRun(run);
  else if (m.type === 'saved') saved(run, m.index);
  else if (m.type === 'undo') undo(run, m.index);
  else if (m.type === 'zap') {
    hide(run, m.index);
    endRun(run);
  }
}

function onPick(run: Run, el: Element): void {
  const { deps } = run;
  run.area = createAreaChain(el, deps.rect === undefined ? {} : { rect: deps.rect });
  run.offered = offerFor(el, run.area, deps);
  if (run.offered === null) {
    run.overlay?.resume();
    return;
  }
  run.panel = openPanel({ document: deps.document, panelUrl: deps.panelUrl, panelOrigin: deps.panelOrigin, nonce: run.nonce, title: deps.labels.panel,
    candidates: run.offered, mount: (node) => { run.overlay?.mount(node); }, onMessage: (m) => { onMessage(run, m); }, onFail: () => { endRun(run); },
    setTimer: deps.setTimer });
}

/**
 * Starts the picker for one `x/pickerStart`; returns a stop function. Never leaves a half-built overlay.
 * With a context-menu `hint`, the matching element is picked straight away (P3-17).
 */
export function runPicker(deps: PickerDeps, nonce: string, hint: PickHint | null = null): () => void {
  const run: Run = { deps, nonce, preview: deps.newSheet(), zapped: deps.newSheet(), zappedRules: [], panel: null, overlay: null, offered: null, area: null, ended: false };
  adopt(deps.document, run.preview);
  adopt(deps.document, run.zapped);
  const end = (): void => { endRun(run); };
  try {
    run.overlay = createOverlay({
      document: deps.document, window: deps.window, elementsFromPoint: deps.elementsFromPoint,
      ...(deps.isTrusted && { isTrusted: deps.isTrusted }), ...(deps.hasBox && { hasBox: deps.hasBox }),
      onCancel: end, onPick: (el) => { onPick(run, el); }, label: deps.labels.overlay, hint: deps.labels.hint,
    });
    prePick(run.overlay, deps.document, hint);
  } catch {
    // Quiet by design: a page that breaks the overlay gets no picker (end() tears down what was made).
    end();
  }
  return end;
}
