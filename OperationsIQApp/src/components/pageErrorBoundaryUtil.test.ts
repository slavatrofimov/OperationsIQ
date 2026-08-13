import { describe, it, expect } from 'vitest';
import { formatErrorDetails, shouldResetErrorBoundary } from './pageErrorBoundaryUtil';

describe('shouldResetErrorBoundary', () => {
  it('resets when showing an error and the key changed', () => {
    expect(shouldResetErrorBoundary('explore::p1', 'forecast::p1', true)).toBe(true);
  });

  it('resets when the active profile changed', () => {
    expect(shouldResetErrorBoundary('explore::p1', 'explore::p2', true)).toBe(true);
  });

  it('does not reset when there is no error', () => {
    expect(shouldResetErrorBoundary('explore::p1', 'forecast::p1', false)).toBe(false);
  });

  it('does not reset when the key is unchanged (e.g. an unrelated re-render)', () => {
    expect(shouldResetErrorBoundary('explore::p1', 'explore::p1', true)).toBe(false);
  });
});

describe('formatErrorDetails', () => {
  it('includes location, error name/message, and both stacks', () => {
    const error = new TypeError('boom');
    error.stack = 'TypeError: boom\n    at Page';
    const out = formatErrorDetails({
      resetKey: 'forecast::p1',
      error,
      componentStack: '\n    in ForecastPage\n    in PageErrorBoundary',
      timestamp: '2026-07-14T00:00:00.000Z',
    });
    expect(out).toContain('Location: forecast::p1');
    expect(out).toContain('Time: 2026-07-14T00:00:00.000Z');
    expect(out).toContain('Error: TypeError: boom');
    expect(out).toContain('Stack:');
    expect(out).toContain('at Page');
    expect(out).toContain('Component stack:');
    expect(out).toContain('in ForecastPage');
  });

  it('handles non-Error throwables without a stack section', () => {
    const out = formatErrorDetails({
      resetKey: 'explore::',
      error: 'string failure',
      timestamp: '2026-07-14T00:00:00.000Z',
    });
    expect(out).toContain('Error: Error: string failure');
    expect(out).not.toContain('Stack:');
    expect(out).not.toContain('Component stack:');
  });
});
