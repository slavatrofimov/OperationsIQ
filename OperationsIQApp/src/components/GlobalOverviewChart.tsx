import { useMemo, type Ref } from 'react';
import * as echarts from 'echarts';
import { EChart, type EChartHandle } from './EChart';
import type { ExploreSeries } from '../lib/series';
import { PALETTE, ANOMALY_COLOR } from '../lib/series';
import type { ExploreSettings } from '../lib/exploreSettings';
import { tooltipValueFormatter, TIME_AXIS_LABEL, timeAxisPointerLabel } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import type { TimelineMarker } from '../lib/timelineMarkers';
import {
  buildMarkerSeries,
  markerHoverThresholdMs,
  markersNearTooltipHtml,
  annotationBrushOption,
  createBrushEndHandler,
} from '../lib/annotationMarkers';
import { formatQueryInstant } from '../lib/timezone';

/** A timeline event to flag on the overview. */
export interface EventMarker {
  /** Stable identifier (KQL EventId) used for de-duping and visibility toggles. */
  id: string;
  title: string;
  eventType: string;
  timestamp: Date;
  /** End of a span event; null/undefined for a point event. */
  endTimestamp?: Date | null;
  /** Optional long-form description shown on hover. */
  detail?: string | null;
  tagId: string;
}

/** A discovered / annotated pattern occurrence resolved to wall-clock time. */
export interface PatternSpan {
  /** Stable id (label id, or `${jobId}:motif:${rank}:A`) for de-duping. */
  id: string;
  start: Date;
  end: Date;
  kind: 'MOTIF' | 'DISCORD';
  /** Category name (for grouping / legend); optional. */
  category?: string;
  /** Explicit band color; falls back to a kind-based default. */
  color?: string;
  /** Label / description shown on hover. */
  text?: string;
}

export interface GlobalOverviewChartProps {
  series: ExploreSeries[];
  nameById: Map<string, string>;
  /**
   * Unified timeline markers (Events UNION Annotations) to flag on the overview.
   * The caller applies visibility / type filtering before passing them in.
   */
  markers?: TimelineMarker[];
  /** Discovered / annotated pattern spans to overlay as shaded bands. */
  patternSpans?: PatternSpan[];
  settings: ExploreSettings;
  /** Full data extent (ms). */
  fullStart: number;
  fullEnd: number;
  /** Current brush window (ms), if any, to position the slider handles. */
  brush: { start: number; end: number } | null;
  /** Emitted (ms) whenever the brush window changes. */
  onBrush: (startMs: number, endMs: number) => void;
  /** Optional ref to the underlying chart for PNG export. */
  chartRef?: Ref<EChartHandle | null>;
  /** Brush selection handler for labeling. */
  onBrushEnd?: (start: Date, end: Date) => void;
  /** Enable brush selection mode for labeling. */
  brushEnabled?: boolean;
}

const MOTIF_SPAN_COLOR = '#1a9641';
const DISCORD_SPAN_COLOR = '#d13438';

/** Resolve a pattern span's band color. */
function spanColor(p: PatternSpan): string {
  return p.color ?? (p.kind === 'DISCORD' ? DISCORD_SPAN_COLOR : MOTIF_SPAN_COLOR);
}

/**
 * Coarse full-range overview of every selected series with an anomaly overlay
 * and unified timeline markers (Events + user Annotations). The bottom dataZoom
 * slider is the time brush: dragging it emits the focused window to the detail
 * view.
 */
export function GlobalOverviewChart({
  series,
  nameById,
  markers = [],
  settings,
  fullStart,
  fullEnd,
  brush,
  onBrush,
  chartRef,
  onBrushEnd,
  brushEnabled = false,
  patternSpans = [],
}: GlobalOverviewChartProps) {
  const span = Math.max(1, fullEnd - fullStart);
  const tooltipDecimals = useTooltipDecimals();
  const labeler = useTagLabeler();

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const lineSeries = series.map((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const name = labeler(s.tagId, nameById.get(s.tagId));
      const data = s.x.map((t, idx) => [t * 1000, s.values[idx]]);
      
      const serie: Record<string, unknown> = {
        name,
        type: 'line' as const,
        showSymbol: false,
        smooth: settings.smoothLines,
        sampling: 'lttb' as const,
        lineStyle: { width: 1.25, color },
        itemStyle: { color },
        data,
      };

      return serie;
    });

    const anomalySeries = settings.showAnomalies
      ? series
          .map((s) => {
            const name = labeler(s.tagId, nameById.get(s.tagId));
            const pts = s.x
              .map((t, idx) => [t * 1000, s.anomalies[idx]] as [number, number | null])
              .filter((p) => p[1] != null);
            return {
              name: `${name} \u26a0`,
              type: 'scatter' as const,
              symbolSize: 6,
              itemStyle: { color: ANOMALY_COLOR },
              data: pts,
            };
          })
          .filter((s) => s.data.length > 0)
      : [];

    const showMarkers = markers.length > 0 && lineSeries.length > 0;

    // Pattern spans (discovered motifs/discords + labels) as shaded bands on a
    // dedicated dataless series so they never collide with per-tag annotation
    // markAreas. markArea uses only the xAxis coords, spanning the full y-range.
    const patternSeries =
      patternSpans.length > 0
        ? [
            {
              name: 'Patterns',
              type: 'line' as const,
              data: [] as number[][],
              showSymbol: false,
              silent: false,
              markArea: {
                silent: false,
                data: patternSpans.map((p) => [
                  {
                    xAxis: p.start.getTime(),
                    name: p.text ?? p.kind,
                    itemStyle: { color: spanColor(p), opacity: 0.18 },
                  },
                  { xAxis: p.end.getTime() },
                ]),
              },
            },
          ]
        : [];

    // Timeline markers (Events + Annotations) drawn on a dedicated dataless
    // series so they never collide with the per-series lines or pattern bands.
    // Point markers show a labelled pin; span markers add a shaded band. Events
    // use a dashed guide, annotations a solid one, and each is colored by its
    // source/type so the two are visually distinct. Shared with any other page
    // that instruments a chart for annotations via `annotationMarkers.ts`.
    const markerSeries = (showMarkers ? buildMarkerSeries(markers) : []) as unknown[];
    // Nearest-neighbour resolution for hover: a marker counts as "hovered" when
    // the axis pointer lands within half a bin of its timestamp.
    const xs = series[0]?.x ?? [];
    const binMs = xs.length > 1 ? Math.abs(xs[1] - xs[0]) * 1000 : undefined;
    const eventThreshold = markerHoverThresholdMs(fullStart, fullEnd, binMs);
    const fmtVal = tooltipValueFormatter(tooltipDecimals);

    const baseOption: echarts.EChartsCoreOption = {
      animation: false,
      grid: { left: 56, right: 24, top: 56, bottom: 72 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as {
            axisValue?: number;
            marker?: string;
            seriesName?: string;
            value?: unknown;
          }[];
          const axisMs = typeof arr[0]?.axisValue === 'number' ? arr[0].axisValue : undefined;
          const header =
            axisMs != null
              ? formatQueryInstant(axisMs, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
          const rows = arr
            .map((p) => {
              const v = Array.isArray(p.value) ? p.value[1] : p.value;
              if (v == null) return '';
              return `${p.marker ?? ''}${p.seriesName ?? ''}: <b>${fmtVal(v)}</b>`;
            })
            .filter(Boolean);
          let html = header ? `<div style="margin-bottom:4px;">${header}</div>` : '';
          html += rows.join('<br/>');
          
          // Nearby timeline markers (Events UNION Annotations).
          if (markers.length > 0 && axisMs != null) {
            html += markersNearTooltipHtml(markers, axisMs, eventThreshold, rows.length > 0);
          }
          
          // Nearby pattern spans
          if (patternSpans.length > 0 && axisMs != null) {
            const nearSpans = patternSpans.filter(
              (p) =>
                axisMs >= p.start.getTime() - eventThreshold &&
                axisMs <= p.end.getTime() + eventThreshold,
            );
            if (nearSpans.length > 0) {
              html += rows.length
                ? `<div style="margin-top:6px;padding-top:4px;border-top:1px solid #888;"></div>`
                : '';
              for (const p of nearSpans) {
                const kindLabel = p.kind === 'DISCORD' ? 'anomaly' : 'pattern';
                const cat = p.category ? ` <span style="opacity:0.7;">[${p.category}]</span>` : '';
                html += `<div style="margin-top:2px;"><span style="color:${spanColor(p)};">\u25ae</span> <b>${p.text ?? kindLabel}</b> <span style="opacity:0.7;">(${kindLabel})</span>${cat}</div>`;
              }
            }
          }

          return html || '';
        },
      },
      legend: { type: 'scroll', top: 0, data: lineSeries.map((s) => s.name as string) },
      xAxis: {
        type: 'time',
        min: fullStart,
        max: fullEnd,
        axisLabel: TIME_AXIS_LABEL,
      },
      yAxis: { type: 'value', scale: true },
      dataZoom: [
        {
          type: 'slider',
          filterMode: 'none',
          startValue: brush ? brush.start : fullStart,
          endValue: brush ? brush.end : fullEnd,
          height: 36,
          bottom: 16,
        },
        {
          type: 'inside',
          filterMode: 'none',
        },
      ],
      series: [...lineSeries, ...anomalySeries, ...patternSeries, ...markerSeries],
    };

    // Add a horizontal (lineX) brush when annotation selection mode is active so
    // the user can drag to pick a time range or click to pick a single time point
    // directly on the overview before authoring an annotation.
    if (brushEnabled && onBrushEnd) {
      const { brush: brushCfg, toolbox } = annotationBrushOption();
      baseOption.brush = brushCfg;
      baseOption.toolbox = toolbox;
    }

    return baseOption;
    // startPct/endPct intentionally excluded; slider position is set via startValue/endValue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, nameById, labeler, markers, patternSpans, settings, fullStart, fullEnd, brush, brushEnabled, tooltipDecimals]);

  const onEvents = useMemo(() => {
    const handlers: Record<string, (params: unknown) => void> = {
      datazoom: (params: unknown) => {
        // Read the resolved window from the event; supports batch + percent forms.
        const p = params as {
          batch?: { startValue?: number; endValue?: number; start?: number; end?: number }[];
          startValue?: number;
          endValue?: number;
          start?: number;
          end?: number;
        };
        const z = p.batch?.[0] ?? p;
        let startMs = z.startValue;
        let endMs = z.endValue;
        if (startMs == null && z.start != null) startMs = fullStart + (span * z.start) / 100;
        if (endMs == null && z.end != null) endMs = fullStart + (span * z.end) / 100;
        if (startMs != null && endMs != null && endMs > startMs) {
          onBrush(Math.round(startMs), Math.round(endMs));
        }
      },
    };
    if (brushEnabled && onBrushEnd) {
      handlers.brushEnd = createBrushEndHandler(onBrushEnd);
    }
    return handlers;
  }, [fullStart, span, onBrush, brushEnabled, onBrushEnd]);

  return <EChart ref={chartRef as Ref<EChartHandle>} option={option} height={280} onEvents={onEvents} />;
}