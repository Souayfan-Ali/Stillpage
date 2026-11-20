// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { applyTheme, tabIdFromSearch } from '../../../../src/features/popup/page.js';

describe('panel page helpers', () => {
  test.each([
    ['?tabId=0', 0],
    ['?tabId=42', 42],
    ['?tabId=-1', null],
    ['?tabId=1.5', null],
    ['?tabId=01', null],
    ['?tabId=abc', null],
    ['?tabId=99999999999', null],
    ['', null],
  ])('tabIdFromSearch(%j) = %j', (search, expected) => {
    expect(tabIdFromSearch(search)).toBe(expected);
  });

  test('applyTheme sets and clears the manual override', () => {
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    expect(root.dataset['theme']).toBe('dark');
    applyTheme(root, 'system');
    expect(root.dataset['theme']).toBeUndefined();
  });
});
