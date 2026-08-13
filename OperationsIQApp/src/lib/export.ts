/**
 * Client-side export helpers: turn already-fetched data into downloadable CSV
 * files, and save chart snapshots as PNG. Everything runs in the browser from
 * data the app already holds, so no extra Eventhouse queries are issued.
 */
import type { KustoTable } from './eventhouse';
import type { ExploreSeries } from './series';

/** Trigger a browser download for an in-memory Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download UTF-8 text as a file (BOM-prefixed so Excel opens CSV correctly). */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  downloadBlob(filename, new Blob(['\ufeff', text], { type: mime }));
}

/** Trigger a download for a data URL (e.g. an ECharts PNG). */
export function downloadDataUrl(filename: string, dataUrl: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Escape a single CSV field per RFC 4180 (quote when it contains , " or newline). */
function csvField(value: unknown): string {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join rows of already-stringified-or-primitive cells into a CSV document. */
function toCsvDocument(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return lines.join('\r\n');
}

/**
 * The single tabular shape that powers BOTH the "view as table" grid and CSV
 * export for any chart. Charts extract their plotted data into this model once;
 * `chartDataToCsv` and the DataTable component both consume it, so the table
 * and the download always reflect exactly what the chart shows.
 */
export interface ChartData {
  columns: string[];
  rows: (string | number | null)[][];
}

/** Serialize a ChartData model to CSV text (RFC 4180, Excel-friendly). */
export function chartDataToCsv(data: ChartData): string {
  if (data.columns.length === 0 && data.rows.length === 0) return '';
  return toCsvDocument(data.columns, data.rows);
}

/**
 * Convert any Kusto result table (columns + row tuples) into ChartData,
 * optionally dropping columns that hold large dynamic arrays (e.g. raw series).
 */
export function kustoTableToChartData(table: KustoTable, hideColumns: string[] = []): ChartData {
  const visible = table.columns
    .map((c, i) => ({ name: c.name, i }))
    .filter(({ name }) => !hideColumns.includes(name));
  return {
    columns: visible.map((c) => c.name),
    rows: table.rows.map((row) => visible.map(({ i }) => row[i] as string | number | null)),
  };
}

/**
 * Convert Explore detail series into a wide ChartData: one Timestamp (ISO)
 * column plus one value column per series. Series are assumed to share the same
 * time axis (same make-series step); the longest `x` array defines the rows.
 */
export function exploreSeriesToChartData(
  series: ExploreSeries[],
  nameById: Map<string, string>,
): ChartData {
  if (series.length === 0) return { columns: [], rows: [] };
  const base = series.reduce((a, b) => (b.x.length > a.x.length ? b : a), series[0]);
  return {
    columns: ['Timestamp', ...series.map((s) => nameById.get(s.tagId) ?? s.tagId)],
    rows: base.x.map((t, i) => [
      new Date(t * 1000).toISOString(),
      ...series.map((s) => s.values[i] ?? null),
    ]),
  };
}

/** Serialize any Kusto result table (columns + row tuples) to CSV text. */
export function kustoTableToCsv(table: KustoTable): string {
  return chartDataToCsv(kustoTableToChartData(table));
}

/**
 * Serialize Explore detail series to a wide CSV: one Timestamp (ISO) column
 * plus one value column per series.
 */
export function exploreSeriesToCsv(
  series: ExploreSeries[],
  nameById: Map<string, string>,
): string {
  return chartDataToCsv(exploreSeriesToChartData(series, nameById));
}

/** A filesystem-safe timestamp slug for default download filenames. */
export function fileStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}
