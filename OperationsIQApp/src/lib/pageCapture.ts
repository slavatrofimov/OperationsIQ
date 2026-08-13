/**
 * Client-side capture of a page's analysis results for saving as Evidence:
 *  - a Markdown snapshot of the page's main content (turndown + GFM),
 *  - every ECharts graph exported as both a PNG image and a CSV of its data,
 *  - a deep link that restores the page's current state.
 *
 * Capture reads only from the live DOM and mounted ECharts instances, so it
 * issues no extra Eventhouse queries.
 */

import * as echarts from 'echarts';
import TurndownService from 'turndown';
// @ts-expect-error - turndown-plugin-gfm ships without bundled types.
import { gfm } from 'turndown-plugin-gfm';
import type { CapturedChart } from './evidence';
import type { CaptureContextSummary } from '../context/CaptureContext';
import { getChartPngDataUrl } from './chartSnapshot';

// ---------------------------------------------------------------------------
// Analysis-parameters summary
// ---------------------------------------------------------------------------

/** Escape a value so it renders as a single Markdown table cell. */
function escapeCell(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/**
 * Render a page-published context summary (selected tags, time window, key
 * settings, …) as a deterministic "Analysis parameters" Markdown section.
 * Empty sections and blank fields are dropped; returns '' when nothing is
 * worth showing. This is what preserves the contextual controls that the
 * DOM-based Markdown capture necessarily strips.
 */
export function renderContextSummaryMarkdown(
  summary: CaptureContextSummary | null | undefined,
): string {
  if (!summary || summary.sections.length === 0) return '';

  const blocks: string[] = [];
  for (const section of summary.sections) {
    const fields = section.fields.filter((f) => String(f.value ?? '').trim() !== '');
    if (fields.length === 0) continue;

    const lines: string[] = [];
    if (section.title) lines.push(`### ${section.title}`, '');
    lines.push('| Parameter | Value |', '| --- | --- |');
    for (const f of fields) {
      lines.push(`| ${escapeCell(f.label)} | ${escapeCell(f.value)} |`);
    }
    blocks.push(lines.join('\n'));
  }

  if (blocks.length === 0) return '';
  return ['## Analysis parameters', ...blocks].join('\n\n');
}

// ---------------------------------------------------------------------------
// Markdown capture
// ---------------------------------------------------------------------------

/** Selectors for non-content chrome that must never appear in the snapshot. */
const CHROME_SELECTORS = [
  'button',
  'input',
  'textarea',
  'select',
  'nav',
  '[role="toolbar"]',
  '[role="tablist"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[contenteditable]',
  'canvas',
  'svg',
  '.echarts-for-react',
  '[_echarts_instance_]',
].join(',');

function makeTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  service.use(gfm);

  // Drop interactive / non-content nodes entirely.
  service.remove(['script', 'style', 'noscript'] as (keyof HTMLElementTagNameMap)[]);
  service.addRule('drop-chrome', {
    filter: (node) =>
      node.nodeType === 1 && (node as HTMLElement).matches?.(CHROME_SELECTORS),
    replacement: () => '',
  });
  return service;
}

/**
 * Convert a page's main-content container to Markdown. The container's DOM is
 * cloned first so removing chrome nodes never mutates the live page. Charts,
 * form controls, toolbars, and nav are stripped; headings, paragraphs, lists,
 * and tables are preserved. When a `contextSummary` is supplied (published by
 * the page), its parameters are rendered as an "Analysis parameters" section so
 * the interactive controls that get stripped are still captured.
 */
export function capturePageMarkdown(
  root: HTMLElement,
  pageName?: string,
  contextSummary?: CaptureContextSummary | null,
): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(CHROME_SELECTORS).forEach((el) => el.remove());

  // Fluent's TableHeaderCell wraps its label in a block-level <div>
  // (`.fui-TableHeaderCell__button`). Turndown treats that block as line
  // breaks *inside* the cell, and a GFM table whose header row contains
  // newlines is not parsed as a table at all -- it renders as literal
  // "| ... |" pipe text. Collapse every cell to single-line text so tables
  // convert to clean, renderable GFM. (GFM cells cannot span lines anyway.)
  clone.querySelectorAll('th, td').forEach((cell) => {
    cell.textContent = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
  });

  const service = makeTurndown();
  const body = service.turndown(clone.innerHTML).trim();

  const header = pageName
    ? `# ${pageName}\n\n_Captured ${new Date().toLocaleString()}_`
    : '';
  const contextMd = renderContextSummaryMarkdown(contextSummary);

  return [header, contextMd, body]
    .filter((part) => part && part.trim())
    .join('\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Chart capture
// ---------------------------------------------------------------------------

/** All ECharts instances mounted within `root`, in document order. */
function findChartInstances(root: HTMLElement): { el: HTMLElement; chart: echarts.ECharts }[] {
  const els = Array.from(root.querySelectorAll<HTMLElement>('[_echarts_instance_]'));
  // Some ECharts builds also expose instances via getInstanceByDom on the exact
  // init container; querying the attribute covers the app's EChart wrapper.
  const found: { el: HTMLElement; chart: echarts.ECharts }[] = [];
  for (const el of els) {
    const chart = echarts.getInstanceByDom(el);
    if (chart) found.push({ el, chart });
  }
  return found;
}

/** Best-effort chart title from the nearest ChartFrame heading above the chart. */
function chartTitle(el: HTMLElement, index: number): string {
  // ChartFrame renders a Subtitle2 heading in a sibling toolbar above the chart.
  let current: HTMLElement | null = el.parentElement;
  for (let hops = 0; hops < 4 && current; hops += 1) {
    const heading = current.querySelector(
      'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="Subtitle" i]',
    );
    const text = heading?.textContent?.trim();
    if (text) return text;
    current = current.parentElement;
  }
  return `Chart ${index + 1}`;
}

/** The subset of an ECharts option that {@link optionToCsv} reads. */
export interface CsvChartOption {
  xAxis?: { data?: (string | number)[] }[];
  series?: { name?: string; data?: unknown[] }[];
}

/**
 * Reconstruct a CSV of a chart's plotted data from its ECharts option. Handles
 * the common shapes used in this app: a category xAxis plus one or more value
 * series, and series whose data are [x, y] pairs. Returns '' when no tabular
 * data can be derived (PNG is still captured).
 *
 * Pure and tolerant of mixed series shapes (a scatter of [x, y] pairs alongside
 * a scalar reference line, etc.) so it can be unit-tested and never throws on
 * the live-DOM option shapes ECharts hands back.
 */
export function optionToCsv(option: CsvChartOption): string {
  const series = option.series ?? [];
  if (series.length === 0) return '';

  const rows: (string | number)[][] = [];
  const xAxis = option.xAxis?.[0];
  const categories = xAxis?.data;

  const isPairData =
    Array.isArray(series[0]?.data) &&
    series[0].data!.length > 0 &&
    Array.isArray(series[0].data![0]);

  if (isPairData) {
    // [x, y] pair series -> one x column plus one column per series. Only the
    // first series is inspected to pick this branch, so other series may still
    // carry scalar points (e.g. a reference/threshold line). Skip any point that
    // is not a [x, y] pair rather than destructuring it — destructuring a scalar
    // (a number) throws "is not iterable" and would crash the whole capture.
    const header = ['x', ...series.map((s, i) => s.name || `series_${i + 1}`)];
    const byX = new Map<string | number, (string | number | null)[]>();
    series.forEach((s, si) => {
      const points = Array.isArray(s.data) ? s.data : [];
      points.forEach((point) => {
        if (!Array.isArray(point)) return;
        const [x, y] = point as [string | number, string | number];
        if (!byX.has(x)) byX.set(x, new Array(series.length).fill(null));
        byX.get(x)![si] = y;
      });
    });
    rows.push(header);
    for (const [x, vals] of byX) rows.push([x, ...vals.map((v) => (v ?? '') as string | number)]);
  } else if (categories && categories.length > 0) {
    // Category axis + scalar value series.
    const header = ['category', ...series.map((s, i) => s.name || `series_${i + 1}`)];
    rows.push(header);
    categories.forEach((cat, i) => {
      rows.push([cat, ...series.map((s) => (s.data?.[i] ?? '') as string | number)]);
    });
  } else {
    // Fallback: index vs scalar values.
    const maxLen = Math.max(...series.map((s) => s.data?.length ?? 0));
    const header = ['index', ...series.map((s, i) => s.name || `series_${i + 1}`)];
    rows.push(header);
    for (let i = 0; i < maxLen; i += 1) {
      rows.push([i, ...series.map((s) => (s.data?.[i] ?? '') as string | number)]);
    }
  }

  return rows
    .map((r) => r.map((c) => csvField(c)).join(','))
    .join('\r\n');
}

/** Reconstruct a CSV from a mounted chart's current ECharts option. */
function chartToCsv(chart: echarts.ECharts): string {
  return optionToCsv(chart.getOption() as CsvChartOption);
}

function csvField(value: unknown): string {
  if (value == null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Capture every chart in `root` as a PNG data URL + CSV. */
export function capturePageCharts(root: HTMLElement): CapturedChart[] {
  return findChartInstances(root).map(({ el, chart }, index) => ({
    title: chartTitle(el, index),
    pngDataUrl: getChartPngDataUrl(chart, { pixelRatio: 2, backgroundColor: '#ffffff' }),
    csv: chartToCsv(chart),
  }));
}
