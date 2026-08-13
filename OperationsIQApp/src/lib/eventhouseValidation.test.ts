import { describe, it, expect, vi, beforeEach } from 'vitest';

// validateProfileComponents issues read-only `| take 0` probes via queryRows;
// mock it so we can simulate present/missing components.
const { queryRows } = vi.hoisted(() => ({
  queryRows: vi.fn(async (_csl: string, _opts: unknown): Promise<unknown[]> => []),
}));
vi.mock('./eventhouse', () => ({ queryRows }));

import { validateProfileComponents, validateWideTimeseries, type ValidateInput } from './eventhouseValidation';

const baseInput: ValidateInput = {
  queryUri: 'https://eh.example.com/',
  db: 'OperationsIQ',
  profileId: 'profile-xyz',
  hierarchyQuery: 'database("Src").TagHierarchy',
  metadataQuery: 'database("Src").TagMetadata',
  eventsQuery: 'database("Src").Events',
  timeseriesQuery: 'database("Src").Timeseries',
};

describe('validateProfileComponents', () => {
  // Reset call history and restore a default "all present" implementation before
  // each test. (Mixing mockResolvedValue + mockReset + mockImplementation trips a
  // vitest arg-forwarding quirk, so we standardise on mockImplementation.)
  beforeEach(() => {
    queryRows.mockClear();
    queryRows.mockImplementation(async () => []);
  });

  it('reports ok with all checks passing when every probe succeeds', async () => {
    const res = await validateProfileComponents(baseInput);
    expect(res.ok).toBe(true);
    expect(res.checks.every((c) => c.status === 'pass')).toBe(true);
    // The four canonical queries are each probed as required checks.
    expect(res.checks.filter((c) => c.category === 'query')).toHaveLength(4);
  });

  it('prepends the profile-id binding to canonical-query probes', async () => {
    await validateProfileComponents(baseInput);
    const eventsProbe = queryRows.mock.calls
      .map((c) => c[0] as string)
      .find((csl) => csl.includes('database("Src").Events'));
    expect(eventsProbe).toBeDefined();
    expect(eventsProbe!.startsWith("let _ConnectionProfileId = 'profile-xyz';\n")).toBe(true);
    expect(eventsProbe!).toContain('| take 0');
  });

  it('fails (not ok) when a required result table is missing', async () => {
    queryRows.mockImplementation(async (csl: string) => {
      if (csl.startsWith('mp_result')) throw new Error("Table 'mp_result' not found");
      return [];
    });
    const res = await validateProfileComponents(baseInput);
    expect(res.ok).toBe(false);
    const mp = res.checks.find((c) => c.name === 'mp_result');
    expect(mp?.status).toBe('fail');
    expect(mp?.severity).toBe('required');
    expect(mp?.detail).toMatch(/not found/);
  });

  it('does not probe for external tables (annotations/metadata load from the SQL DB)', async () => {
    const res = await validateProfileComponents(baseInput);
    // No check is categorized as an external table anymore.
    expect(res.checks.some((c) => (c.category as string) === 'externalTable')).toBe(false);
    // And no probe is issued against the legacy external-table names.
    const probed = queryRows.mock.calls.map((c) => c[0] as string);
    expect(probed.some((csl) => csl.startsWith('AnnotationsExternal'))).toBe(false);
    expect(probed.some((csl) => csl.startsWith('SignalMetadataExternal'))).toBe(false);
  });

  it('warns (still ok) when only a recommended result table is missing', async () => {
    queryRows.mockImplementation(async (csl: string) => {
      if (csl.startsWith('job_progress')) throw new Error('missing');
      return [];
    });
    const res = await validateProfileComponents(baseInput);
    expect(res.ok).toBe(true);
    expect(res.checks.find((c) => c.name === 'job_progress')?.status).toBe('warn');
  });

  it('strips a trailing slash from the query uri before probing', async () => {
    await validateProfileComponents(baseInput);
    const opts = queryRows.mock.calls[0][1] as { queryUri: string };
    expect(opts.queryUri).toBe('https://eh.example.com');
  });
});

describe('validateWideTimeseries', () => {
  const wideInput = {
    queryUri: 'https://eh.example.com/',
    db: 'OperationsIQ',
    baseQuery: 'WideTimeseries | project SignalIdPrefix, Timestamp, Temp, Press',
    delimiter: '-',
  };

  // Helper: build a getschema-style result set.
  const schema = (cols: Array<[string, string]>) =>
    cols.map(([ColumnName, ColumnType]) => ({ ColumnName, ColumnType }));

  beforeEach(() => {
    queryRows.mockClear();
    queryRows.mockImplementation(async () => []);
  });

  it('passes with the two fixed columns and >= 2 numeric value columns', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['SignalIdPrefix', 'string'],
        ['Timestamp', 'datetime'],
        ['Temp', 'real'],
        ['Press', 'long'],
      ]),
    );
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('pass');
    expect(res.ok).toBe(true);
    expect(res.valueColumns).toEqual(['Temp', 'Press']);
  });

  it('probes with a read-only getschema (never a management command)', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['SignalIdPrefix', 'string'],
        ['Timestamp', 'datetime'],
        ['Temp', 'real'],
        ['Press', 'real'],
      ]),
    );
    await validateWideTimeseries(wideInput);
    const csl = queryRows.mock.calls[0][0] as string;
    expect(csl).toContain('| getschema');
    expect(csl).not.toMatch(/^\s*\./); // no leading-dot management command
  });

  it('fails when SignalIdPrefix is missing', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['Timestamp', 'datetime'],
        ['Temp', 'real'],
        ['Press', 'real'],
      ]),
    );
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('fail');
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/SignalIdPrefix/);
  });

  it('fails when Timestamp has the wrong type', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['SignalIdPrefix', 'string'],
        ['Timestamp', 'string'],
        ['Temp', 'real'],
        ['Press', 'real'],
      ]),
    );
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/Timestamp.*datetime/);
  });

  it('fails when fewer than two numeric value columns are present', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['SignalIdPrefix', 'string'],
        ['Timestamp', 'datetime'],
        ['Temp', 'real'],
        ['Note', 'string'], // non-numeric, ignored
      ]),
    );
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('fail');
    expect(res.valueColumns).toEqual(['Temp']);
    expect(res.detail).toMatch(/At least two/);
  });

  it('warns when the delimiter appears in a value column name', async () => {
    queryRows.mockImplementation(async () =>
      schema([
        ['SignalIdPrefix', 'string'],
        ['Timestamp', 'datetime'],
        ['Flow-Rate', 'real'],
        ['Press', 'real'],
      ]),
    );
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('warn');
    expect(res.ok).toBe(true);
    expect(res.collisions).toContain('Flow-Rate');
  });

  it('fails (with the KQL error) when the probe throws', async () => {
    queryRows.mockImplementation(async () => {
      throw new Error('Semantic error: SomeTable not found');
    });
    const res = await validateWideTimeseries(wideInput);
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(/not found/);
  });

  it('fails fast on an empty base query', async () => {
    const res = await validateWideTimeseries({ ...wideInput, baseQuery: '   ' });
    expect(res.status).toBe('fail');
    expect(queryRows).not.toHaveBeenCalled();
  });
});
