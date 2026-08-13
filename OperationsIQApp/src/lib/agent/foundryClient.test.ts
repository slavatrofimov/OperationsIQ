import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the delegated-token acquisition (browser MSAL) and the tool registry so
// the response/tool-call loop can be driven purely by a stubbed fetch.
vi.mock('../msal', () => ({
  getFabricApiToken: vi.fn(async () => 'fake-token'),
}));

const dispatchTool = vi.fn();
vi.mock('./registry', () => ({
  dispatchTool: (...args: unknown[]) => dispatchTool(...args),
  toolDefinitions: () => [],
}));

import { runAgentTurn, runToolCall, createConversation } from './foundryClient';
import { getFabricApiToken } from '../msal';
import { createTelemetryCollector, type TurnTelemetry } from './telemetry';
import type { ToolContext } from './types';

interface ResponseObject {
  id?: string;
  status: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
  output?: unknown[];
  output_text?: string;
}

/** A `function_call` output item the model emits to request a tool. */
function fnCall(name: string, args: string, callId = 'call1', id = 'fc1') {
  return { type: 'function_call', id, call_id: callId, name, arguments: args };
}

/** An assistant `message` output item carrying text. */
function asstMsg(text: string) {
  return { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
}

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
}

/** A failed HTTP response with no JSON body (used to drive the 401 recovery). */
function httpError(status: number, detail = 'denied') {
  return { ok: false, status, json: async () => ({}), text: async () => detail } as unknown as Response;
}

/**
 * Build a fetch stub that serves Responses API objects from a queue. Both the
 * POST /responses create and any GET /responses/{id} poll shift the queue.
 */
function stubFetch(responses: ResponseObject[]) {
  const queue = [...responses];
  const calls: { url: string; method: string }[] = [];
  const fn = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    if (url.includes('/conversations')) return json({ id: 'conv1' });
    // Any response-producing endpoint (create or poll) shifts the queue.
    return json({ id: 'resp1', ...(queue.shift() ?? { status: 'completed' }) });
  });
  return { fn, calls };
}

const ctx: ToolContext = { tags: [] };

beforeEach(() => {
  dispatchTool.mockReset();
  vi.mocked(getFabricApiToken).mockReset();
  vi.mocked(getFabricApiToken).mockResolvedValue('fake-token');
});

describe('runAgentTurn', () => {
  it('executes a requested tool call then returns the assistant text', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([
      { status: 'completed', output: [fnCall('resolve_tags', '{"query":"x"}')] },
      { status: 'completed', output: [asstMsg('Here is the **finding**.')] },
    ]);
    vi.stubGlobal('fetch', fn);

    const text = await runAgentTurn('conv1', 'hello', ctx);
    // dispatchTool receives a per-tool child context: same tags, plus a child
    // AbortSignal used for the per-tool timeout/cancellation.
    const [name, args, passedCtx] = dispatchTool.mock.calls[0] as [string, string, ToolContext];
    expect(name).toBe('resolve_tags');
    expect(args).toBe('{"query":"x"}');
    expect(passedCtx.tags).toBe(ctx.tags);
    expect(passedCtx.signal).toBeInstanceOf(AbortSignal);
    expect(text).toBe('Here is the **finding**.');
    vi.unstubAllGlobals();
  });

  it('sends agent_reference and no request-level tools on the create response', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([{ status: 'completed', output: [asstMsg('ok')] }]);
    const bodies: Record<string, unknown>[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    await runAgentTurn('conv1', 'hi', ctx);
    // The create POST /responses references the persisted agent and must NOT
    // carry a request-level `tools` array (the deprecated `agent` key + `tools`
    // combination is rejected by the Responses API).
    const create = bodies[0];
    expect(create.agent_reference).toMatchObject({ type: 'agent_reference' });
    expect(create).not.toHaveProperty('agent');
    expect(create).not.toHaveProperty('tools');
    vi.unstubAllGlobals();
  });

  it('prepends an APP CONTROL mode hint before the user message when app control is on', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([{ status: 'completed', output: [asstMsg('ok')] }]);
    const bodies: { input?: unknown[] }[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    await runAgentTurn('conv1', 'help me forecast', ctx, undefined, undefined, {
      appControl: true,
      actions: false,
    });
    const input = bodies[0].input as { role: string; content: { text: string }[] }[];
    // First item is the mode hint; the user's message follows it.
    expect(input).toHaveLength(2);
    const hint = input[0].content[0].text;
    expect(hint).toContain('Session mode for this turn');
    expect(hint).toContain('APP CONTROL is ENABLED');
    expect(hint).not.toContain('ACTIONS are ENABLED');
    expect(input[1].content[0].text).toBe('help me forecast');
    vi.unstubAllGlobals();
  });

  it('includes the ACTIONS hint when only actions are enabled', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([{ status: 'completed', output: [asstMsg('ok')] }]);
    const bodies: { input?: unknown[] }[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    await runAgentTurn('conv1', 'hi', ctx, undefined, undefined, {
      appControl: false,
      actions: true,
    });
    const input = bodies[0].input as { content: { text: string }[] }[];
    expect(input).toHaveLength(2);
    const hint = input[0].content[0].text;
    expect(hint).toContain('ACTIONS are ENABLED');
    expect(hint).not.toContain('APP CONTROL is ENABLED');
    vi.unstubAllGlobals();
  });

  it('adds no mode hint when neither grant is active (read-only default)', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([{ status: 'completed', output: [asstMsg('ok')] }]);
    const bodies: { input?: unknown[] }[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    // Both explicitly-off mode and an absent mode arg must leave the input as a
    // single user message, so ordinary Q&A turns are unchanged.
    await runAgentTurn('conv1', 'hi', ctx, undefined, undefined, {
      appControl: false,
      actions: false,
    });
    await runAgentTurn('conv1', 'hi again', ctx);
    for (const body of bodies) {
      const input = body.input as { content: { text: string }[] }[];
      expect(input).toHaveLength(1);
      expect(input[0].content[0].text).not.toContain('Session mode for this turn');
    }
    vi.unstubAllGlobals();
  });

  it('prepends a first-turn orientation briefing only when firstTurn is set', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([
      { status: 'completed', output: [asstMsg('ok')] },
      { status: 'completed', output: [asstMsg('ok2')] },
    ]);
    const bodies: { input?: { content: { text: string }[] }[] }[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    const orientedCtx: ToolContext = {
      tags: [{ tagId: 't1', tagName: 'Boiler Temp', metric: 'Temperature', description: '', engUnits: 'C', level1: 'Plant A' }],
      profile: { name: 'North Plant', description: 'Boiler house' },
    };

    // First turn: orientation is the leading input item.
    await runAgentTurn('conv1', 'hi', orientedCtx, undefined, undefined, undefined, { firstTurn: true });
    const firstInput = bodies[0].input!;
    expect(firstInput).toHaveLength(2);
    expect(firstInput[0].content[0].text).toContain('Environment orientation');
    expect(firstInput[0].content[0].text).toContain('North Plant');
    expect(firstInput[1].content[0].text).toBe('hi');

    // Subsequent turn (no firstTurn): no orientation, just the user message.
    await runAgentTurn('conv1', 'again', orientedCtx);
    const secondInput = bodies[1].input!;
    expect(secondInput).toHaveLength(1);
    expect(secondInput[0].content[0].text).toBe('again');
    vi.unstubAllGlobals();
  });

  it('feeds tool outputs back as function_call_output on the follow-up response', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([
      { status: 'completed', output: [fnCall('resolve_tags', '{}', 'call-42')] },
      { status: 'completed', output: [asstMsg('done')] },
    ]);
    const bodies: unknown[] = [];
    const wrapped = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.body) bodies.push(JSON.parse(init.body));
      return fn(url, init);
    });
    vi.stubGlobal('fetch', wrapped);

    await runAgentTurn('conv1', 'hi', ctx);
    // The second POST /responses carries the tool result keyed by call_id.
    const followUp = bodies[1] as { conversation: string; input: unknown[] };
    expect(followUp.conversation).toBe('conv1');
    expect(followUp.input[0]).toMatchObject({ type: 'function_call_output', call_id: 'call-42' });
    vi.unstubAllGlobals();
  });

  it('loops through multiple tool-call rounds before finishing', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([
      { status: 'completed', output: [fnCall('resolve_tags', '{}', 'c1', 'f1')] },
      { status: 'completed', output: [fnCall('forecast', '{}', 'c2', 'f2')] },
      { status: 'completed', output: [asstMsg('final answer')] },
    ]);
    vi.stubGlobal('fetch', fn);

    const text = await runAgentTurn('conv1', 'hi', ctx);
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(text).toBe('final answer');
    vi.unstubAllGlobals();
  });

  it('throws when the response ends in a failed state', async () => {
    const { fn } = stubFetch([{ status: 'failed', error: { message: 'boom' } }]);
    vi.stubGlobal('fetch', fn);
    await expect(runAgentTurn('conv1', 'hi', ctx)).rejects.toThrow(/failed.*boom/);
    vi.unstubAllGlobals();
  });

  it('aborts when the signal is already aborted', async () => {
    const { fn } = stubFetch([{ status: 'completed', output: [asstMsg('x')] }]);
    vi.stubGlobal('fetch', fn);
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgentTurn('conv1', 'hi', { ...ctx, signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    vi.unstubAllGlobals();
  });

  it('aborts while polling a background (in_progress) response', async () => {
    // Response stays in_progress so execution parks in the poll-loop sleep; we
    // then abort mid-wait and assert the turn rejects with an abort error.
    const { fn } = stubFetch([{ status: 'in_progress' }, { status: 'in_progress' }]);
    vi.stubGlobal('fetch', fn);
    const controller = new AbortController();
    const p = runAgentTurn('conv1', 'hi', { ...ctx, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10)); // let it reach abortableDelay
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
    vi.unstubAllGlobals();
  });

  it('returns partial text plus a friendly note when the response is incomplete', async () => {
    const { fn } = stubFetch([
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [asstMsg('Here is the **finding**.')],
      },
    ]);
    vi.stubGlobal('fetch', fn);
    const text = await runAgentTurn('conv1', 'hi', ctx);
    expect(text).toContain('Here is the **finding**.');
    expect(text).toMatch(/incomplete/i);
    vi.unstubAllGlobals();
  });

  it('reports token usage and tool calls via onTelemetry', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const { fn } = stubFetch([
      { status: 'completed', output: [fnCall('resolve_tags', '{}')] },
      {
        status: 'completed',
        output: [asstMsg('done')],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    ]);
    vi.stubGlobal('fetch', fn);
    let telemetry: TurnTelemetry | undefined;
    await runAgentTurn('conv1', 'hi', ctx, { onTelemetry: (t) => (telemetry = t) });
    expect(telemetry?.toolCalls).toHaveLength(1);
    expect(telemetry?.toolCalls[0]).toMatchObject({ name: 'resolve_tags', ok: true });
    expect(telemetry?.usage.totalTokens).toBe(15);
    expect(telemetry?.runStatuses).toContain('completed');
    vi.unstubAllGlobals();
  });
});

describe('runToolCall (per-tool timeout)', () => {
  const call = { id: 'c1', type: 'function', function: { name: 'forecast', arguments: '{}' } };

  it('resolves and records telemetry for a fast tool', async () => {
    dispatchTool.mockResolvedValue({ ok: true, summary: 'done' });
    const collector = createTelemetryCollector();
    const result = await runToolCall(call, ctx, collector, 1000);
    expect(result.ok).toBe(true);
    expect(collector.snapshot().toolCalls[0]).toMatchObject({ name: 'forecast', ok: true, timedOut: false });
  });

  it('times out a hung tool and returns an ok:false timeout result', async () => {
    dispatchTool.mockImplementation(() => new Promise(() => undefined));
    const collector = createTelemetryCollector();
    const result = await runToolCall(call, ctx, collector, 5);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('timeout');
    expect(collector.snapshot().toolCalls[0]).toMatchObject({ name: 'forecast', ok: false, timedOut: true });
  });

  it('aborts the tool child signal on timeout so the query is cancelled', async () => {
    let captured: ToolContext | undefined;
    dispatchTool.mockImplementation((_n: string, _a: string, c: ToolContext) => {
      captured = c;
      return new Promise(() => undefined);
    });
    const collector = createTelemetryCollector();
    await runToolCall(call, ctx, collector, 5);
    expect(captured?.signal?.aborted).toBe(true);
  });
});

describe('foundryFetch stale-token (401) recovery', () => {
  it('force-refreshes the token and retries once on a 401, then succeeds', async () => {
    // First data-plane call is rejected with a stale token; after the refresh
    // the retry succeeds. Mirrors the "works after reopening the browser"
    // symptom where sessionStorage served an expired access token.
    vi.mocked(getFabricApiToken)
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(401))
      .mockResolvedValueOnce(json({ id: 'conv1' }));
    vi.stubGlobal('fetch', fetchMock);

    const id = await createConversation();
    expect(id).toBe('conv1');

    // Token acquired twice: initial (stale) + one forced refresh.
    expect(getFabricApiToken).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getFabricApiToken).mock.calls[1][0]).toMatchObject({ forceRefresh: true });
    // Request retried with the fresh token in the Authorization header.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer fresh-token');
    vi.unstubAllGlobals();
  });

  it('refreshes at most once — a second 401 surfaces as the terminal error', async () => {
    vi.mocked(getFabricApiToken).mockResolvedValue('any-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpError(401))
      .mockResolvedValueOnce(httpError(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createConversation()).rejects.toThrow(/401/);
    // Initial acquisition + exactly one forced-refresh attempt (no infinite loop).
    expect(getFabricApiToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('reports the 401 when the forced refresh itself cannot get a token', async () => {
    vi.mocked(getFabricApiToken)
      .mockResolvedValueOnce('stale-token')
      .mockRejectedValueOnce(new Error('interaction_required'));
    const fetchMock = vi.fn().mockResolvedValueOnce(httpError(401, 'nope'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createConversation()).rejects.toThrow(/401.*nope/);
    expect(getFabricApiToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
