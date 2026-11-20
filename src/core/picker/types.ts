/**
 * Types of the selector candidate generator (P2-17). `PickerNode` is the part of a DOM `Element` the
 * generator reads, so the picker content script passes real elements and tests pass jsdom ones; the
 * core itself never touches `document` or `chrome.*`.
 */

/** Read-only view of an element: a DOM `Element` satisfies it structurally. */
export interface PickerNode {
  readonly tagName: string;
  readonly id: string;
  readonly classList: Iterable<string>;
  readonly parentElement: PickerNode | null;
  readonly children: ArrayLike<PickerNode>;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
}

/** How a candidate anchors the element, from the most to the least stable. */
export type CandidateKind = 'id' | 'attribute' | 'class' | 'ancestor' | 'structural';

export interface Candidate {
  readonly selector: string;
  readonly kind: CandidateKind;
  /** Higher is better: stable anchors score high, generated-looking names are penalised. */
  readonly score: number;
}

/** A candidate checked against the page: how many elements it matches (the target included). */
export interface RankedCandidate extends Candidate {
  readonly count: number;
}
