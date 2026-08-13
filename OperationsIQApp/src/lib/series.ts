/**
 * Reshape Eventhouse (KQL) result tables into chart-ready arrays. The v2 REST
 * response returns dynamic columns as real JSON arrays, so series columns come
 * back as arrays we can map directly onto uPlot's aligned-data format.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/** One tag's binned series with its unsupervised anomaly overlay. */
export interface ExploreSeries {
  tagId: string;
  /** X values as unix seconds. */
  x: number[];
  /** Gap-filled values (null only where the series had no data at all). */
  values: (number | null)[];
  /** Value where an anomaly was flagged, else null (for a points-only overlay). */
  anomalies: (number | null)[];
  /** series_decompose_anomalies baseline (trend+seasonal fit) per bin. */
  baseline: (number | null)[];
}

interface ExploreRow {
  SignalId: string;
  Timestamp: string[];
  Value: (number | null)[];
  AnomalyFlags: number[];
  Baseline?: (number | null)[];
}

/**
 * Parse rows from buildExploreQuery into per-tag series. All tags share the
 * same time axis (same make-series from/to/step), so callers can use the first
 * series' `x` as the shared uPlot x-axis.
 */
export function parseExploreRows(table: KustoTable): ExploreSeries[] {
  return rowsToObjects<ExploreRow>(table).map((o) => {
    const x = (o.Timestamp ?? []).map((t) => new Date(t).getTime() / 1000);
    const values = (o.Value ?? []).map((v) => (v == null ? null : Number(v)));
    const flags = o.AnomalyFlags ?? [];
    const anomalies = values.map((v, i) => (flags[i] ? v : null));
    const baseline = (o.Baseline ?? []).map((v) => (v == null ? null : Number(v)));
    return { tagId: o.SignalId, x, values, anomalies, baseline };
  });
}

/** Qualitative color palette for distinct tag lines. */
export const PALETTE = [
  '#0f6cbd',
  '#107c10',
  '#8764b8',
  '#c19c00',
  '#008272',
  '#a4262c',
  '#5c2e91',
  '#986f0b',
] as const;

/** Color used for anomaly point markers. */
export const ANOMALY_COLOR = '#d13438';
