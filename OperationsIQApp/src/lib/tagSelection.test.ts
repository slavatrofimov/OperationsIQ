import { describe, it, expect } from 'vitest';
import { isSelectionWithinLimit } from './tagSelection';

describe('isSelectionWithinLimit', () => {
  it('treats the limit as inclusive: reaching exactly the limit is allowed', () => {
    // Limit 25: selecting the 25th tag (grow 24 -> 25) must be allowed.
    expect(isSelectionWithinLimit(25, 24, 25)).toBe(true);
    // The 26th (grow 25 -> 26) is rejected.
    expect(isSelectionWithinLimit(26, 25, 25)).toBe(false);
  });

  it('allows building a selection all the way up to the limit', () => {
    const limit = 25;
    for (let next = 1; next <= limit; next++) {
      expect(isSelectionWithinLimit(next, next - 1, limit)).toBe(true);
    }
    expect(isSelectionWithinLimit(limit + 1, limit, limit)).toBe(false);
  });

  it('always allows shrinking, even when currently over the cap', () => {
    // Cap was lowered to 10 while 30 are selected; deselecting must still work.
    expect(isSelectionWithinLimit(29, 30, 10)).toBe(true);
    expect(isSelectionWithinLimit(10, 30, 10)).toBe(true);
    // But growing further while over the cap is rejected.
    expect(isSelectionWithinLimit(31, 30, 10)).toBe(false);
  });

  it('imposes no cap when the limit is undefined', () => {
    expect(isSelectionWithinLimit(1000, 999, undefined)).toBe(true);
  });

  it('supports a limit of 1 (single effective pick)', () => {
    expect(isSelectionWithinLimit(1, 0, 1)).toBe(true);
    expect(isSelectionWithinLimit(2, 1, 1)).toBe(false);
  });
});
