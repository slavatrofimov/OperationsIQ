/**
 * Retry / backoff helpers for the Foundry data-plane client.
 *
 * These are pure, side-effect-free decision helpers (plus one abort-aware sleep)
 * so the retry policy is unit-testable in isolation from `fetch`. The policy is
 * intentionally conservative about NON-idempotent requests — see `decideRetry`.
 */

export interface RetryPolicy {
  /** Maximum number of RETRIES (so total attempts = maxRetries + 1). */
  maxRetries: number;
  /** Base delay for exponential backoff, in ms. */
  baseDelayMs: number;
  /** Ceiling for any single backoff wait, in ms. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Hard ceiling applied even to a server-provided Retry-After, so a hostile or
 *  mis-configured header can never stall the UI for minutes. */
export const MAX_RETRY_AFTER_MS = 30_000;

export interface RetryContext {
  /** Zero-based index of the attempt that just failed (0 = first attempt). */
  attempt: number;
  /**
   * Whether the request is safe to replay. GET polls are idempotent. POSTs that
   * create a thread/run or submit tool outputs are NOT — replaying them can
   * duplicate a side effect, so they are only retried when we can prove the
   * server never processed the request (a network error = no response, or a
   * 429 = explicitly rejected/not processed).
   */
  idempotent: boolean;
  /** HTTP status if a response came back. Omitted for network errors. */
  status?: number;
  /** True when `fetch` threw (no response was received at all). */
  networkError?: boolean;
  policy?: RetryPolicy;
}

export interface RetryDecision {
  retry: boolean;
  reason: string;
}

/**
 * Which HTTP statuses are retryable, given idempotency.
 *  - 429 (Too Many Requests): the request was rejected before processing, so it
 *    is safe to retry even for a non-idempotent POST (honor Retry-After).
 *  - 502/503/504 (gateway / unavailable / timeout): safe to retry only for
 *    idempotent GETs. For a POST the upstream MAY already have processed the
 *    request, so retrying risks a duplicate side effect — do not.
 */
export function isRetryableStatus(status: number, idempotent: boolean): boolean {
  if (status === 429) return true;
  if (status === 502 || status === 503 || status === 504) return idempotent;
  return false;
}

/** Decide whether a failed attempt should be retried. Pure. */
export function decideRetry(ctx: RetryContext): RetryDecision {
  const policy = ctx.policy ?? DEFAULT_RETRY_POLICY;
  if (ctx.attempt >= policy.maxRetries) return { retry: false, reason: 'max_retries' };
  // A thrown fetch means no response was received (DNS/TLS/connect/reset). Even
  // for a non-idempotent POST this is safe to retry: the server never
  // acknowledged the request, so no side effect can have been committed.
  if (ctx.networkError) return { retry: true, reason: 'network' };
  if (ctx.status != null && isRetryableStatus(ctx.status, ctx.idempotent)) {
    return { retry: true, reason: `status_${ctx.status}` };
  }
  return { retry: false, reason: 'non_retryable' };
}

/** Exponential backoff with additive jitter (up to 25%), capped by the policy. */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  rand: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  const jitter = rand() * exp * 0.25;
  return Math.round(exp + jitter);
}

/**
 * Parse an HTTP `Retry-After` header into a delay in ms. Supports both the
 * delta-seconds form (`"120"`) and the HTTP-date form. Returns `undefined` when
 * the header is absent or unparseable so the caller can fall back to backoff.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * `setTimeout` wrapped in a Promise that rejects with an `AbortError` if the
 * signal fires during the wait, so a user cancellation is honored even while we
 * are backing off between retries or polling.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
