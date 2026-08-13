import { useMemo } from 'react';
import { Text } from '@fluentui/react-components';
import { ChartFrame } from '../ChartFrame';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import { PATTERN_COLORS, withAlpha } from '../../lib/mp/patternColors';
import type { OverviewBucket } from './SignalLane';
import type { ChartData } from '../../lib/export';
import type { EChartsOption } from 'echarts';

/** One stacked panel: a signal's overview envelope + avg line. */
export interface PanelLane {
  /** Stable lane id used to attach overlays (e.g. tag id, 'A'/'B', or seriesId). */
  id: string;
  label: string;
  /** Render de-emphasized (non-participating channel in a multidim result). */
  dimmed?: boolean;
  buckets: OverviewBucket[];
  /** Absolute epoch-ms of this lane's first bucket. */
  startMs: number;
  /** Wall-clock milliseconds represented by one overview bucket for this lane. */
  msPerBucket: number;
}

/** A color-coded highlight for a discovered pattern, in absolute time, on one lane. */
export interface PanelOverlay {
  laneId: string;
  startMs: number;
  endMs: number;
  color: string;
  selected?: boolean;
  /** Short label drawn on the span (e.g. "M1"). */
  label?: string;
}

/** A mode-change boundary (segmentation) drawn as a vertical line across every panel. */
export interface PanelBoundary {
  /** Absolute epoch-ms where the mode change occurs. */
  timeMs: number;
  /** Short label drawn on the selected line (e.g. "Change 12"). */
  label?: string;
  /** Emphasize this boundary (bold solid + labeled); others render faint. */
  selected?: boolean;
}

const PANEL_PX = 132;
const CHROME_PX = 96;

/** Sentinel name for the min/band envelope helper series so the axis tooltip can skip them. */
const HELPER_SERIES = '__envelope__';

/**
 * A single synchronized multi-panel time chart (design: mirror the Decomposition page):
 * one stacked grid per signal, all sharing one `time` x-axis, a linked crosshair
 * (`axisPointer.link`), and one `dataZoom` (wheel + slider) bound to every panel — so
 * zooming/panning/hovering one panel moves them all together. Discovered patterns are
 * overlaid as color-coded shaded spans on the panels they occur in. This replaces the
 * previous stack of independent {@link SignalLane} charts.
 */
export function SignalPanels({
  lanes,
  overlays,
  boundaries = [],
  fileName = 'signal_panels',
}: {
  lanes: PanelLane[];
  overlays: PanelOverlay[];
  boundaries?: PanelBoundary[];
  fileName?: string;
}) {
  const tooltipDecimals = useTooltipDecimals();

  const option: EChartsOption = useMemo(() => {
    const rows = lanes.length;
    if (rows === 0) return {};

    // Percentage grid stack (identical scheme to the Decomposition page), leaving room
    // at the bottom for the shared time axis labels + zoom slider so neither is clipped.
    const topPct = 3;
    const bottomPct = 12;
    const gap = 3;
    const avail = 100 - topPct - bottomPct - gap * (rows - 1);
    const h = avail / rows;
    const grids = lanes.map((_, i) => ({
      left: 56,
      right: 20,
      top: `${topPct + i * (h + gap) + 4}%`,
      height: `${h - 4}%`,
    }));

    const xAxes = lanes.map((_, i) => ({
      type: 'time' as const,
      gridIndex: i,
      axisLabel: {
        show: i === rows - 1,
        fontSize: 10,
        color: '#605e5c',
        hideOverlap: true,
      },
      axisTick: { show: i === rows - 1 },
      axisLine: { lineStyle: { color: '#e1dfdd' } },
    }));
    const yAxes = lanes.map((_, i) => ({
      type: 'value' as const,
      gridIndex: i,
      scale: true,
      splitNumber: 3,
      axisLabel: { fontSize: 10, color: '#605e5c' },
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#f3f2f1', type: 'dashed' as const } },
    }));

    // Minimum on-screen highlight width so a short pattern on a long window still reads
    // as a findable shaded band rather than a hairline.
    const spanMs = lanes.reduce((acc, l) => Math.max(acc, l.buckets.length * l.msPerBucket), 0);
    const minSpanMs = Math.max(1, spanMs * 0.006);

    // Mode-change boundaries drawn as vertical lines across every panel: faint dashed
    // for context, bold solid for the selected one (labeled on the top panel only so the
    // callout is not repeated on each grid).
    const boundaryMark = (laneIdx: number) =>
      boundaries.length > 0
        ? {
            symbol: 'none' as const,
            silent: true,
            data: boundaries.map((b) => ({
              xAxis: b.timeMs,
              lineStyle: b.selected
                ? { color: PATTERN_COLORS.discord, width: 2, type: 'solid' as const, opacity: 0.9 }
                : { color: PATTERN_COLORS.discord, width: 1, type: 'dashed' as const, opacity: 0.22 },
              label:
                b.selected && b.label && laneIdx === 0
                  ? {
                      show: true,
                      position: 'insideEndTop' as const,
                      formatter: b.label,
                      color: PATTERN_COLORS.discord,
                      fontSize: 10,
                      fontWeight: 600,
                    }
                  : { show: false },
            })),
          }
        : undefined;

    const series = lanes.flatMap((lane, i) => {
      const t = (j: number) => lane.startMs + j * lane.msPerBucket;
      const mins = lane.buckets.map((b, j) => [t(j), b.tMin] as [number, number]);
      const bandTop = lane.buckets.map((b, j) => [t(j), b.tMax - b.tMin] as [number, number]);
      const avgs = lane.buckets.map((b, j) => [t(j), b.tAvg] as [number, number]);
      const dim = lane.dimmed ? 0.4 : 1;
      const band = withAlpha(PATTERN_COLORS.signal, lane.dimmed ? 0.1 : 0.22);

      const laneOverlays = overlays.filter((o) => o.laneId === lane.id);
      const markArea =
        laneOverlays.length > 0
          ? {
              silent: false,
              data: laneOverlays.map((o) => {
                let from = o.startMs;
                let to = o.endMs;
                if (to - from < minSpanMs) {
                  const c = (from + to) / 2;
                  from = c - minSpanMs / 2;
                  to = c + minSpanMs / 2;
                }
                return [
                  {
                    xAxis: from,
                    itemStyle: {
                      color: o.color,
                      opacity: o.selected ? 0.4 : 0.24,
                      borderColor: o.color,
                      borderWidth: o.selected ? 2 : 1,
                      borderType: 'solid' as const,
                    },
                    label: o.label
                      ? {
                          show: true,
                          position: 'insideTop' as const,
                          color: o.color,
                          fontSize: 10,
                          fontWeight: 600,
                          formatter: o.label,
                        }
                      : { show: false },
                  },
                  { xAxis: to },
                ];
              }),
            }
          : undefined;

      return [
        {
          name: HELPER_SERIES,
          type: 'line' as const,
          xAxisIndex: i,
          yAxisIndex: i,
          data: mins,
          showSymbol: false,
          lineStyle: { width: 0 },
          stack: `band-${lane.id}`,
          areaStyle: { color: 'transparent' },
          silent: true,
          sampling: 'lttb' as const,
        },
        {
          name: HELPER_SERIES,
          type: 'line' as const,
          xAxisIndex: i,
          yAxisIndex: i,
          data: bandTop,
          showSymbol: false,
          lineStyle: { width: 0 },
          stack: `band-${lane.id}`,
          areaStyle: { color: band },
          silent: true,
          sampling: 'lttb' as const,
        },
        {
          name: lane.label,
          type: 'line' as const,
          xAxisIndex: i,
          yAxisIndex: i,
          data: avgs,
          showSymbol: false,
          lineStyle: { color: PATTERN_COLORS.signal, width: 1, opacity: dim },
          sampling: 'lttb' as const,
          ...(markArea ? { markArea } : {}),
          ...(boundaryMark(i) ? { markLine: boundaryMark(i) } : {}),
        },
      ];
    });

    const allX = lanes.map((_, i) => i);

    return {
      animation: false,
      title: lanes.map((lane, i) => ({
        text: lane.label,
        left: 56,
        top: grids[i].top,
        textStyle: {
          fontSize: 12,
          fontWeight: 600,
          color: lane.dimmed ? '#a19f9d' : '#323130',
        },
      })),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as Array<{
            seriesName?: string;
            marker?: string;
            axisValueLabel?: string;
            value?: unknown;
          }>;
          const rows = arr.filter((p) => p.seriesName && p.seriesName !== HELPER_SERIES);
          if (rows.length === 0) return '';
          const header = rows[0].axisValueLabel ?? '';
          const lines = rows.map((p) => {
            const raw = Array.isArray(p.value) ? p.value[1] : p.value;
            const val = typeof raw === 'number' ? raw.toFixed(tooltipDecimals) : '';
            return `${p.marker ?? ''}${p.seriesName}: <b>${val}</b>`;
          });
          return [header, ...lines].join('<br/>');
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: allX, filterMode: 'none' },
        { type: 'slider', xAxisIndex: allX, bottom: 8, height: 18, filterMode: 'none' },
      ],
      series,
    } as EChartsOption;
  }, [lanes, overlays, boundaries, tooltipDecimals]);

  const chartData = (): ChartData => {
    const columns = ['Timestamp', ...lanes.map((l) => l.label)];
    // Align on the widest lane's bucket count; each lane maps bucket→its own timestamp.
    const maxLen = lanes.reduce((m, l) => Math.max(m, l.buckets.length), 0);
    const rows: (string | number | null)[][] = [];
    for (let j = 0; j < maxLen; j++) {
      const ts =
        lanes[0] && j < lanes[0].buckets.length
          ? new Date(lanes[0].startMs + j * lanes[0].msPerBucket).toISOString()
          : '';
      rows.push([ts, ...lanes.map((l) => (j < l.buckets.length ? l.buckets[j].tAvg : null))]);
    }
    return { columns, rows };
  };

  if (lanes.length === 0 || lanes.every((l) => l.buckets.length === 0)) {
    return <Text>Loading…</Text>;
  }

  const height = Math.max(240, lanes.length * PANEL_PX + CHROME_PX);

  return <ChartFrame option={option} height={height} fileName={fileName} data={chartData} />;
}
