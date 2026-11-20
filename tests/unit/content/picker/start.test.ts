import { describe, expect, test } from 'vitest';
import { acceptStart, NONCE_PATTERN, PICKER_START } from '../../../../src/content/picker/start.js';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const nonce = 'n0nce-n0nce_n0nce-12';
const msg = { type: PICKER_START, nonce, mode: 'hide' };

describe('acceptStart (x/pickerStart, design review P2-18)', () => {
  test('accepts the worker’s start message', () => {
    expect(acceptStart(msg, { id: ID }, ID)).toEqual({ nonce, mode: 'hide', hint: null });
    expect(acceptStart({ ...msg, mode: 'zap' }, { id: ID }, ID)).toEqual({ nonce, mode: 'zap', hint: null });
  });

  test('a context-menu hint (P3-17) is checked again; a malformed one is dropped, the start stands', () => {
    const hint = { kind: 'image', url: 'https://cdn.example/p.png' };
    expect(acceptStart({ ...msg, hint }, { id: ID }, ID)).toEqual({ nonce, mode: 'hide', hint });
    expect(acceptStart({ ...msg, hint: { kind: 'image', url: 'data:x' } }, { id: ID }, ID)).toEqual({ nonce, mode: 'hide', hint: null });
    expect(acceptStart({ ...msg, hint: '#ad' }, { id: ID }, ID)).toEqual({ nonce, mode: 'hide', hint: null });
  });

  test.each([
    ['another extension', msg, { id: 'other' }],
    ['a tab (content script or page)', msg, { id: ID, tab: { id: 3 } }],
    ['wrong type', { ...msg, type: 'x/other' }, { id: ID }],
    ['bad nonce', { ...msg, nonce: 'short' }, { id: ID }],
    ['bad mode', { ...msg, mode: 'save' }, { id: ID }],
    ['extra field', { ...msg, hostname: 'x.example' }, { id: ID }],
    ['not an object', 'x', { id: ID }],
    ['null', null, { id: ID }],
  ])('refuses %s', (_name, message, sender) => {
    expect(acceptStart(message, sender, ID)).toBeNull();
  });

  test('nonce pattern matches the shared envelope’s', () => {
    expect(NONCE_PATTERN.test('a'.repeat(16))).toBe(true);
    expect(NONCE_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});
