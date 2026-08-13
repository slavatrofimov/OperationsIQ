import type * as echarts from 'echarts';
import type { TimelineMarker } from './timelineMarkers';

/** Max characters shown in an on-chart marker label before an ellipsis. */
export const MAX_MARKER_LABEL_CHARS = 18;
/** Truncate a marker label to a max length, appending an ellipsis. */
export function truncateMarkerLabel(s: string, max = MAX_MARKER_LABEL_CHARS): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}\u2026` : s;
}

/**
 * Shared ECharts building blocks for rendering unified timeline markers
 * (Events UNION Annotations) on ANY chart's option object — not just
 * {@link GlobalOverviewChart}. This lets pages that build their own ECharts
 * `option` (typically via `ChartFrame`) merge annotation pins/bands and a
 * time-range brush into their existing series without duplicating the
 * markLine/markArea wiring per page.
 */

/** Point markers rendered as a labelled `markLine` pin per marker instant. */
export function buildMarkerPins(markers: TimelineMarker[]) {
  return markers.map((m) => ({
    xAxis: m.timestamp.getTime(),
    title: m.title,
    lineStyle: {
      color: m.color,
      type: m.source === 'annotation' ? ('solid' as const) : ('dashed' as const),
      width: m.source === 'annotation' ? 1.5 : 1,
    },
    label: { color: m.color },
  }));
}

/** Shaded `markArea` bands for every marker that has an end (a span). */
export function buildMarkerBands(markers: TimelineMarker[]) {
  return markers
    .filter((m) => m.endTimestamp)
    .map((m) => [
      {
        xAxis: m.timestamp.getTime(),
        name: m.title,
        itemStyle: { color: m.color, opacity: 0.15 },
      },
      { xAxis: (m.endTimestamp as Date).getTime() },
    ]);
}

/**
 * A single dataless ECharts line series carrying the marker `markLine` pins
 * and (if any span markers are present) a `markArea` — kept on its own series
 * so it never collides with a chart's real data series. Returns an empty
 * array when there are no markers to draw.
 */
export function buildMarkerSeries(
  markers: TimelineMarker[],
  seriesName = 'Timeline markers',
): echarts.EChartsCoreOption['series'] {
  if (markers.length === 0) return [];
  const pins = buildMarkerPins(markers);
  const bands = buildMarkerBands(markers);
  return [
    {
      name: seriesName,
      type: 'line' as const,
      data: [] as number[][],
      showSymbol: false,
      silent: false,
      markLine: {
        symbol: ['none', 'pin'],
        symbolSize: 14,
        silent: false,
        emphasis: { disabled: false },
        label: {
          show: true,
          position: 'end',
          distance: 6,
          formatter: (p: { data: { title?: string } }) => truncateMarkerLabel(p.data.title ?? ''),
          fontSize: 10,
          align: 'center',
          verticalAlign: 'bottom',
        },
        data: pins,
      },
      ...(bands.length > 0
        ? {
            markArea: {
              silent: false,
              // The band's `name` is retained on each data item for identity, but
              // its on-chart label is suppressed: the markLine pin already renders
              // the (truncated) title, and drawing the markArea's full-title label
              // too produced an overlapping, double-rendered label at two font sizes.
              label: { show: false },
              data: bands,
            },
          }
        : {}),
    },
  ] as echarts.EChartsCoreOption['series'];
}

/** Markers whose instant (or span) falls within `threshold` of `axisMs`. */
export function markersNear(
  markers: TimelineMarker[],
  axisMs: number,
  thresholdMs: number,
): TimelineMarker[] {
  return markers.filter((m) => {
    const start = m.timestamp.getTime();
    const end = m.endTimestamp ? m.endTimestamp.getTime() : start;
    return axisMs >= start - thresholdMs && axisMs <= end + thresholdMs;
  });
}

/** Render nearby markers as an HTML fragment for an ECharts tooltip. */
export function markersNearTooltipHtml(
  markers: TimelineMarker[],
  axisMs: number,
  thresholdMs: number,
  hasPrecedingRows: boolean,
): string {
  const near = markersNear(markers, axisMs, thresholdMs);
  if (near.length === 0) return '';
  let html = hasPrecedingRows
    ? `<div style="margin-top:6px;padding-top:4px;border-top:1px solid #888;"></div>`
    : '';
  for (const m of near) {
    const glyph = m.source === 'annotation' ? '\u{1F4CC}' : '\u25c6';
    const kind = m.source === 'annotation' ? 'annotation' : 'event';
    const detail = m.detail ? `<br/><span style="opacity:0.8;">${m.detail}</span>` : '';
    html += `<div style="margin-top:2px;"><span style="color:${m.color};">${glyph}</span> <b>${m.title}</b> <span style="opacity:0.7;">(${m.type} \u00b7 ${kind})</span>${detail}</div>`;
  }
  return html;
}

/** A reasonable "nearest neighbour" hover threshold given a chart's x-extent. */
export function markerHoverThresholdMs(fullStart: number, fullEnd: number, binMs?: number): number {
  const span = Math.max(1, fullEnd - fullStart);
  if (binMs && binMs > 0) return Math.max(binMs / 2, span / 2000);
  return span / 400;
}

/** ECharts `brush` + `toolbox` config that lets the user drag/click a time range or point. */
export function annotationBrushOption(): {
  brush: Record<string, unknown>;
  toolbox: Record<string, unknown>;
} {
  return {
    brush: {
      xAxisIndex: 0,
      brushType: 'lineX',
      brushMode: 'single',
      transformable: true,
      brushStyle: {
        borderWidth: 1,
        color: 'rgba(37, 99, 235, 0.18)',
        borderColor: '#2563eb',
      },
    },
    toolbox: {
      right: 12,
      feature: {
        brush: {
          type: ['lineX', 'clear'],
          title: { lineX: 'Select time range', clear: 'Clear selection' },
        },
      },
    },
  };
}

/**
 * Merge unified timeline markers (and, optionally, an annotation-selection
 * brush) into an arbitrary ECharts `option` object. Any page that builds its
 * own option (e.g. via `ChartFrame`) can call this once, right before handing
 * the option to `<EChart>`/`<ChartFrame>`, to get the same marker pins/bands
 * and brush-to-annotate behavior as `GlobalOverviewChart` — without needing to
 * adopt that component. The chart's own series/tooltip are preserved; markers
 * are appended as an extra dataless series and the tooltip formatter (if any)
 * is wrapped to append nearby-marker info.
 */
export function mergeAnnotationMarkers(
  option: echarts.EChartsCoreOption,
  markers: TimelineMarker[],
  opts: {
    brushEnabled?: boolean;
    /** x-axis extent (ms) used to size the hover-proximity threshold. */
    fullStart?: number;
    fullEnd?: number;
    seriesName?: string;
  } = {},
): echarts.EChartsCoreOption {
  const opt = option as Record<string, unknown>;
  const existingSeries = (Array.isArray(opt.series) ? opt.series : opt.series ? [opt.series] : []) as unknown[];
  const markerSeries = buildMarkerSeries(markers, opts.seriesName) as unknown[] | undefined;
  const merged: Record<string, unknown> = {
    ...opt,
    series: [...existingSeries, ...(markerSeries ?? [])],
  };

  if (markers.length > 0 && opts.fullStart != null && opts.fullEnd != null) {
    const threshold = markerHoverThresholdMs(opts.fullStart, opts.fullEnd);
    const existingTooltip = (opt.tooltip ?? {}) as Record<string, unknown>;
    const existingFormatter = existingTooltip.formatter as
      | ((params: unknown) => string)
      | undefined;
    merged.tooltip = {
      ...existingTooltip,
      formatter: (params: unknown) => {
        const base = existingFormatter ? existingFormatter(params) : '';
        const arr = Array.isArray(params) ? params : [params];
        const axisMs = (arr[0] as { axisValue?: number } | undefined)?.axisValue;
        if (axisMs == null) return base;
        const extra = markersNearTooltipHtml(markers, axisMs, threshold, !!base);
        return base + extra;
      },
    };
  }

  if (opts.brushEnabled) {
    const { brush, toolbox } = annotationBrushOption();
    merged.brush = brush;
    merged.toolbox = toolbox;
  }

  return merged as echarts.EChartsCoreOption;
}

/**
 * ECharts `brushEnd` event handler factory: parses the `lineX` brush payload
 * (a drag yields a window; a plain click yields a zero-width range) and
 * invokes `onSelect` with the resolved [start, end] as `Date`s. Shared so any
 * chart wired for annotation-brush selection (not just `GlobalOverviewChart`)
 * gets identical point-vs-span resolution.
 */
export function createBrushEndHandler(
  onSelect: (start: Date, end: Date) => void,
): (params: unknown) => void {
  return (params: unknown) => {
    const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas;
    const range = areas?.[0]?.coordRange;
    if (range && range.length === 2) {
      const [startMs, endMs] = range;
      if (startMs != null && endMs != null && endMs >= startMs) {
        onSelect(new Date(Math.round(startMs)), new Date(Math.round(endMs)));
      }
    }
  };
}
