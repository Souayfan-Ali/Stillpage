import { describe, expect, test } from 'vitest';
import { GUARD_ALONE, type PopupRow } from '../../fixtures/popupManifest.js';
import { expectationFailures, mustPassGate, smartGate, staleMarkers, strictGate, wakeGate, type Observed } from '../../fixtures/popupGates.js';

/** A synthetic guard-alone row; P8b is the allowed miss, as in fixtures.json. */
function guardRow(technique: string, alone = true): PopupRow {
  const miss = technique === 'P8b';
  return {
    id: `popups/${technique.toLowerCase()}`,
    family: 'popups',
    technique,
    page: 'https://reader.example/popups/x.html',
    file: 'popups/x.html',
    act: { click: '#text' },
    target: 'https://popunder.example/ad',
    ...(alone && { guardAlone: true as const }),
    expect: { guardOff: 'opened', smart: miss ? 'miss' : 'blocked', strict: miss ? 'miss' : 'blocked' },
  };
}

function allowRow(technique: string, strict: 'opened' | 'blocked' = 'blocked'): PopupRow {
  return { ...guardRow('P1', false), id: `popups-allow/${technique.toLowerCase()}`, family: 'popups-allow', technique, expect: { guardOff: 'opened', smart: 'opened', strict } };
}

const table = (blocked: readonly string[]): Observed[] =>
  GUARD_ALONE.map((t) => ({ row: guardRow(t), verdict: blocked.includes(t) ? 'blocked' : 'opened' }));
const allBut = (...missed: string[]): string[] => GUARD_ALONE.filter((t) => !missed.includes(t));

describe('Smart block-rate gate (pop-up notes §14: ≥ 90 % of the 14 guard-alone pages)', () => {
  test('13 of 14 passes (the S-20 result, P8b missed)', () => {
    const r = smartGate(table(allBut('P8b')));
    expect(r).toMatchObject({ pass: true, blocked: 13, total: 14, missed: ['popups/p8b'] });
  });

  test('12 of 14 fails', () => {
    expect(smartGate(table(allBut('P8b', 'P7')))).toMatchObject({ pass: false, blocked: 12, total: 14 });
  });

  test('rows outside the guard-alone set do not count', () => {
    const extra: Observed = { row: allowRow('A1'), verdict: 'opened' };
    expect(smartGate([...table(allBut('P8b')), extra])).toMatchObject({ pass: true, total: 14 });
  });

  test('an incomplete guard-alone set fails rather than passing on fewer pages', () => {
    expect(smartGate(table(allBut()).slice(1))).toMatchObject({ pass: false, total: 13 });
  });
});

describe('Strict gate: every guard-alone page except P8b', () => {
  test('all but P8b blocked passes', () => {
    expect(strictGate(table(allBut('P8b')))).toEqual({ pass: true, failures: [] });
  });

  test('a Strict miss other than P8b fails', () => {
    expect(strictGate(table(allBut('P8b', 'P3')))).toEqual({ pass: false, failures: ['popups/p3'] });
  });
});

describe('must-pass gate (A1–A13 and the S-21 flows: 0 blocked)', () => {
  test('nothing blocked passes', () => {
    expect(mustPassGate([{ row: allowRow('A1'), verdict: 'opened' }], 'smart')).toEqual({ pass: true, failures: [] });
  });

  test('any must-pass row blocked fails', () => {
    expect(mustPassGate([{ row: allowRow('A1'), verdict: 'opened' }, { row: allowRow('A4'), verdict: 'blocked' }], 'smart')).toEqual({ pass: false, failures: ['popups-allow/a4'] });
  });

  test('in Strict, rows Strict is meant to block are not must-pass', () => {
    expect(mustPassGate([{ row: allowRow('A4'), verdict: 'blocked' }, { row: allowRow('A5', 'opened'), verdict: 'opened' }], 'strict')).toEqual({ pass: true, failures: [] });
    expect(mustPassGate([{ row: allowRow('A5', 'opened'), verdict: 'blocked' }], 'strict').pass).toBe(false);
  });
});

describe('wake-up gate (boot counter, S-22)', () => {
  test('no new boot passes; one fails', () => {
    expect(wakeGate(3, 3)).toEqual({ pass: true, wakes: 0 });
    expect(wakeGate(3, 4)).toEqual({ pass: false, wakes: 1 });
  });
});

describe('expectation failures per mode', () => {
  test('a miss accepts either verdict; other verdicts must match', () => {
    const p8b = guardRow('P8b');
    expect(expectationFailures([{ row: p8b, verdict: 'opened' }, { row: p8b, verdict: 'blocked' }], 'smart')).toEqual([]);
    expect(expectationFailures([{ row: guardRow('P1'), verdict: 'opened' }], 'smart')).toEqual([{ id: 'popups/p1', wanted: 'blocked', actual: 'opened' }]);
    expect(expectationFailures([{ row: guardRow('P1'), verdict: 'opened' }], 'guardOff')).toEqual([]);
  });

  test('a row without a verdict for the mode is a failure, not a pass', () => {
    const row: PopupRow = { ...guardRow('P1'), expect: { guardOff: 'opened' } };
    expect(expectationFailures([{ row, verdict: 'blocked' }], 'smart')).toEqual([{ id: 'popups/p1', wanted: 'none', actual: 'blocked' }]);
  });
});

describe('stale pending markers (a skip must not outlive the file it waits for)', () => {
  const pending = (reason: string): PopupRow => ({ ...guardRow('P1'), pending: reason });
  const GUARD = pending('P2-57: the pop-up guard (popup-sentinel + popup-shim) does not exist yet');
  const PAGE = pending('P2-55: the blocked page (blocked.html) does not exist yet');

  test('no named file shipped: nothing is stale', () => {
    expect(staleMarkers([GUARD, PAGE], ['background.js', 'popup.html'])).toEqual([]);
  });

  test('a row that names a file the build ships is stale', () => {
    expect(staleMarkers([GUARD], ['content-scripts/popup-sentinel.js'])).toEqual(['popups/p1']);
    expect(staleMarkers([PAGE], ['blocked.html'])).toHaveLength(1);
    expect(staleMarkers([pending('P2-63: the notification-prompt gate (notify-gate.js) does not exist yet')], ['notify-gate.js'])).toHaveLength(1);
  });

  test('a row waiting for a piece inside a shipped file names no file and is not stale (blocked page shipped, Proceed once not)', () => {
    const proceed = pending('P2-55: the Proceed once handler (c/proceedOnce) is not wired yet');
    expect(staleMarkers([proceed], ['blocked.html'])).toEqual([]);
    expect(staleMarkers([pending('P2-60: the per-site control does not exist yet')], ['blocked.html', 'popup-sentinel.js'])).toEqual([]);
  });
});
