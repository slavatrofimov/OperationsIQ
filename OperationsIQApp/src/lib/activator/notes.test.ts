import { describe, it, expect } from 'vitest';
import { buildActivatorNotes, buildActivatorAnomalyNotes } from './notes';

const SAX = {
  queryLengthSymbols: 8,
  alphabetSize: 5,
  minScale: 1,
  maxScale: 1.5,
  scaleSteps: 3,
  symbolTolerance: 0,
  topK: 10,
  znormThreshold: 0.01,
};

describe('buildActivatorNotes', () => {
  it('includes the app-URL invitation and a reproducible parameter list', () => {
    const notes = buildActivatorNotes({
      mode: 'single',
      connectionProfileName: 'Contoso Plant',
      searchTags: ['tag-a', 'tag-b'],
      queryTags: ['tag-a'],
      binLabel: '5 minutes',
      frequencyLabel: 'Every 15 minutes',
      lookbackSeconds: 1800,
      minSimilarity: 0.5,
      appUrl: 'https://app.example.com/similarity',
      sax: SAX,
    });
    expect(notes).toContain('https://app.example.com/similarity');
    expect(notes).toContain('Connection profile: Contoso Plant');
    expect(notes).toContain('Searched signal(s): tag-a, tag-b');
    expect(notes).toContain('Granularity (bin): 5 minutes');
    expect(notes).toContain('Run frequency: Every 15 minutes');
    expect(notes).toContain('Incremental lookback: 1800 seconds');
    expect(notes).toContain('Alphabet size: 5');
    expect(notes).toContain('Minimum similarity (score ≥): 0.50');
    expect(notes).toContain('UTC');
    expect(notes).not.toContain('Max inter-track delay');
  });

  it('adds multidimensional settings for a multidim alert', () => {
    const notes = buildActivatorNotes({
      mode: 'multidim',
      connectionProfileName: 'Contoso Plant',
      searchTags: ['a', 'b'],
      queryTags: ['a', 'b'],
      binLabel: '5 minutes',
      frequencyLabel: 'Every 15 minutes',
      lookbackSeconds: 2100,
      minSimilarity: 0.5,
      appUrl: 'https://app.example.com',
      sax: { ...SAX, maxInterTrackDelay: 2, perTrackTopK: 4 },
    });
    expect(notes).toContain('Max inter-track delay: 2');
    expect(notes).toContain('Per-track Top K: 4');
  });
});

describe('buildActivatorAnomalyNotes', () => {
  it('composes the method sentence, invitation, and a reproducible parameter list', () => {
    const notes = buildActivatorAnomalyNotes({
      connectionProfileName: 'Contoso Plant',
      tags: ['vibration-01', 'vibration-02', 'temperature-01'],
      algorithmLabel: 'Residual magnitude voting',
      binLabel: '15 minutes',
      detectionWindowLabel: '4 hours (16 bins)',
      frequencyLabel: 'Every 15 minutes',
      lookbackSeconds: 32400,
      appUrl: 'https://app.example.com/anomaly',
    });
    expect(notes).toContain(
      'This alert re-runs a multivariate anomaly-detection scan (Residual magnitude voting) on the live data on a fixed schedule and emails you whenever a new anomaly is detected across the selected signals.',
    );
    expect(notes).toContain('Continue troubleshooting in Operations IQ: https://app.example.com/anomaly');
    expect(notes).toContain('Detection parameters (all times are UTC):');
    expect(notes).toContain('Connection profile: Contoso Plant');
    expect(notes).toContain('Signals: vibration-01, vibration-02, temperature-01');
    expect(notes).toContain('Algorithm: Residual magnitude voting');
    expect(notes).toContain('Granularity (bin): 15 minutes');
    expect(notes).toContain('Detection window: 4 hours (16 bins)');
    expect(notes).toContain('Run frequency: Every 15 minutes');
    expect(notes).toContain('Incremental lookback: 32400 seconds');
    expect(notes).toContain('UTC');
  });

  it('appends non-default detector parameter overrides when provided', () => {
    const notes = buildActivatorAnomalyNotes({
      connectionProfileName: 'Contoso Plant',
      tags: ['a', 'b'],
      algorithmLabel: 'Spectral aggregation',
      binLabel: '15 minutes',
      detectionWindowLabel: '8 hours (32 bins)',
      frequencyLabel: 'Every hour',
      lookbackSeconds: 262800,
      appUrl: 'https://app.example.com',
      paramLines: ['Baseline window count: 12', 'Track score threshold: 2.5'],
    });
    expect(notes).toContain('- Baseline window count: 12');
    expect(notes).toContain('- Track score threshold: 2.5');
  });

  it('omits override lines when none are provided', () => {
    const notes = buildActivatorAnomalyNotes({
      connectionProfileName: 'Plant',
      tags: ['a', 'b'],
      algorithmLabel: 'Change point ensemble',
      binLabel: '15 minutes',
      detectionWindowLabel: '2.5 hours (10 bins)',
      frequencyLabel: 'Every 15 minutes',
      lookbackSeconds: 30600,
      appUrl: 'https://app.example.com',
    });
    // Last line should be the incremental lookback with nothing appended after.
    const lines = notes.split('\n');
    expect(lines[lines.length - 1]).toBe('- Incremental lookback: 30600 seconds');
  });

  it('adds a minimum-severity line only when minSeverity > 1', () => {
    const base = {
      connectionProfileName: 'Plant',
      tags: ['a', 'b'],
      algorithmLabel: 'Residual magnitude voting',
      binLabel: '15 minutes',
      detectionWindowLabel: '4 hours (16 bins)',
      frequencyLabel: 'Every 15 minutes',
      lookbackSeconds: 32400,
      appUrl: 'https://app.example.com',
    };
    expect(buildActivatorAnomalyNotes(base)).not.toContain('Minimum severity');
    expect(buildActivatorAnomalyNotes({ ...base, minSeverity: 1 })).not.toContain('Minimum severity');
    expect(buildActivatorAnomalyNotes({ ...base, minSeverity: 2.5 })).toContain(
      '- Minimum severity to alert: 2.5× the detection threshold',
    );
  });
});
