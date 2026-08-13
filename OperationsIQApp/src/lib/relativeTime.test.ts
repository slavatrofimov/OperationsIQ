import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RELATIVE_SPEC,
  RELATIVE_UNIT_OPTIONS,
  resolveRelativeRange,
} from './binningSettings';

describe('resolveRelativeRange', () => {
  const now = new Date('2026-03-15T12:00:00.000Z');

  it('defaults to the last one hour', () => {
    expect(DEFAULT_RELATIVE_SPEC).toEqual({ value: 1, unit: 'hours' });
    const { start, end } = resolveRelativeRange(DEFAULT_RELATIVE_SPEC, now);
    expect(end.getTime()).toBe(now.getTime());
    expect(end.getTime() - start.getTime()).toBe(3_600_000);
  });

  it('resolves fixed-length units with millisecond arithmetic', () => {
    expect(resolveRelativeRange({ value: 30, unit: 'seconds' }, now).start.getTime()).toBe(
      now.getTime() - 30_000,
    );
    expect(resolveRelativeRange({ value: 5, unit: 'minutes' }, now).start.getTime()).toBe(
      now.getTime() - 5 * 60_000,
    );
    expect(resolveRelativeRange({ value: 2, unit: 'days' }, now).start.getTime()).toBe(
      now.getTime() - 2 * 86_400_000,
    );
  });

  it('resolves months with calendar arithmetic', () => {
    const { start, end } = resolveRelativeRange({ value: 1, unit: 'months' }, now);
    expect(end.getTime()).toBe(now.getTime());
    // One calendar month earlier lands on the same day-of-month.
    const expected = new Date(now.getTime());
    expected.setMonth(expected.getMonth() - 1);
    expect(start.getTime()).toBe(expected.getTime());
  });

  it('coerces non-positive or non-finite values to 1', () => {
    expect(resolveRelativeRange({ value: 0, unit: 'hours' }, now).start.getTime()).toBe(
      now.getTime() - 3_600_000,
    );
    expect(resolveRelativeRange({ value: -4, unit: 'hours' }, now).start.getTime()).toBe(
      now.getTime() - 3_600_000,
    );
    expect(resolveRelativeRange({ value: Number.NaN, unit: 'hours' }, now).start.getTime()).toBe(
      now.getTime() - 3_600_000,
    );
  });

  it('offers months as a selectable unit', () => {
    expect(RELATIVE_UNIT_OPTIONS.map((o) => o.value)).toContain('months');
  });
});
