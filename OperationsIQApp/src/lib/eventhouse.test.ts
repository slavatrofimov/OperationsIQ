import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the delegated-token acquisition and the active-connection fallback so
// executeKql can be exercised against a stubbed fetch.
vi.mock('./msal', () => ({
  getEventhouseToken: vi.fn(async () => 'fake-kusto-token'),
  EventhouseSignInRequiredError: class extends Error {},
  notifyEventhouseSignInRequired: vi.fn(),
}));
vi.mock('./activeConnection', () => ({
  getActiveKqlOpts: () => undefined,
}));
vi.mock('./env', () => ({
  env: { eventhouseQueryUri: 'https://cluster.example', eventhouseDb: 'db' },
}));

import { executeKql } from './eventhouse';

/** Minimal Kusto v2 response with one PrimaryResult row. */
const V2_FRAMES = [
  {
    FrameType: 'DataTable',
    TableKind: 'PrimaryResult',
    TableName: 'PrimaryResult',
    Columns: [{ ColumnName: 'x', ColumnType: 'long' }],
    Rows: [[1]],
  },
  { FrameType: 'DataSetCompletion', HasErrors: false, Cancelled: false },
];

let lastInit: RequestInit | undefined;

beforeEach(() => {
  lastInit = undefined;
});

describe('executeKql signal passthrough', () => {
  it('forwards exec.signal into the underlying fetch', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      lastInit = init;
      return { ok: true, status: 200, json: async () => V2_FRAMES, text: async () => '' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);

    const table = await executeKql('T | take 1', { queryUri: 'https://c', db: 'd' }, { signal: controller.signal });
    expect(table.rows).toEqual([[1]]);
    expect(lastInit?.signal).toBe(controller.signal);
    vi.unstubAllGlobals();
  });

  it('remains back-compatible when no exec is passed (signal undefined)', async () => {
    const fn = vi.fn(async (_url: string, init?: RequestInit) => {
      lastInit = init;
      return { ok: true, status: 200, json: async () => V2_FRAMES, text: async () => '' } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);

    await executeKql('T | take 1', { queryUri: 'https://c', db: 'd' });
    expect(lastInit?.signal).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('rejects KQL management commands without calling the management endpoint', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);

    await expect(executeKql('.show databases')).rejects.toThrow(
      'KQL management commands are not supported',
    );
    expect(fn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
