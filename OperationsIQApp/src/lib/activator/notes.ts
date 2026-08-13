/**
 * Builder for the human-readable Notes (optionalMessage) embedded in a generated
 * Activator alert's email. The Notes explain how the alert works, invite the
 * user back into Operations IQ to keep troubleshooting, and list every parameter
 * needed to reproduce the underlying similarity search.
 *
 * Pure string builder: the UI prefills the editable Notes field with this text,
 * and whatever the user ends up with is embedded verbatim into the Reflex
 * definition (see reflexDefinition.ts).
 */

/** SAX + binning settings, reproduced so the search can be recreated in-app. */
export interface ActivatorNotesSax {
  queryLengthSymbols: number;
  alphabetSize: number;
  minScale: number;
  maxScale: number;
  scaleSteps: number;
  symbolTolerance: number;
  topK: number;
  znormThreshold: number;
  /** Multidimensional-only settings (omitted for single-dimensional). */
  maxInterTrackDelay?: number;
  perTrackTopK?: number;
}

export interface ActivatorNotesInput {
  mode: 'single' | 'multidim';
  /** Connection profile NAME (not id), so the reader knows which data source. */
  connectionProfileName: string;
  /** Tag id(s) scanned as the live search space. */
  searchTags: string[];
  /** Tag id(s) whose reviewed shape forms the query pattern. */
  queryTags: string[];
  /** Human-readable granularity (e.g. "5 minutes"). */
  binLabel: string;
  /** Human-readable run frequency (e.g. "Every 15 minutes"). */
  frequencyLabel: string;
  /** Incremental lookback per run, in seconds. */
  lookbackSeconds: number;
  /** Minimum similarity score (0..1) a match must reach to fire the alert. */
  minSimilarity: number;
  /** Deep link back into the Operations IQ app. */
  appUrl: string;
  sax: ActivatorNotesSax;
}

function fmtList(ids: string[]): string {
  return ids.length ? ids.join(', ') : '(none)';
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return String(Number(n.toPrecision(6)));
}

/**
 * Compose the Notes text: a one-line method description, a one-sentence
 * invitation back into Operations IQ (with the app URL), and a full,
 * reproducible parameter list (profile name, tags, binning, and all SAX
 * settings). Times are UTC — the alert uses only relative ago()/now() bounds.
 */
export function buildActivatorNotes(input: ActivatorNotesInput): string {
  const { sax } = input;
  const method =
    input.mode === 'single'
      ? 'This alert re-runs a SAX shape-similarity search on the live data on a fixed schedule and emails you whenever a new subsequence matching the reviewed query pattern is found.'
      : 'This alert re-runs a multidimensional SAX shape-similarity search on the live data on a fixed schedule and emails you whenever the reviewed multi-signal query pattern recurs.';

  const invitation = `Continue troubleshooting in Operations IQ: ${input.appUrl}`;

  const lines: string[] = [
    method,
    '',
    invitation,
    '',
    'Search parameters (all times are UTC):',
    `- Connection profile: ${input.connectionProfileName}`,
    `- Query signal(s): ${fmtList(input.queryTags)}`,
    `- Searched signal(s): ${fmtList(input.searchTags)}`,
    `- Granularity (bin): ${input.binLabel}`,
    `- Run frequency: ${input.frequencyLabel}`,
    `- Incremental lookback: ${input.lookbackSeconds} seconds`,
    `- Query length (symbols): ${sax.queryLengthSymbols}`,
    `- Alphabet size: ${sax.alphabetSize}`,
    `- Scale range: ${fmtNum(sax.minScale)}x to ${fmtNum(sax.maxScale)}x over ${sax.scaleSteps} step(s)`,
    `- Symbol tolerance: ${sax.symbolTolerance}`,
    `- Top K: ${sax.topK}`,
    `- Minimum similarity (score ≥): ${input.minSimilarity.toFixed(2)}`,
    `- Z-norm threshold: ${fmtNum(sax.znormThreshold)}`,
  ];

  if (input.mode === 'multidim') {
    lines.push(`- Max inter-track delay: ${sax.maxInterTrackDelay ?? 0}`);
    lines.push(`- Per-track Top K: ${sax.perTrackTopK ?? 0}`);
  }

  return lines.join('\n');
}

export interface ActivatorAnomalyNotesInput {
  connectionProfileName: string;
  /** Signals analysed together as one entity's tracks. */
  tags: string[];
  /** Human label for the detector, e.g. 'Residual magnitude voting'. */
  algorithmLabel: string;
  /** Human-readable granularity, e.g. '15 minutes'. */
  binLabel: string;
  /** Human-readable detection window, e.g. '4 hours (16 bins)'. */
  detectionWindowLabel: string;
  /** Human-readable run frequency, e.g. 'Every 15 minutes'. */
  frequencyLabel: string;
  /** Incremental lookback per run, in seconds. */
  lookbackSeconds: number;
  /** Minimum severity gate (ratio; 1 = every detected anomaly). Omitted/1 hides the line. */
  minSeverity?: number;
  /** Deep link back into the Operations IQ app. */
  appUrl: string;
  /** Non-default detector parameter overrides, as prebuilt 'Label: value' strings. */
  paramLines?: string[];
}

/**
 * Compose the Notes text for an MVAD anomaly Activator alert: a one-line method
 * description, a one-sentence invitation back into Operations IQ (with the app
 * URL), and a full, reproducible parameter list (profile, signals, algorithm,
 * binning, detection window, frequency, lookback, and any non-default detector
 * overrides). Times are UTC — the alert uses only relative now() bounds.
 */
export function buildActivatorAnomalyNotes(input: ActivatorAnomalyNotesInput): string {
  const method = `This alert re-runs a multivariate anomaly-detection scan (${input.algorithmLabel}) on the live data on a fixed schedule and emails you whenever a new anomaly is detected across the selected signals.`;

  const invitation = `Continue troubleshooting in Operations IQ: ${input.appUrl}`;

  const lines: string[] = [
    method,
    '',
    invitation,
    '',
    'Detection parameters (all times are UTC):',
    `- Connection profile: ${input.connectionProfileName}`,
    `- Signals: ${fmtList(input.tags)}`,
    `- Algorithm: ${input.algorithmLabel}`,
    `- Granularity (bin): ${input.binLabel}`,
    `- Detection window: ${input.detectionWindowLabel}`,
    `- Run frequency: ${input.frequencyLabel}`,
    `- Incremental lookback: ${input.lookbackSeconds} seconds`,
  ];

  if (input.minSeverity != null && input.minSeverity > 1) {
    lines.push(
      `- Minimum severity to alert: ${input.minSeverity}× the detection threshold`,
    );
  }

  if (input.paramLines && input.paramLines.length > 0) {
    for (const line of input.paramLines) {
      lines.push(`- ${line}`);
    }
  }

  return lines.join('\n');
}

export interface ActivatorSaxNotesInput {
  connectionProfileName: string;
  /** Signals scanned independently for discords. */
  tags: string[];
  /** Human-readable granularity, e.g. '15 minutes'. */
  binLabel: string;
  /** Human-readable detection window, e.g. '4 hours (16 bins)'. */
  detectionWindowLabel: string;
  /** Human-readable run frequency, e.g. 'Every 15 minutes'. */
  frequencyLabel: string;
  /** Incremental lookback per run, in seconds. */
  lookbackSeconds: number;
  /** Frozen nearest-neighbor distance threshold that fires the alert. */
  distanceThreshold: number;
  /** Deep link back into the Operations IQ app. */
  appUrl: string;
  /** SAX parameter lines, as prebuilt 'Label: value' strings. */
  paramLines?: string[];
}

/**
 * Compose the Notes text for a SAX-discord anomaly Activator alert: a one-line
 * method description, an invitation back into Operations IQ, and a full,
 * reproducible parameter list (profile, signals, binning, detection window,
 * frequency, lookback, the frozen distance threshold, and the SAX settings).
 * Times are UTC — the alert uses only relative now() bounds. The distance
 * threshold is frozen; re-calibrate manually by re-running "Suggest threshold".
 */
export function buildActivatorSaxNotes(input: ActivatorSaxNotesInput): string {
  const method =
    'This alert re-runs a SAX discord (shape-novelty) scan on the live data on a fixed schedule and emails you whenever a recent window is more unusual — its nearest-neighbor distance to prior history is at or above the frozen threshold — than anything before it.';

  const invitation = `Continue troubleshooting in Operations IQ: ${input.appUrl}`;

  const lines: string[] = [
    method,
    '',
    invitation,
    '',
    'Detection parameters (all times are UTC):',
    `- Connection profile: ${input.connectionProfileName}`,
    `- Signals: ${fmtList(input.tags)}`,
    `- Algorithm: SAX discords`,
    `- Granularity (bin): ${input.binLabel}`,
    `- Detection window: ${input.detectionWindowLabel}`,
    `- Run frequency: ${input.frequencyLabel}`,
    `- Incremental lookback: ${input.lookbackSeconds} seconds`,
    `- Distance threshold (≥): ${fmtNum(input.distanceThreshold)}`,
  ];

  if (input.paramLines && input.paramLines.length > 0) {
    for (const line of input.paramLines) {
      lines.push(`- ${line}`);
    }
  }

  return lines.join('\n');
}
