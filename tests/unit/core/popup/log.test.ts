import { describe, expect, test } from 'vitest';
import { readPopupLog } from '../../../../src/core/popup/log.js';

describe('readPopupLog (P2-62): the sentinel answer is untrusted', () => {
  test('a valid answer is kept', () => {
    expect(readPopupLog({ hosts: ['ad.example'], blocked: 3, codes: ['G11', 'TU', 'D'] })).toEqual({ hosts: ['ad.example'], blocked: 3, codes: ['G11', 'TU', 'D'] });
  });

  test.each([
    [null],
    [undefined],
    [{ hosts: ['ad.example'] }],
    [{ hosts: ['Not A Host'], blocked: 1, codes: [] }],
    [{ hosts: [], blocked: -1, codes: [] }],
    [{ hosts: [], blocked: 1.5, codes: [] }],
    [{ hosts: [], blocked: 1, codes: ['<script>'] }],
    [{ hosts: Array.from({ length: 21 }, (_, i) => `h${String(i)}.example`), blocked: 1, codes: [] }],
    [{ hosts: [], blocked: 1, codes: [], extra: true }],
  ])('%j reads as no sentinel', (raw) => {
    expect(readPopupLog(raw)).toBeNull();
  });
});
