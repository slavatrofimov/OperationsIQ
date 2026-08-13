/**
 * Generic multimodal chart renderers shared by the analysis tools.
 *
 * These mirror `renderForecastChart` (offscreen ECharts → PNG data URL + CSV)
 * but are shape-agnostic so any tool can attach a labelled picture. The model
 * reads *shape* (trend, seasonality, clustering, band flare, matrix structure)
 * far better than raw numbers, while the numeric features stay authoritative.
 *
 * As with the forecast chart, `pngDataUrl` is empty when there is no DOM (tests,
 * SSR); the CSV is always produced so exact values remain reachable.
 */
import * as echarts from 'echarts';
import type { ToolChart } from './types';

/** One plotted line/scatter track over the shared x (unix ms) axis. */
export interface ChartSeriesSpec {
  name: string;
  values: (number | null)[];
  /** 'line' (default) or 'scatter' for point overlays (e.g. anomalies). */
  type?: 'line' | 'scatter';
  dashed?: boolean;
}

/** An optional shaded band (e.g. a prediction / expected envelope). */
export interface ChartBandSpec {
  name: string;
  lower: (number | null)[];
  upper: (number | null)[];
}

export interface SeriesChartOptions {
  title: string;
  /** Shared time axis, unix milliseconds. */
  x: number[];
  series: ChartSeriesSpec[];
  /** Optional shaded band drawn behind the lines. */
  band?: ChartBandSpec;
  /** Optional horizontal reference line (threshold / limit). */
  threshold?: number;
  /** Y-axis label / unit. */
  yName?: string;
}

function csvValue(value: string | number | null): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function pointData(x: number[], values: (number | null)[]) {
  return values.map((v, i) => (v == null ? [x[i], null] : [x[i], v]));
}

function seriesCsv(x: number[], columns: { name: string; values: (number | null)[] }[]): string {
  const header = ['Timestamp', ...columns.map((c) => c.name)];
  const rows = [header.map(csvValue).join(',')];
  for (let i = 0; i < x.length; i++) {
    const row: (string | number | null)[] = [new Date(x[i]).toISOString()];
    for (const c of columns) row.push(c.values[i] ?? null);
    rows.push(row.map(csvValue).join(','));
  }
  return rows.join('\n');
}

/**
 * Multi-line (+ optional scatter overlay + optional shaded band) time chart.
 * Reusable by explore, decomposition, monitor, validation, scenario, compare,
 * control chart, etc.
 */
export function renderSeriesChart(opts: SeriesChartOptions): ToolChart {
  const csvColumns = [
    ...opts.series.map((s) => ({ name: s.name, values: s.values })),
    ...(opts.band
      ? [
          { name: `${opts.band.name} lower`, values: opts.band.lower },
          { name: `${opts.band.name} upper`, values: opts.band.upper },
        ]
      : []),
  ];
  const csv = seriesCsv(opts.x, csvColumns);
  if (typeof document === 'undefined') {
    return { title: opts.title, pngDataUrl: '', csv };
  }

  const div = document.createElement('div');
  div.style.width = '960px';
  div.style.height = '460px';
  div.style.position = 'fixed';
  div.style.left = '-10000px';
  div.style.top = '0';
  document.body.appendChild(div);
  const chart = echarts.init(div);

  const legend = opts.series.map((s) => s.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const series: any[] = [];

  if (opts.band) {
    const interval = opts.band.upper.map((u, i) =>
      u == null || opts.band!.lower[i] == null ? null : u - (opts.band!.lower[i] as number),
    );
    legend.push(opts.band.name);
    series.push(
      {
        name: `${opts.band.name} (lower)`,
        type: 'line',
        stack: 'band',
        showSymbol: false,
        lineStyle: { opacity: 0 },
        emphasis: { disabled: true },
        silent: true,
        data: pointData(opts.x, opts.band.lower),
      },
      {
        name: opts.band.name,
        type: 'line',
        stack: 'band',
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0.15 },
        emphasis: { disabled: true },
        silent: true,
        data: pointData(opts.x, interval),
      },
    );
  }

  const thresholdLine =
    opts.threshold != null
      ? {
          symbol: 'none',
          label: { formatter: `Threshold ${opts.threshold}` },
          data: [{ yAxis: opts.threshold }],
        }
      : undefined;

  opts.series.forEach((s, i) => {
    series.push({
      name: s.name,
      type: s.type ?? 'line',
      showSymbol: s.type === 'scatter',
      symbolSize: s.type === 'scatter' ? 7 : undefined,
      lineStyle: s.dashed ? { type: 'dashed' } : undefined,
      data: pointData(opts.x, s.values),
      markLine: i === 0 ? thresholdLine : undefined,
    });
  });

  chart.setOption({
    animation: false,
    title: { text: opts.title, left: 'center' },
    tooltip: { trigger: 'axis' },
    legend: { top: 30, data: legend },
    grid: { left: 60, right: 25, top: 70, bottom: 45 },
    useUTC: true,
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true, name: opts.yName },
    series,
  });

  const pngDataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
  chart.dispose();
  div.remove();
  return { title: opts.title, pngDataUrl, csv };
}

export interface MatrixChartOptions {
  title: string;
  /** Axis category labels (rows and columns share the same tag set). */
  labels: string[];
  /** matrix[row][col] value; NaN/null cells are left blank. */
  matrix: (number | null)[][];
  rowName?: string;
  colName?: string;
  /** Colour-scale bounds; defaults to the data range. */
  min?: number;
  max?: number;
}

export interface GridHeatmapOptions {
  title: string;
  /** Column (X) category labels. */
  xLabels: string[];
  /** Row (Y) category labels. */
  yLabels: string[];
  /** [xIndex, yIndex, value] tuples for populated buckets. */
  cells: [number, number, number][];
  xName?: string;
  yName?: string;
  /** Colour-scale bounds; defaults to the data range. */
  min?: number;
  max?: number;
}

/**
 * Labelled heatmap for a non-square grid with independent X and Y axes
 * (e.g. hour-of-day × day-of-week temporal heatmaps).
 */
export function renderGridHeatmap(opts: GridHeatmapOptions): ToolChart {
  const header = ['', ...opts.xLabels];
  const grid: (number | null)[][] = opts.yLabels.map(() => opts.xLabels.map(() => null));
  for (const [xi, yi, v] of opts.cells) {
    if (yi >= 0 && yi < grid.length && xi >= 0 && xi < opts.xLabels.length) grid[yi][xi] = v;
  }
  const rows = [header.map(csvValue).join(',')];
  grid.forEach((row, r) => {
    rows.push([opts.yLabels[r] ?? String(r), ...row].map(csvValue).join(','));
  });
  const csv = rows.join('\n');
  if (typeof document === 'undefined') {
    return { title: opts.title, pngDataUrl: '', csv };
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const [, , v] of opts.cells) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const data = opts.cells.map(([xi, yi, v]) => [xi, yi, Number(v.toPrecision(4))]);

  const div = document.createElement('div');
  div.style.width = '900px';
  div.style.height = '560px';
  div.style.position = 'fixed';
  div.style.left = '-10000px';
  div.style.top = '0';
  document.body.appendChild(div);
  const chart = echarts.init(div);
  chart.setOption({
    animation: false,
    title: { text: opts.title, left: 'center' },
    tooltip: { position: 'top' },
    grid: { left: 90, right: 30, top: 70, bottom: 90 },
    xAxis: { type: 'category', data: opts.xLabels, name: opts.xName, axisLabel: { rotate: opts.xLabels.length > 16 ? 45 : 0 } },
    yAxis: { type: 'category', data: opts.yLabels, name: opts.yName },
    visualMap: {
      min: opts.min ?? lo,
      max: opts.max ?? hi,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
    },
    series: [{ type: 'heatmap', data, label: { show: opts.xLabels.length * opts.yLabels.length <= 84 } }],
  });
  const pngDataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
  chart.dispose();
  div.remove();
  return { title: opts.title, pngDataUrl, csv };
}

/** Labelled heatmap for a square relationship matrix (causality, correlation). */
export function renderMatrixChart(opts: MatrixChartOptions): ToolChart {
  const header = ['', ...opts.labels];
  const rows = [header.map(csvValue).join(',')];
  opts.matrix.forEach((row, r) => {
    rows.push([opts.labels[r] ?? String(r), ...row.map((v) => (v == null ? null : v))].map(csvValue).join(','));
  });
  const csv = rows.join('\n');
  if (typeof document === 'undefined') {
    return { title: opts.title, pngDataUrl: '', csv };
  }

  const cells: [number, number, number][] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let r = 0; r < opts.matrix.length; r++) {
    for (let c = 0; c < opts.matrix[r].length; c++) {
      const v = opts.matrix[r][c];
      if (v == null || !Number.isFinite(v)) continue;
      cells.push([c, r, Number(v.toPrecision(3))]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }

  const div = document.createElement('div');
  div.style.width = '720px';
  div.style.height = '640px';
  div.style.position = 'fixed';
  div.style.left = '-10000px';
  div.style.top = '0';
  document.body.appendChild(div);
  const chart = echarts.init(div);
  chart.setOption({
    animation: false,
    title: { text: opts.title, left: 'center' },
    tooltip: { position: 'top' },
    grid: { left: 120, right: 30, top: 70, bottom: 110 },
    xAxis: { type: 'category', data: opts.labels, name: opts.colName, axisLabel: { rotate: 45 } },
    yAxis: { type: 'category', data: opts.labels, name: opts.rowName },
    visualMap: {
      min: opts.min ?? lo,
      max: opts.max ?? hi,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
    },
    series: [{ type: 'heatmap', data: cells, label: { show: opts.labels.length <= 12 } }],
  });
  const pngDataUrl = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#ffffff' });
  chart.dispose();
  div.remove();
  return { title: opts.title, pngDataUrl, csv };
}
