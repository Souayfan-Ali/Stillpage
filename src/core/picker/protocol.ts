/**
 * Messages between the picker content script and the picker panel (P2-19, cosmetic notes §9; design review). The
 * content script posts one `hello` with the nonce and a `MessagePort`; everything else goes over the
 * port: `candidates` (picker → panel; derived from the page's DOM, so the panel treats them as
 * untrusted) and panel → picker messages that carry **indices** into those candidates, never selector
 * text. Pure guards, shared by both sides.
 */
import { sanitiseSelector } from '../sanitise/selector.js';

/** Most candidates the picker offers and the panel accepts. */
export const MAX_CANDIDATES = 40;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export interface CandidateView {
  readonly selector: string;
  readonly count: number;
}

export type PanelMessage =
  | { readonly type: 'preview'; readonly index: number | null }
  | { readonly type: 'zap' | 'saved' | 'undo'; readonly index: number }
  /** The undo toast timed out (P2-21): the picker ends. */
  | { readonly type: 'close' }
  | { readonly type: 'cancel' }
  /** The panel accepted the hello and drew the candidates (the picker gives up without it). */
  | { readonly type: 'ready' }
  /** "Bigger area" / "Smaller area" (D-81): no payload; the picker owns the chain and answers with fresh candidates. */
  | { readonly type: 'widen' | 'narrow' };

type Obj = Readonly<Record<string, unknown>>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const keysAre = (o: Obj, keys: readonly string[]): boolean => Object.keys(o).sort().join() === [...keys].sort().join();
const isIndex = (x: unknown, size: number): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < size;

/** The nonce of a well-formed `hello`, or `null`. */
export function parseHello(data: unknown): string | null {
  if (!isObj(data) || !keysAre(data, ['type', 'nonce']) || data['type'] !== 'hello') return null;
  const nonce = data['nonce'];
  return typeof nonce === 'string' && NONCE.test(nonce) ? nonce : null;
}

function candidateOf(x: unknown): CandidateView | null {
  if (!isObj(x) || !keysAre(x, ['selector', 'count'])) return null;
  const { selector, count } = x;
  if (typeof selector !== 'string' || sanitiseSelector(selector) !== selector) return null;
  return Number.isInteger(count) && (count as number) >= 1 ? { selector, count: count as number } : null;
}

/** Candidates in slider order (narrow → wide) and the index of the best-ranked one. */
export interface CandidatesMessage {
  readonly type: 'candidates';
  readonly candidates: readonly CandidateView[];
  readonly initial: number;
  /** D-81: whether "Bigger area" / "Smaller area" can act, and whether the picked box is a large part of the page. */
  readonly canWiden?: boolean;
  readonly canNarrow?: boolean;
  readonly large?: boolean;
}

const AREA_FLAGS = ['canWiden', 'canNarrow', 'large'] as const;
const BASE_KEYS = ['type', 'candidates', 'initial'];

/** The area flags of `data`: all three booleans, or none (an older picker); `null` when anything else. */
function areaFlags(data: Obj): Pick<CandidatesMessage, (typeof AREA_FLAGS)[number]> | null {
  if (keysAre(data, BASE_KEYS)) return {};
  if (!keysAre(data, [...BASE_KEYS, ...AREA_FLAGS]) || !AREA_FLAGS.every((k) => typeof data[k] === 'boolean')) return null;
  return { canWiden: data['canWiden'] === true, canNarrow: data['canNarrow'] === true, large: data['large'] === true };
}

/** A `candidates` message, or `null` when anything in it is off. */
export function parseCandidates(data: unknown): CandidatesMessage | null {
  if (!isObj(data) || data['type'] !== 'candidates') return null;
  const flags = areaFlags(data);
  const list = data['candidates'];
  if (flags === null || !Array.isArray(list) || list.length === 0 || list.length > MAX_CANDIDATES || !isIndex(data['initial'], list.length)) return null;
  const parsed = list.map(candidateOf);
  const initial = data['initial'];
  return parsed.every((c) => c !== null) ? { type: 'candidates', candidates: parsed, initial, ...flags } : null;
}

/** A panel → picker message with its index inside `size`, or `null`. */
export function parsePanelMessage(data: unknown, size: number): PanelMessage | null {
  if (!isObj(data)) return null;
  const type = data['type'];
  if (type === 'cancel' || type === 'ready' || type === 'close' || type === 'widen' || type === 'narrow') return keysAre(data, ['type']) ? { type } : null;
  if (!keysAre(data, ['type', 'index'])) return null;
  const index = data['index'];
  if (type === 'preview') return index === null || isIndex(index, size) ? { type, index } : null;
  return (type === 'zap' || type === 'saved' || type === 'undo') && isIndex(index, size) ? { type, index } : null;
}
