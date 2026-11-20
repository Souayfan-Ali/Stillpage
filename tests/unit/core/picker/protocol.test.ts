import { describe, expect, test } from 'vitest';
import { MAX_CANDIDATES, parseCandidates, parseHello, parsePanelMessage } from '../../../../src/core/picker/protocol.js';
import { PICKER_SESSION_TTL_MS, pickerSessionKey, readPickerSession, usableSession } from '../../../../src/core/picker/session.js';

const NONCE = 'abcdefghijklmnop-123';
const NOW = 1_800_000_000_000;

describe('parseHello', () => {
  test('accepts exactly { type: "hello", nonce }', () => {
    expect(parseHello({ type: 'hello', nonce: NONCE })).toBe(NONCE);
  });
  test.each([[null], ['hello'], [{ type: 'hello' }], [{ type: 'hello', nonce: 'short' }], [{ type: 'hi', nonce: NONCE }], [{ type: 'hello', nonce: NONCE, x: 1 }]])(
    'refuses %j', (data) => {
      expect(parseHello(data)).toBeNull();
    });
});

describe('parseCandidates (selectors come from the page’s DOM: untrusted)', () => {
  test('accepts sanitised selectors with positive integer counts', () => {
    const data = { type: 'candidates', candidates: [{ selector: '#ad', count: 1 }, { selector: 'div.ad', count: 3 }], initial: 1 };
    expect(parseCandidates(data)).toEqual(data);
    expect(parseCandidates({ ...data, initial: 2 })).toBeNull();
  });
  test.each([
    ['unsafe selector', [{ selector: 'a{}', count: 1 }]],
    ['zero count', [{ selector: '#ad', count: 0 }]],
    ['fractional count', [{ selector: '#ad', count: 1.5 }]],
    ['extra key', [{ selector: '#ad', count: 1, x: 1 }]],
    ['empty list', []],
    ['too many', Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({ selector: `#a${String(i)}`, count: 1 }))],
    ['over-long selector', [{ selector: `#${'a'.repeat(1_100)}`, count: 1 }]],
  ])('refuses %s', (_name, candidates) => {
    expect(parseCandidates({ type: 'candidates', candidates, initial: 0 })).toBeNull();
  });
  test('D-81: the area flags are booleans, all three or none', () => {
    const base = { type: 'candidates', candidates: [{ selector: '#ad', count: 1 }], initial: 0 };
    const flagged = { ...base, canWiden: true, canNarrow: false, large: true };
    expect(parseCandidates(flagged)).toEqual(flagged);
    expect(parseCandidates({ ...flagged, large: 'yes' })).toBeNull();
    expect(parseCandidates({ ...flagged, canWiden: 1 })).toBeNull();
    expect(parseCandidates({ ...base, canWiden: true })).toBeNull();
  });
  test('refuses another shape', () => {
    expect(parseCandidates({ type: 'other', candidates: [], initial: 0 })).toBeNull();
    expect(parseCandidates(null)).toBeNull();
    expect(parseCandidates({ type: 'candidates', candidates: 'x', initial: 0 })).toBeNull();
  });
});

describe('parsePanelMessage: indices only, bounds-checked', () => {
  test.each([
    [{ type: 'preview', index: 2 }, { type: 'preview', index: 2 }],
    [{ type: 'preview', index: null }, { type: 'preview', index: null }],
    [{ type: 'zap', index: 0 }, { type: 'zap', index: 0 }],
    [{ type: 'saved', index: 1 }, { type: 'saved', index: 1 }],
    [{ type: 'cancel' }, { type: 'cancel' }],
    [{ type: 'ready' }, { type: 'ready' }],
    [{ type: 'close' }, { type: 'close' }],
    [{ type: 'undo', index: 1 }, { type: 'undo', index: 1 }],
    [{ type: 'widen' }, { type: 'widen' }],
    [{ type: 'narrow' }, { type: 'narrow' }],
  ])('%j', (data, expected) => {
    expect(parsePanelMessage(data, 3)).toEqual(expected);
  });
  test.each([
    [{ type: 'zap', index: 3 }], [{ type: 'zap', index: -1 }], [{ type: 'zap', index: 1.5 }], [{ type: 'zap' }],
    [{ type: 'save', selector: '#x' }], [{ type: 'cancel', x: 1 }], [{ type: 'preview', index: 'x' }], [null], [[]],
    // D-81: widen / narrow carry no payload (no selector, no element, no index).
    [{ type: 'widen', index: 1 }], [{ type: 'narrow', selector: 'body' }], [{ type: 'widen', steps: 3 }],
  ])('refuses %j', (data) => {
    expect(parsePanelMessage(data, 3)).toBeNull();
  });
});

describe('picker session record (storage.session, written by the worker)', () => {
  const record = { tabId: 4, hostname: 'news.example.com', mode: 'hide', createdAt: NOW, claimed: false };
  test('key and guard', () => {
    expect(pickerSessionKey(NONCE)).toBe(`picker:${NONCE}`);
    expect(readPickerSession(record)).toEqual(record);
  });
  test.each([
    [{ ...record, hostname: 'Bad Host' }], [{ ...record, tabId: -1 }], [{ ...record, mode: 'x' }], [{ ...record, claimed: 'no' }],
    [{ ...record, extra: 1 }], [null], [{ ...record, createdAt: 'x' }],
  ])('refuses %j', (raw) => {
    expect(readPickerSession(raw)).toBeNull();
  });
  test('usable: same tab, not claimed, younger than the TTL', () => {
    const s = readPickerSession(record);
    if (s === null) throw new Error('fixture');
    expect(usableSession(s, 4, NOW + PICKER_SESSION_TTL_MS)).toBe(true);
    expect(usableSession(s, 5, NOW)).toBe(false);
    expect(usableSession({ ...s, claimed: true }, 4, NOW)).toBe(false);
    expect(usableSession(s, 4, NOW + PICKER_SESSION_TTL_MS + 1)).toBe(false);
    expect(usableSession(s, 4, NOW - 1)).toBe(false);
  });
});
