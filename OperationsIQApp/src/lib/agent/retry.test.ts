import { describe, it, expect } from 'vitest';
import {
  decideRetry,
  isRetryableStatus,
  parseRetryAfter,
  backoffDelayMs,
  abortableDelay,
  DEFAULT_RETRY_POLICY,
} from './retry';

describe('isRetryableStatus', () => {
  it('retries 429 regardless of idempotency (request rejected before processing)', () => {
    expect(isRetryableStatus(429, true)).toBe(true);
    expect(isRetryableStatus(429, false)).toBe(true);
  });

  it('retries 502/503/504 only for idempotent requests', () => {
    for (const s of [502, 503, 504]) {
      expect(isRetryableStatus(s, true)).toBe(true);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });

  it('does not retry other 4xx/5xx', () => {
    for (const s of [400, 401, 403, 404, 500]) {
      expect(isRetryableStatus(s, true)).toBe(false);
      expect(isRetryableStatus(s, false)).toBe(false);
    }
  });
});

describe('decideRetry', () => {
  it('retries network errors for both idempotent and non-idempotent requests', () => {
    expect(decideRetry({ attempt: 0, idempotent: true, networkError: true }).retry).toBe(true);
    expect(decideRetry({ attempt: 0, idempotent: false, networkError: true }).retry).toBe(true);
  });

  it('never retries a 5xx on a non-idempotent request (avoids duplicate side effects)', () => {
    expect(decideRetry({ attempt: 0, idempotent: false, status: 503 }).retry).toBe(false);
    expect(decideRetry({ attempt: 0, idempotent: true, status: 503 }).retry).toBe(true);
  });

  it('retries 429 on a non-idempotent request', () => {
    expect(decideRetry({ attempt: 0, idempotent: false, status: 429 }).retry).toBe(true);
  });

  it('stops retrying once the attempt count reaches maxRetries', () => {
    const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2 };
    expect(decideRetry({ attempt: 1, idempotent: true, networkError: true, policy }).retry).toBe(true);
    expect(decideRetry({ attempt: 2, idempotent: true, networkError: true, policy }).retry).toBe(false);
  });

  it('does not retry a non-retryable status', () => {
    const d = decideRetry({ attempt: 0, idempotent: true, status: 400 });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('non_retryable');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2024-01-01T00:00:00Z');
    const future = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(future, now)).toBe(30_000);
  });

  it('clamps a past HTTP-date to 0', () => {
    const now = Date.parse('2024-01-01T00:00:00Z');
    const past = new Date(now - 5_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns undefined for missing/blank/garbage headers', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('   ')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially and is capped by the policy', () => {
    const zeroJitter = () => 0;
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, zeroJitter)).toBe(500);
    expect(backoffDelayMs(1, DEFAULT_RETRY_POLICY, zeroJitter)).toBe(1000);
    expect(backoffDelayMs(2, DEFAULT_RETRY_POLICY, zeroJitter)).toBe(2000);
    // 500 * 2^6 = 32000 -> capped at maxDelayMs (8000)
    expect(backoffDelayMs(6, DEFAULT_RETRY_POLICY, zeroJitter)).toBe(8000);
  });

  it('adds up to 25% jitter', () => {
    const fullJitter = () => 1;
    expect(backoffDelayMs(0, DEFAULT_RETRY_POLICY, fullJitter)).toBe(625); // 500 + 25%
  });
});

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const c = new AbortController();
    c.abort();
    await expect(abortableDelay(1000, c.signal)).rejects.toThrow(/abort/i);
  });

  it('rejects when aborted mid-wait', async () => {
    const c = new AbortController();
    const p = abortableDelay(1000, c.signal);
    c.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
