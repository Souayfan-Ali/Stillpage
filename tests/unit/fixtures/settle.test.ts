import { describe, expect, test } from 'vitest';
import { settleVisits } from '../../e2e/helpers/settle.js';

/** A visit whose outcome is the next reading of `readings`; `now` advances by `stepMs` per visit. */
function scripted(readings: readonly (readonly unknown[])[], stepMs: number) {
  let i = 0;
  let t = 0;
  return {
    visit: () => {
      const actual = readings[Math.min(i, readings.length - 1)] ?? [];
      i += 1;
      t += stepMs;
      return Promise.resolve({ wanted: ['loaded'], actual });
    },
    now: () => t,
    visits: () => i,
  };
}

describe('settleVisits (P2-47 stability: Chrome applies a rule change to new loads a little after the API resolved)', () => {
  test('a first matching visit is returned at once', async () => {
    const s = scripted([['loaded']], 100);
    expect(await settleVisits(s.visit, 5_000, s.now)).toEqual({ wanted: ['loaded'], actual: ['loaded'], visits: 1 });
  });

  test('the first load after a change may still see the old state: visits again until it matches', async () => {
    const s = scripted([['blocked'], ['loaded']], 100);
    expect(await settleVisits(s.visit, 5_000, s.now)).toEqual({ wanted: ['loaded'], actual: ['loaded'], visits: 2 });
  });

  test('a state that never arrives is reported as the last reading once the window is spent', async () => {
    const s = scripted([['blocked']], 1_000);
    expect(await settleVisits(s.visit, 5_000, s.now)).toEqual({ wanted: ['loaded'], actual: ['blocked'], visits: 5 });
  });
});
