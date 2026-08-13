import { describe, it, expect } from 'vitest';
import {
  buildActivatorSimilarityKql,
  buildActivatorSimilarityKqlMultidim,
  buildActivatorAnomalyKql,
  buildActivatorSaxDiscordKql,
  buildSaxDiscordThresholdQuery,
  saxAnomalyHistoryBins,
  mvadAnomalyHistoryBins,
  summarizeSubjectTags,
  ACTIVATOR_COLUMNS,
  ANOMALY_ACTIVATOR_COLUMNS,
  SAX_ANOMALY_ACTIVATOR_COLUMNS,
} from './kql';

const BASE = {
  timeseriesRef: 'Timeseries | project Timestamp, SignalId=TagId, Value',
  binKql: '5m',
  binSeconds: 300,
  frequencySeconds: 900,
  queryLengthSymbols: 8,
  alphabetSize: 5,
  minScale: 1,
  maxScale: 1.5,
  scaleSteps: 3,
  symbolTolerance: 0,
  topK: 10,
  znormThreshold: 0.01,
};

describe('summarizeSubjectTags', () => {
  it('returns the single tag id verbatim', () => {
    expect(summarizeSubjectTags(['vibration-01'])).toBe('vibration-01');
  });
  it('summarizes multiple tags as "first + N more signals"', () => {
    expect(summarizeSubjectTags(['vibration-01', 'a', 'b', 'c'])).toBe(
      'vibration-01 + 3 more signals',
    );
  });
  it('uses the singular for exactly one extra signal', () => {
    expect(summarizeSubjectTags(['vibration-01', 'a'])).toBe('vibration-01 + 1 more signal');
  });
  it('ignores empty ids', () => {
    expect(summarizeSubjectTags(['', 'x'])).toBe('x');
    expect(summarizeSubjectTags([])).toBe('');
  });
});

describe('buildActivatorSimilarityKql (single-dim)', () => {
  const result = buildActivatorSimilarityKql({
    ...BASE,
    queryValues: [1, 2, 3, 4],
    searchTagIds: ['tag-a', 'tag-b'],
  });

  it('inlines the query pattern as a datatable', () => {
    expect(result.queryString).toContain(
      "let Query = datatable(query_id:string, series:dynamic) [",
    );
    expect(result.queryString).toContain('dynamic([1, 2, 3, 4])');
  });

  it('keeps the search space live via app_search_space over ago()/now()', () => {
    expect(result.queryString).toContain(
      "let SearchSpace = app_search_space(Timeseries, dynamic(['tag-a', 'tag-b']), _t0, now(), _bin);",
    );
    expect(result.queryString).toContain('let _t0 = ago(_lookback);');
  });

  it('inherits the bin exactly', () => {
    expect(result.queryString).toContain('let _bin = 5m;');
  });

  it('uses only relative UTC bounds (no datetime literals or offset shifting)', () => {
    expect(result.queryString).not.toContain('datetime(');
    expect(result.queryString).not.toContain('datetime_add');
  });

  it('computes the incremental lookback = frequency + (queryBins - 1) * bin', () => {
    // 900 + (4 - 1) * 300 = 1800
    expect(result.lookbackSeconds).toBe(1800);
    expect(result.queryString).toContain('let _lookback = 1800s;');
  });

  it('emits the subject and context columns', () => {
    expect(result.subjectField).toBe(ACTIVATOR_COLUMNS.subjectTags);
    expect(result.queryString).toContain(`${ACTIVATOR_COLUMNS.subjectTags} = series_id`);
    expect(result.queryString).toContain(`${ACTIVATOR_COLUMNS.matchStart} = _t0 + start_index * _bin`);
    expect(result.contextFields).toContain(ACTIVATOR_COLUMNS.tagId);
    expect(result.contextFields).toContain(ACTIVATOR_COLUMNS.similarity);
  });

  it('calls the 1-D similarity function with the SAX params', () => {
    expect(result.queryString).toContain(
      'sax_similarity_search_1d(Query, SearchSpace, 8, 5, 1, 1.5, 3, 0, 10, 0.01)',
    );
  });

  it('appends a minimum-similarity filter only when a positive threshold is given', () => {
    const filtered = buildActivatorSimilarityKql({
      ...BASE,
      queryValues: [1, 2, 3, 4],
      searchTagIds: ['tag-a', 'tag-b'],
      minSimilarity: 0.5,
    });
    expect(filtered.queryString).toContain('| where Similarity >= 0.5');

    // Omitted threshold → no filter clause.
    expect(result.queryString).not.toContain('where Similarity >=');
    // Explicit zero threshold → no filter clause.
    const zero = buildActivatorSimilarityKql({
      ...BASE,
      queryValues: [1, 2, 3, 4],
      searchTagIds: ['tag-a', 'tag-b'],
      minSimilarity: 0,
    });
    expect(zero.queryString).not.toContain('where Similarity >=');
  });

  it('binds a non-canonical timeseries source', () => {
    const r = buildActivatorSimilarityKql({
      ...BASE,
      timeseriesRef: 'RawTs | project Timestamp, SignalId, Value',
      queryValues: [1, 2],
      searchTagIds: ['t'],
    });
    expect(r.queryString).toContain('let Timeseries = (\nRawTs | project Timestamp, SignalId, Value\n);');
  });
});

describe('buildActivatorSimilarityKqlMultidim', () => {
  const result = buildActivatorSimilarityKqlMultidim({
    ...BASE,
    tracks: [
      { trackId: 't0', searchTagId: 'vibration-01', values: [1, 2, 3, 4, 5] },
      { trackId: 't1', searchTagId: 'temp-01', values: [5, 4, 3] },
    ],
    maxInterTrackDelay: 2,
    perTrackTopK: 4,
  });

  it('inlines per-track query datatable rows', () => {
    expect(result.queryString).toContain(
      'let QueryTracks = datatable(query_id:string, track_id:string, series:dynamic) [',
    );
    expect(result.queryString).toContain("'query', 't0', dynamic([1, 2, 3, 4, 5])");
    expect(result.queryString).toContain("'query', 't1', dynamic([5, 4, 3])");
  });

  it('remaps live search tags onto synthetic track ids', () => {
    expect(result.queryString).toContain('let TrackMap = datatable(series_id:string, track_id:string) [');
    expect(result.queryString).toContain(
      "app_search_space(Timeseries, dynamic(['vibration-01', 'temp-01']), _t0, now(), _bin)",
    );
    expect(result.queryString).toContain('| join kind=inner TrackMap on series_id');
  });

  it('summarizes the searched tags in the subject column', () => {
    expect(result.queryString).toContain(
      `${ACTIVATOR_COLUMNS.subjectTags} = 'vibration-01 + 1 more signal'`,
    );
  });

  it('uses the longest track for the lookback math', () => {
    // 900 + (5 - 1) * 300 = 2100
    expect(result.lookbackSeconds).toBe(2100);
    expect(result.queryString).toContain('let _lookback = 2100s;');
  });

  it('calls the multidim function with per-track params', () => {
    expect(result.queryString).toContain(
      'sax_similarity_search_multidim(QueryTracks, SearchTracks, 8, 5, 1, 1.5, 3, 0, 2, 4, 10, 0.01)',
    );
  });

  it('appends a minimum-similarity filter only when a positive threshold is given', () => {
    const filtered = buildActivatorSimilarityKqlMultidim({
      ...BASE,
      tracks: [
        { trackId: 't0', searchTagId: 'vibration-01', values: [1, 2, 3, 4, 5] },
        { trackId: 't1', searchTagId: 'temp-01', values: [5, 4, 3] },
      ],
      maxInterTrackDelay: 2,
      perTrackTopK: 4,
      minSimilarity: 0.5,
    });
    expect(filtered.queryString).toContain('| where Score >= 0.5');

    // Omitted threshold → no filter clause.
    expect(result.queryString).not.toContain('where Score >=');
  });

  it('uses only relative UTC bounds', () => {
    expect(result.queryString).not.toContain('datetime(');
    expect(result.queryString).not.toContain('datetime_add');
  });
});

describe('mvadAnomalyHistoryBins', () => {
  it('residual_voting: detectionBins + 16 + 4 (season 0 default)', () => {
    expect(mvadAnomalyHistoryBins('residual_voting', 16)).toBe(36);
  });
  it('random_projection: detectionBins + 16 + 4 (season 0 default)', () => {
    expect(mvadAnomalyHistoryBins('random_projection', 10)).toBe(30);
  });
  it('change_point: detectionBins + max(16, 2*cwb+8) + 4 (cwb 8 default => 24)', () => {
    expect(mvadAnomalyHistoryBins('change_point', 10)).toBe(38);
  });
  it('spectral: detectionBins * (baselineWindowCount + 1) + 4 (bwc 8 default)', () => {
    expect(mvadAnomalyHistoryBins('spectral', 32)).toBe(292);
  });
  it('honours seasonality overrides for residual/random_projection', () => {
    // season 96 => minHist = max(16, 2*96=192) = 192; 8 + 192 + 4 = 204
    expect(mvadAnomalyHistoryBins('residual_voting', 8, { seasonality: 96 })).toBe(204);
  });
  it('honours contrastWindowBins override for change_point', () => {
    // cwb 16 => minHist = max(16, 2*16+8=40) = 40; 10 + 40 + 4 = 54
    expect(mvadAnomalyHistoryBins('change_point', 10, { contrastWindowBins: 16 })).toBe(54);
  });
  it('honours baselineWindowCount override for spectral', () => {
    // bwc 12 => 32 * 13 + 4 = 420
    expect(mvadAnomalyHistoryBins('spectral', 32, { baselineWindowCount: 12 })).toBe(420);
  });
});

describe('buildActivatorAnomalyKql', () => {
  it('emits the exact residual_voting CSL (Fixture A)', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'Timeseries',
      algorithm: 'residual_voting',
      tagIds: ['vibration-01', 'vibration-02', 'temperature-01'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 16,
      frequencySeconds: 900,
    });
    const expected = `let _history = 32400s;
let _bin = 15m;
let _dw = 14400s;
let _emit = 1800s;
let _end = now();
let _start = _end - _history;
let Source = Timeseries
    | where Timestamp >= _start and Timestamp < _end
    | where SignalId in ('vibration-01', 'vibration-02', 'temperature-01')
    | project entity_id = 'selection', track_id = SignalId, timestamp = Timestamp, value = Value;
let SeriesTable = mvad_make_series(Source, _start, _end, _bin, 0.95, 3);
mvad_residual_magnitude_voting(SeriesTable, _dw, 0, 'linefit', 'ctukey', 1.5, 1.2, 2, 0.5, 3, false)
| where status == 'ok' and event_time > _end - _emit
| extend SubjectTags = 'vibration-01 + 2 more signals'
| project Entity = entity_id, SubjectTags, Algorithm = algorithm, EventTime = event_time, Score = score, Threshold = threshold, Severity = severity, VoteCount = vote_count, TrackCount = track_count, Contributors = contributors`;
    expect(result.queryString).toBe(expected);
    expect(result.lookbackSeconds).toBe(32400);
    expect(result.subjectField).toBe(ANOMALY_ACTIVATOR_COLUMNS.subjectTags);
    expect(result.contextFields).toEqual([
      ANOMALY_ACTIVATOR_COLUMNS.entity,
      ANOMALY_ACTIVATOR_COLUMNS.algorithm,
      ANOMALY_ACTIVATOR_COLUMNS.eventTime,
      ANOMALY_ACTIVATOR_COLUMNS.score,
      ANOMALY_ACTIVATOR_COLUMNS.threshold,
      ANOMALY_ACTIVATOR_COLUMNS.severity,
      ANOMALY_ACTIVATOR_COLUMNS.voteCount,
      ANOMALY_ACTIVATOR_COLUMNS.trackCount,
      ANOMALY_ACTIVATOR_COLUMNS.contributors,
    ]);
  });

  it('emits the exact spectral CSL (Fixture B)', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'Timeseries',
      algorithm: 'spectral',
      tagIds: ['vibration-01', 'vibration-02', 'temperature-01'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 32,
      frequencySeconds: 3600,
    });
    const expected = `let _history = 262800s;
let _bin = 15m;
let _dw = 28800s;
let _emit = 4500s;
let _end = now();
let _start = _end - _history;
let Source = Timeseries
    | where Timestamp >= _start and Timestamp < _end
    | where SignalId in ('vibration-01', 'vibration-02', 'temperature-01')
    | project entity_id = 'selection', track_id = SignalId, timestamp = Timestamp, value = Value;
let SeriesTable = mvad_make_series(Source, _start, _end, _bin, 0.95, 3);
mvad_spectral_aggregation(SeriesTable, _dw, 8, 3, true, 2, 1.5, 2, 0.5, 4, false)
| where status == 'ok' and event_time > _end - _emit
| extend SubjectTags = 'vibration-01 + 2 more signals'
| project Entity = entity_id, SubjectTags, Algorithm = algorithm, EventTime = event_time, Score = score, Threshold = threshold, Severity = severity, VoteCount = vote_count, TrackCount = track_count, Contributors = contributors`;
    expect(result.queryString).toBe(expected);
    expect(result.lookbackSeconds).toBe(262800);
  });

  it('uses only relative UTC bounds (no datetime literals or offset shifting)', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'Timeseries',
      algorithm: 'residual_voting',
      tagIds: ['a', 'b'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 16,
      frequencySeconds: 900,
    });
    expect(result.queryString).not.toContain('datetime(');
    expect(result.queryString).not.toContain('datetime_add');
    expect(result.queryString).not.toContain('ago(');
  });

  it('binds a non-canonical timeseries source and keeps emit_all_scores false', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'RawTs | project Timestamp, TagId, Value',
      algorithm: 'random_projection',
      tagIds: ['a', 'b'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 10,
      frequencySeconds: 900,
    });
    expect(result.queryString).toContain(
      'let Timeseries = (\nRawTs | project Timestamp, TagId, Value\n);\n',
    );
    // random_projection history: 10 + 16 + 4 = 30 bins => 30 * 900 = 27000
    expect(result.lookbackSeconds).toBe(27000);
    expect(result.queryString).toContain('let _history = 27000s;');
    // detector call must end with ', false)' (emit_all_scores off).
    expect(result.queryString).toContain('mvad_random_projection_ensemble(SeriesTable, _dw,');
    expect(result.queryString).toMatch(/, false\)\n\| where status == 'ok'/);
  });

  it('honours entity, coverage and gap overrides', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'Timeseries',
      algorithm: 'residual_voting',
      tagIds: ['a', 'b'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 16,
      frequencySeconds: 900,
      entityId: 'unit-7',
      minCoverage: 0.8,
      maxGapBins: 5,
    });
    expect(result.queryString).toContain("entity_id = 'unit-7'");
    expect(result.queryString).toContain('mvad_make_series(Source, _start, _end, _bin, 0.8, 5);');
  });

  it('omits the severity gate by default and when minSeverity <= 1', () => {
    const base = {
      timeseriesRef: 'Timeseries',
      algorithm: 'residual_voting' as const,
      tagIds: ['a', 'b'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 16,
      frequencySeconds: 900,
    };
    const defaulted = buildActivatorAnomalyKql(base);
    const atOne = buildActivatorAnomalyKql({ ...base, minSeverity: 1 });
    for (const result of [defaulted, atOne]) {
      expect(result.queryString).not.toContain('_min_severity');
      expect(result.queryString).not.toContain('severity >= _min_severity');
    }
    // byte-identical to the no-arg build
    expect(atOne.queryString).toBe(defaulted.queryString);
  });

  it('emits the severity gate when minSeverity > 1', () => {
    const result = buildActivatorAnomalyKql({
      timeseriesRef: 'Timeseries',
      algorithm: 'residual_voting',
      tagIds: ['a', 'b'],
      binKql: '15m',
      binSeconds: 900,
      detectionBins: 16,
      frequencySeconds: 900,
      minSeverity: 1.5,
    });
    expect(result.queryString).toContain('let _min_severity = 1.5;');
    expect(result.queryString).toContain(
      "| where status == 'ok' and event_time > _end - _emit\n| where severity >= _min_severity",
    );
    // the let sits just before _end
    expect(result.queryString).toContain('let _min_severity = 1.5;\nlet _end = now();');
  });
});

const SAX_BASE = {
  timeseriesRef: 'Timeseries',
  tagIds: ['vibration-01', 'temperature-01'],
  binKql: '15m',
  binSeconds: 900,
  detectionBins: 16,
  windowSize: 16,
  numDiscords: 3,
  paaSize: 4,
  alphabetSize: 5,
  znormThreshold: 0.01,
  candidateLimit: 512,
};

describe('saxAnomalyHistoryBins', () => {
  it('is detectionBins + max(detectionBins*4, 200) (baseline floor wins)', () => {
    // 16 + max(64, 200) = 216
    expect(saxAnomalyHistoryBins(16)).toBe(216);
  });
  it('scales with 5x the detection window once it exceeds the floor', () => {
    // 60 + max(240, 200) = 300
    expect(saxAnomalyHistoryBins(60)).toBe(300);
  });
});

describe('buildActivatorSaxDiscordKql', () => {
  it('emits the exact SAX discord alert CSL', () => {
    const result = buildActivatorSaxDiscordKql({
      ...SAX_BASE,
      frequencySeconds: 900,
      distanceThreshold: 0.3,
    });
    const expected = `let _history = 194400s;
let _bin = 15m;
let _emit = 1800s;
let _threshold = 0.3;
let _end = now();
let _start = _end - _history;
let SeriesTable = app_search_space(Timeseries, dynamic(['vibration-01', 'temperature-01']), _start, _end, _bin);
sax_discords(SeriesTable, 16, 3, 4, 5, 0.01, 512, 16)
| where nn_distance >= _threshold
| extend event_time = _start + end_index * _bin
| where event_time > _end - _emit
| project Entity = series_id, SubjectTags = series_id, Algorithm = 'sax_discords', EventTime = event_time, Distance = nn_distance, Threshold = _threshold, WindowStart = start_index, WindowEnd = end_index, Word = word, Rank = rank`;
    expect(result.queryString).toBe(expected);
    expect(result.lookbackSeconds).toBe(194400);
    expect(result.subjectField).toBe(SAX_ANOMALY_ACTIVATOR_COLUMNS.subjectTags);
    expect(result.contextFields).toEqual([
      SAX_ANOMALY_ACTIVATOR_COLUMNS.entity,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.algorithm,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.eventTime,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.distance,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.threshold,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.windowStart,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.windowEnd,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.word,
      SAX_ANOMALY_ACTIVATOR_COLUMNS.rank,
    ]);
  });

  it('uses only relative UTC bounds (no datetime literals or offset shifting)', () => {
    const result = buildActivatorSaxDiscordKql({
      ...SAX_BASE,
      frequencySeconds: 900,
      distanceThreshold: 0.3,
    });
    expect(result.queryString).not.toContain('datetime(');
    expect(result.queryString).not.toContain('ago(');
  });

  it('binds a non-canonical timeseries source', () => {
    const result = buildActivatorSaxDiscordKql({
      ...SAX_BASE,
      timeseriesRef: 'RawTs | project Timestamp, SignalId = TagId, Value',
      frequencySeconds: 300,
      distanceThreshold: 0.5,
    });
    expect(result.queryString).toContain(
      'let Timeseries = (\nRawTs | project Timestamp, SignalId = TagId, Value\n);\n',
    );
    // emit = frequency (300) + bin (900) = 1200
    expect(result.queryString).toContain('let _emit = 1200s;');
    expect(result.queryString).toContain('let _threshold = 0.5;');
  });
});

describe('buildSaxDiscordThresholdQuery', () => {
  it('emits a whole-range (detection off) baseline query with distance percentiles', () => {
    const csl = buildSaxDiscordThresholdQuery(SAX_BASE);
    const expected = `let _history = 194400s;
let _bin = 15m;
let _end = now();
let _start = _end - _history;
let SeriesTable = app_search_space(Timeseries, dynamic(['vibration-01', 'temperature-01']), _start, _end, _bin);
sax_discords(SeriesTable, 16, 20, 4, 5, 0.01, 512, 0)
| summarize P50 = percentile(nn_distance, 50), P90 = percentile(nn_distance, 90), P95 = percentile(nn_distance, 95), MaxDistance = max(nn_distance), Samples = count()`;
    expect(csl).toBe(expected);
  });

  it('honours a custom sample count and shares the alert history span', () => {
    const csl = buildSaxDiscordThresholdQuery({ ...SAX_BASE, sampleDiscords: 40 });
    // detection off (whole range) => 8th arg 0; sample count in the num_discords slot
    expect(csl).toContain('sax_discords(SeriesTable, 16, 40, 4, 5, 0.01, 512, 0)');
    expect(csl).toContain('let _history = 194400s;');
  });
});
