import { describe, expect, test } from 'vitest';
import { errorText } from '../../../../compiler/cli/errors.js';

/** P2-44: a CLI's top-level failure prints the whole `cause` chain, not only the outer message. */
describe('errorText', () => {
  test('prints the message and every cause, innermost last', () => {
    const inner = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const error = new Error('cannot read lists.config.json', { cause: new Error('read failed', { cause: inner }) });
    expect(errorText(error)).toBe('cannot read lists.config.json\n  caused by: read failed\n  caused by: EACCES: permission denied');
  });

  test('prints a non-Error throw and a non-Error cause as text', () => {
    expect(errorText('boom')).toBe('boom');
    expect(errorText(new Error('outer', { cause: 42 }))).toBe('outer\n  caused by: 42');
    expect(errorText(new Error('outer', { cause: 7n }))).toBe('outer\n  caused by: 7');
    expect(errorText(Symbol('s'))).toBe('symbol');
  });

  test('stops at a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(errorText(b)).toBe('b\n  caused by: a');
  });
});
