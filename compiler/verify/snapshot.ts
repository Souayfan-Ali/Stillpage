/**
 * Snapshot oracle (filter-pipeline notes §11 check 2, P1-31): this build against the previous build's files —
 * counts, bytes, and a fixed sample of up to 200 rules per ruleset (every k-th id of the previous
 * file) checked for being still present unchanged under the same id. Reported, never fatal: large
 * moves are what the growth guard escalates.
 */
import type { DnrRule } from '../dnr/schema.js';

const SAMPLE_SIZE = 200;

export interface SnapshotRow {
  readonly slot: string;
  readonly rulesBefore: number;
  readonly rulesAfter: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly sampled: number;
  /** Sampled rules found again with the same id and the same content. */
  readonly unchanged: number;
}

/** Every k-th rule, up to `SAMPLE_SIZE`. */
export function sampleOf(rules: readonly DnrRule[]): readonly DnrRule[] {
  const step = Math.max(1, Math.ceil(rules.length / SAMPLE_SIZE));
  return rules.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
}

/** One row per slot present in either build. Texts are the ruleset files (JSON arrays). */
export function snapshotDiff(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly SnapshotRow[] {
  const slots = [...new Set([...before.keys(), ...after.keys()])].sort();
  return slots.map((slot) => {
    const [b, a] = [before.get(slot) ?? '[]', after.get(slot) ?? '[]'];
    const prev = JSON.parse(b) as DnrRule[];
    const now = new Map((JSON.parse(a) as DnrRule[]).map((r) => [r.id, JSON.stringify(r)]));
    const sample = sampleOf(prev);
    return {
      slot, rulesBefore: prev.length, rulesAfter: now.size, bytesBefore: Buffer.byteLength(b), bytesAfter: Buffer.byteLength(a),
      sampled: sample.length, unchanged: sample.filter((r) => now.get(r.id) === JSON.stringify(r)).length,
    };
  });
}
