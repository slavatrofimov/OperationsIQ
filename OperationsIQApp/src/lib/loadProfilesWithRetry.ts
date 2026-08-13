/**
 * Pure, dependency-injected loader for the connection-profile list with bounded
 * retry/backoff. Kept free of heavy imports (no RayfinClient / MSAL) so it is
 * unit-testable in Node without a DOM or network, and so the retry policy is
 * verified in isolation from React.
 *
 * The profile list is read from the Rayfin backend GraphQL endpoint, which —
 * right after a redeploy — may still be warming up and reject the request
 * (surfacing as a CORS / network error). Because listing is a read (idempotent),
 * a transient failure is safe to retry. Without this, a single cold-backend blip
 * previously presented as a spurious "no connections configured" prompt until
 * the user reloaded the page.
 */

/** Total attempts (1 initial + retries) for a profile load. */
export const MAX_LOAD_ATTEMPTS = 3;

export interface LoadProfilesDeps<T> {
  /** Establish (or confirm) the backend session before listing. Must run first
   *  on every attempt so the request is authenticated and correctly targeted. */
  ensureSession: () => Promise<unknown>;
  /** Fetch the profile list from the backend. */
  list: () => Promise<T[]>;
  /** Backoff delay (ms) to wait after the given zero-based failed attempt. */
  delayMs: (attempt: number) => number;
  /** Sleep helper (injected so tests can use fake timers). */
  sleep: (ms: number) => Promise<void>;
  /** Total attempts (1 initial + retries). Defaults to 3. */
  maxAttempts?: number;
}

/**
 * Attempt {@link LoadProfilesDeps.ensureSession} + {@link LoadProfilesDeps.list}
 * up to `maxAttempts` times, sleeping `delayMs(attempt)` between failures.
 * Resolves with the list on the first success. If every attempt fails, rejects
 * with the last error — so the caller can distinguish a failed load from a
 * genuinely empty list.
 */
export async function loadProfilesWithRetry<T>(deps: LoadProfilesDeps<T>): Promise<T[]> {
  const maxAttempts = deps.maxAttempts ?? MAX_LOAD_ATTEMPTS;
  let lastError: unknown = new Error('loadProfilesWithRetry: no attempts made');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await deps.ensureSession();
      return await deps.list();
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts - 1) {
        await deps.sleep(deps.delayMs(attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
