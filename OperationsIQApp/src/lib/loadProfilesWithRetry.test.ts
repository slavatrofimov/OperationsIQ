import { describe, it, expect, vi } from 'vitest';
import { loadProfilesWithRetry, MAX_LOAD_ATTEMPTS } from './loadProfilesWithRetry';

/** Minimal fake profile shape — the loader is generic and only forwards items. */
interface FakeProfile {
  id: string;
}

function makeDeps(overrides: Partial<Parameters<typeof loadProfilesWithRetry<FakeProfile>>[0]> = {}) {
  const ensureSession = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue([{ id: 'p1' }]);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const delayMs = vi.fn().mockReturnValue(0);
  return {
    ensureSession,
    list,
    sleep,
    delayMs,
    ...overrides,
  } as Parameters<typeof loadProfilesWithRetry<FakeProfile>>[0] & {
    ensureSession: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
    delayMs: ReturnType<typeof vi.fn>;
  };
}

describe('loadProfilesWithRetry', () => {
  it('establishes the session before listing on the first (successful) attempt', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    deps.ensureSession.mockImplementation(async () => {
      order.push('session');
    });
    deps.list.mockImplementation(async () => {
      order.push('list');
      return [{ id: 'p1' }];
    });

    const result = await loadProfilesWithRetry(deps);

    expect(result).toEqual([{ id: 'p1' }]);
    expect(order).toEqual(['session', 'list']);
    expect(deps.ensureSession).toHaveBeenCalledTimes(1);
    expect(deps.list).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure and re-establishes the session each attempt', async () => {
    const deps = makeDeps();
    // Fail once (transient CORS/network), then succeed.
    deps.list
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce([{ id: 'restored' }]);

    const result = await loadProfilesWithRetry(deps);

    expect(result).toEqual([{ id: 'restored' }]);
    expect(deps.list).toHaveBeenCalledTimes(2);
    // Session is (re)confirmed before every list attempt.
    expect(deps.ensureSession).toHaveBeenCalledTimes(2);
    // Backed off exactly once, between the two attempts.
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(deps.delayMs).toHaveBeenCalledWith(0);
  });

  it('gives up after MAX_LOAD_ATTEMPTS and rejects with the last error', async () => {
    const deps = makeDeps();
    const err = new Error('backend cold');
    deps.list.mockRejectedValue(err);

    await expect(loadProfilesWithRetry(deps)).rejects.toThrow('backend cold');
    expect(deps.list).toHaveBeenCalledTimes(MAX_LOAD_ATTEMPTS);
    // Sleeps between attempts, but not after the final failure.
    expect(deps.sleep).toHaveBeenCalledTimes(MAX_LOAD_ATTEMPTS - 1);
  });

  it('honours a custom maxAttempts', async () => {
    const deps = makeDeps({ maxAttempts: 1 });
    deps.list.mockRejectedValue(new Error('nope'));

    await expect(loadProfilesWithRetry(deps)).rejects.toThrow('nope');
    expect(deps.list).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('retries when ensureSession itself fails transiently', async () => {
    const deps = makeDeps();
    deps.ensureSession
      .mockRejectedValueOnce(new Error('session hydrate race'))
      .mockResolvedValue(undefined);

    const result = await loadProfilesWithRetry(deps);

    expect(result).toEqual([{ id: 'p1' }]);
    expect(deps.ensureSession).toHaveBeenCalledTimes(2);
    // list is only reached once the session succeeds.
    expect(deps.list).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledTimes(1);
  });
});
