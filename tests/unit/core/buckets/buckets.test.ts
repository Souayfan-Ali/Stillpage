import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bucketIndexOf as compilerIndexOf } from '../../../../compiler/emit/buckets.js';
import { bucketOf, readBuckets, rulesetCategory, type BucketMap } from '../../../../src/core/buckets/buckets.js';

const RAW = {
  schema: 1,
  buckets: [
    { id: 'google', name: 'Google', category: 'company' },
    { id: 'other:ads', name: 'Other', category: 'ads' },
    { id: 'other:tracking', name: 'Other', category: 'tracking' },
  ],
  rulesets: {
    ubo: [[1, 1], [3, 0], [5, 1], [9, -1]],
    easyprivacy: [[1, 2], [2, 0], [4, -1]],
    odd: [[1, 0], [2, -1]],
  },
};

const map = (): BucketMap => {
  const read = readBuckets(RAW);
  if (read === null) throw new Error('invalid');
  return read;
};

describe('readBuckets (packaged buckets.json, P2-11)', () => {
  test('accepts the compiler format and rejects anything else', () => {
    expect(map().buckets).toHaveLength(3);
    expect(readBuckets(null)).toBeNull();
    expect(readBuckets({ ...RAW, schema: 2 })).toBeNull();
    expect(readBuckets({ ...RAW, rulesets: { ubo: [[1, 7]] } })).toBeNull();
    expect(readBuckets({ ...RAW, rulesets: { ubo: [[3, 0], [1, 0]] } })).toBeNull();
    expect(readBuckets({ ...RAW, rulesets: { 'Bad Id': [[1, 0]] } })).toBeNull();
    expect(readBuckets({ ...RAW, buckets: [{ id: 'x', name: 'X' }] })).toBeNull();
    expect(readBuckets({ ...RAW, rulesets: { constructor: [[1, 0]] } })).not.toBeNull();
  });
});

describe('bucketOf: runs [firstId, bucket] closed by -1', () => {
  test.each([
    [1, 'other:ads'],
    [2, 'other:ads'],
    [3, 'google'],
    [4, 'google'],
    [5, 'other:ads'],
    [8, 'other:ads'],
    [9, 'other:ads'],
    [100, 'other:ads'],
    [0, 'other:ads'],
  ])('ubo#%i → %s (ids outside the map are "Other" of the ruleset category)', (id, bucket) => {
    expect(bucketOf(map(), 'ubo', id)).toBe(bucket);
  });

  test('a ruleset missing from the map, or with no category, is other:other', () => {
    expect(bucketOf(map(), 'cookies', 5)).toBe('other:other');
    expect(bucketOf(map(), 'odd', 1)).toBe('google');
    expect(bucketOf(map(), 'odd', 2)).toBe('other:other');
  });

  test('agrees with the compiler lookup on every id', () => {
    const runs = RAW.rulesets.ubo as [number, number][];
    for (let id = 0; id < 12; id += 1) {
      const expected = compilerIndexOf(runs, id);
      const bucket = expected === -1 ? 'other:ads' : (RAW.buckets[expected]?.id ?? '');
      expect(bucketOf(map(), 'ubo', id)).toBe(bucket);
    }
  });
});

describe('rulesetCategory: from the ruleset own other:<category> fallback', () => {
  test('one fallback category, none, or a missing ruleset', () => {
    expect(rulesetCategory(map(), 'ubo')).toBe('ads');
    expect(rulesetCategory(map(), 'easyprivacy')).toBe('tracking');
    expect(rulesetCategory(map(), 'odd')).toBe('other');
    expect(rulesetCategory(map(), 'cookies')).toBe('other');
  });

  const built = path.resolve(import.meta.dirname, '../../../../public/buckets.json');
  test.skipIf(!existsSync(built))('every ruleset of the built buckets.json resolves to exactly one known category (design review, P2-11)', () => {
    const raw = JSON.parse(readFileSync(built, 'utf8')) as { rulesets: Record<string, [number, number][]>; buckets: { id: string }[] };
    const read = readBuckets(raw);
    if (read === null) throw new Error('the built buckets.json is invalid');
    for (const [id, runs] of Object.entries(raw.rulesets)) {
      const fallbacks = new Set(runs.map(([, b]) => raw.buckets[b]?.id).filter((b) => b?.startsWith('other:')));
      expect(fallbacks.size, id).toBe(1);
      expect(rulesetCategory(read, id), id).not.toBe('other');
    }
  });
});
