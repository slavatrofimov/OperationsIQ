/**
 * Deep Discovery visualization standards — semantic palette + shared ECharts
 * primitives (design: "consistency first, specialize second").
 *
 * Every Matrix Profile result component (SignalLane, MatrixProfileLane, DiscordFlags,
 * RegimeRibbon, ChainView, PatternInspector, …) MUST source its colors and its
 * span/zoom configuration from here so that motifs, discords, regimes, and chains
 * highlight identically across all pattern-search types. Colors are chosen from a
 * colorblind-safe qualitative set; avoid encoding meaning with red/green alone.
 *
 * Pure + dependency-free (only ECharts option fragments), so it is unit-testable.
 */
import type { EChartsOption, MarkAreaComponentOption, MarkLineComponentOption } from 'echarts';

/** The kinds of thing Deep Discovery highlights on a series. */
export type PatternKind = 'motif' | 'discord' | 'regime' | 'chain' | 'consensus' | 'selection';

/**
 * Semantic colors. `signal` is the neutral base line; the rest are the meaning-bearing
 * highlight colors. Kept as hex so they can also drive non-ECharts UI (badges, swatches).
 */
export const PATTERN_COLORS = {
  /** Neutral base signal line / envelope. */
  signal: '#2c7bb6',
  /** Repeating pattern / normal cycle (motif). */
  motif: '#1a9641',
  /** Anomaly / discord — the "stands out" color. */
  discord: '#d7191c',
  /** Slow-degradation chain link. */
  chain: '#5e3c99',
  /** Fleet-wide consensus shape. */
  consensus: '#e66101',
  /** The user's current selection / focused pattern (distinct from all kinds above). */
  selection: '#ff7f00',
  /** De-emphasized (non-participating) series or context. */
  dimmed: '#9aa5b1',
} as const;

/** Categorical, colorblind-safe band colors for regime / operating-mode segmentation. */
export const REGIME_BANDS: string[] = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#e15759',
  '#b07aa1',
  '#76b7b2',
  '#edc948',
  '#9c755f',
];

/**
 * Qualitative series palette for multi-signal overlays (MULTIDIM_* / CONSENSUS_* / AB_*).
 * Distinct hues, colorblind-safe (Tableau 10 order), used when several series share one chart.
 */
export const SERIES_PALETTE: string[] = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#e15759',
  '#b07aa1',
  '#76b7b2',
  '#edc948',
  '#9c755f',
  '#ff9da7',
  '#bab0ac',
];

/** Standard opacity for filled highlight spans, so every lane matches. */
export const SPAN_FILL_OPACITY = 0.28;
/** Opacity for de-emphasized (non-participating) series. */
export const DIMMED_OPACITY = 0.35;

/** The highlight color for a given pattern kind. */
export function patternColor(kind: PatternKind): string {
  if (kind === 'regime') return REGIME_BANDS[0];
  return PATTERN_COLORS[kind];
}

/** Return a regime band color for the nth mode (cycles through the safe set). */
export function regimeBand(index: number): string {
  return REGIME_BANDS[((index % REGIME_BANDS.length) + REGIME_BANDS.length) % REGIME_BANDS.length];
}

/** Return a series color for the nth series in a multi-signal overlay. */
export function seriesColor(index: number): string {
  return SERIES_PALETTE[((index % SERIES_PALETTE.length) + SERIES_PALETTE.length) % SERIES_PALETTE.length];
}

/**
 * Distinct, colorblind-safe color for the nth *discovered pattern* when several patterns
 * are overlaid on the same chart and each needs its own color (design: "each pattern could
 * be color-coded"). Reuses the qualitative series palette so pattern colors stay consistent
 * with the multi-signal overlay hues.
 */
export function patternOverlayColor(index: number): string {
  return SERIES_PALETTE[((index % SERIES_PALETTE.length) + SERIES_PALETTE.length) % SERIES_PALETTE.length];
}

/** Convert a #rrggbb hex to an rgba() string at the given alpha (0..1). */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A single highlighted span on an x-axis (in the chart's x units). */
export interface HighlightSpan {
  from: number;
  to: number;
  kind?: PatternKind;
  /** Optional explicit color override (else derived from `kind`). */
  color?: string;
  /** Optional short label drawn on the span. */
  label?: string;
  /** Marks this span as the user's current selection (thicker border, higher opacity). */
  selected?: boolean;
}

/**
 * Build a consistent ECharts `markArea` config for a set of highlight spans. This is THE
 * shared span primitive — all lanes must use it instead of hand-rolling markArea/markLine
 * so highlighting (color, opacity, border, label) is identical everywhere.
 */
export function spanMarkArea(spans: HighlightSpan[]): MarkAreaComponentOption | undefined {
  if (!spans || spans.length === 0) return undefined;
  return {
    silent: false,
    data: spans.map((s) => {
      const color = s.color ?? patternColor(s.kind ?? 'motif');
      const selected = !!s.selected;
      return [
        {
          xAxis: s.from,
          itemStyle: {
            color,
            opacity: selected ? Math.min(1, SPAN_FILL_OPACITY * 1.8) : SPAN_FILL_OPACITY,
            borderColor: color,
            borderWidth: selected ? 2 : 1,
            // Solid, saturated borders read clearly even when the shaded stretch is
            // narrow on a long series (a dashed, faint border was hard to find).
            borderType: 'solid',
          },
          label: s.label
            ? { show: true, position: 'insideTop', color, fontSize: 10, formatter: s.label }
            : { show: false },
        },
        { xAxis: s.to },
      ];
    }) as MarkAreaComponentOption['data'],
  };
}

/** Build a consistent vertical `markLine` (e.g. regime boundaries) from x positions. */
export function boundaryMarkLine(
  xs: number[],
  opts?: { color?: string; label?: (i: number) => string },
): MarkLineComponentOption | undefined {
  if (!xs || xs.length === 0) return undefined;
  const color = opts?.color ?? PATTERN_COLORS.chain;
  return {
    symbol: 'none',
    silent: true,
    data: xs.map((x, i) => ({
      xAxis: x,
      lineStyle: { color, type: 'dashed', width: 1 },
      label: opts?.label
        ? { show: true, formatter: opts.label(i), color, fontSize: 10 }
        : { show: false },
    })),
  };
}

/**
 * Standard zoom/pan config for result lanes: inside (wheel/drag) + a slider. Pass the
 * axis indices to bind (default the first x axis). Reused from the Explore overview
 * pattern so Deep Discovery lanes are interactively zoomable and consistent.
 */
export function standardDataZoom(opts?: {
  xAxisIndex?: number | number[];
  showSlider?: boolean;
  /** Slider height in px (default 16). */
  sliderHeight?: number;
  /** Slider distance from the chart bottom in px (default 2). */
  sliderBottom?: number;
}): NonNullable<EChartsOption['dataZoom']> {
  const xAxisIndex = opts?.xAxisIndex ?? 0;
  const zooms: NonNullable<EChartsOption['dataZoom']> = [
    { type: 'inside', xAxisIndex, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true },
  ];
  if (opts?.showSlider !== false) {
    zooms.push({
      type: 'slider',
      xAxisIndex,
      height: opts?.sliderHeight ?? 16,
      bottom: opts?.sliderBottom ?? 2,
      filterMode: 'none',
    });
  }
  return zooms;
}
