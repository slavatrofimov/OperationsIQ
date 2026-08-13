// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  LivyClient,
  LivyAuthError,
  LIVY_MAX_TRANSIENT_RETRIES,
} from './livyClient';

function makeClient(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);
  return new LivyClient({
    workspaceId: 'ws',
    lakehouseId: 'lh',
    getToken: async () => 'test-token',
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('LivyClient transient 415 handling', () => {
  it('retries a cold-gateway 415 and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unsupported', { status: 415 }))
      .mockResolvedValueOnce(new Response('unsupported', { status: 415 }))
      .mockResolvedValueOnce(jsonResponse({ id: 7, state: 'starting' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    vi.useFakeTimers();
    const pending = client.createSession();
    await vi.runAllTimersAsync();
    const doc = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(doc.id).toBe(7);
  });

  it('surfaces a friendly error when 415 persists past every retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unsupported', { status: 415 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    vi.useFakeTimers();
    const pending = client.createSession();
    // Attach the assertion before draining timers so the rejection is observed.
    const assertion = expect(pending).rejects.toThrow(/415 \(Unsupported Media Type\)/);
    await vi.runAllTimersAsync();
    await assertion;

    // 1 initial attempt + the configured number of retries.
    expect(fetchMock).toHaveBeenCalledTimes(LIVY_MAX_TRANSIENT_RETRIES + 1);
  });

  it('does not treat a 401 as a transient 415 (no retry, throws LivyAuthError)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const client = makeClient(fetchMock as unknown as typeof fetch);

    await expect(client.createSession()).rejects.toBeInstanceOf(LivyAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
