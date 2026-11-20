import { describe, expect, test } from 'vitest';
import { packCapacityText } from '../../../src/ui/packCapacity.js';

describe('packCapacityText (no-capacity detail, P2-26)', () => {
  test.each([
    [{ reason: 'rule-pool', needed: 1200, available: 300 } as const, 'This pack does not fit: Chrome has no room left for more blocking rules (it needs 1,200, 300 are left). Turn another pack off first.'],
    [{ reason: 'regex-pool', needed: 60, available: 1 } as const, 'This pack does not fit: Chrome allows only a limited number of pattern rules (it needs 60, 1 is left). Turn another pack off first.'],
    [undefined, 'This pack does not fit within Chrome’s limits. Turn another pack off first.'],
  ])('%o', (detail, text) => {
    expect(packCapacityText(detail)).toBe(text);
  });
});
