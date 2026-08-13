import { useMemo } from 'react';
import { Text } from '@fluentui/react-components';
import { EChart } from '../EChart';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import { formatQueryInstant } from '../../lib/timezone';
import {
  PATTERN_COLORS,
  SPAN_FILL_OPACITY,
  spanMarkArea,
  standardDataZoom,
  withAlpha,
  type HighlightSpan,
  type PatternKind,
} from '../../lib/mp/patternColors';
import type { EChartsOption } from 'echarts';

export interface OverviewBucket {
  bucket: number;
  tMin: number;
  tMax: number;
  tAvg: number;
}

export interface MotifSpan {
  startIdx: number;
  length: number;
  color?: string;
  /** Semantic kind so the shared highlight primitive picks a consistent color. */
  kind?: PatternKind;
  selected?: boolean;
}

/**
 * Signal lane (design spec §7.3 item 1): overview envelope on top using ECharts.
 * Renders a min/max band, an avg line, and highlight spans via the shared
 * {@link spanMarkArea} primitive so motifs/discords highlight identically everywhere.
 * Interactive zoom/pan is provided by the shared {@link standardDataZoom} config.
 */
export function SignalLane({
  overview,
  bucketSize,
  spans = [],
  zoom = true,
  group,
  windowStartMs,
  msPerBucket,
}: {
  overview: OverviewBucket[];
  bucketSize: number;
  spans?: MotifSpan[];
  /** Show the interactive zoom slider (default true). */
  zoom?: boolean;
  /** ECharts connect group id for synchronized zoom/cursor across lanes. */
  group?: string;
  /** Absolute window start (epoch ms). When provided with `msPerBucket`, the
   *  x-axis shows real timestamps instead of being hidden. */
  windowStartMs?: number;
  /** Wall-clock milliseconds represented by one overview bucket. */
  msPerBucket?: number;
}) {
  const tooltipDecimals = useTooltipDecimals();

  const showTime =
    typeof windowStartMs === 'number' &&
    Number.isFinite(windowStartMs) &&
    typeof msPerBucket === 'number' &&
    Number.isFinite(msPerBucket) &&
    msPerBucket > 0;

  const option: EChartsOption = useMemo(() => {
    const xs = overview.map((b) => b.bucket);
    const tMins = overview.map((b) => b.tMin);
    const tMaxs = overview.map((b) => b.tMax);
    const tAvgs = overview.map((b) => b.tAvg);

    // Convert sample-index spans → bucket-index highlight spans for the shared primitive.
    // Enforce a minimum on-screen width so a short pattern on a long series still shows
    // as a findable shaded band (not a sub-pixel sliver). The exact duration is reported
    // in the pattern detail; here the highlight's job is discoverability.
    const nBuckets = overview.length;
    const minSpanBuckets = Math.max(2, nBuckets * 0.006);
    const highlights: HighlightSpan[] = spans.map((s) => {
      let from = s.startIdx / bucketSize;
      let to = (s.startIdx + s.length) / bucketSize;
      if (to - from < minSpanBuckets) {
        const center = (from + to) / 2;
        from = Math.max(0, center - minSpanBuckets / 2);
        to = Math.min(Math.max(0, nBuckets - 1), center + minSpanBuckets / 2);
      }
      return {
        from,
        to,
        kind: s.kind ?? 'motif',
        color: s.color,
        selected: s.selected,
      };
    });

    const band = withAlpha(PATTERN_COLORS.signal, 0.25);

    const axisTextColor = '#605e5c';
    const axisLineColor = '#e1dfdd';
    const splitLineColor = '#f3f2f1';
    // Reserve room at the bottom for the (optional) time axis labels AND the zoom
    // slider so neither is clipped. containLabel keeps the y-axis labels in-frame.
    const bottom = zoom ? 46 : showTime ? 26 : 6;

    return {
      animation: false,
      grid: { top: 8, bottom, left: 8, right: 12, containLabel: true },
      dataZoom: zoom
        ? standardDataZoom({ showSlider: true, sliderHeight: 14, sliderBottom: 4 })
        : undefined,
      xAxis: {
        type: 'category' as const,
        data: xs,
        show: showTime,
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: axisLineColor } },
        axisLabel: showTime
          ? {
              hideOverlap: true,
              fontSize: 10,
              color: axisTextColor,
              formatter: (value: string) =>
                formatQueryInstant((windowStartMs as number) + Number(value) * (msPerBucket as number), {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }),
            }
          : { show: false },
      },
      yAxis: {
        type: 'value' as const,
        show: true,
        scale: true,
        splitNumber: 3,
        axisLabel: { fontSize: 10, color: axisTextColor },
        axisTick: { show: false },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: splitLineColor, type: 'dashed' } },
      },
      series: [
        // Band base (invisible): min values
        {
          type: 'line' as const,
          data: tMins,
          showSymbol: false,
          lineStyle: { width: 0 },
          stack: 'band',
          areaStyle: { color: 'transparent' },
          smooth: false,
          silent: true,
          sampling: 'lttb',
        },
        // Band top: (max - min) stacked on base
        {
          type: 'line' as const,
          data: tMaxs.map((v, i) => v - tMins[i]),
          showSymbol: false,
          lineStyle: { width: 0 },
          stack: 'band',
          areaStyle: { color: band },
          smooth: false,
          silent: true,
          sampling: 'lttb',
        },
        // Avg line with markArea spans
        {
          type: 'line' as const,
          data: tAvgs,
          showSymbol: false,
          lineStyle: { color: PATTERN_COLORS.signal, width: 1 },
          smooth: false,
          sampling: 'lttb',
          markArea: spanMarkArea(highlights) ?? { itemStyle: { opacity: SPAN_FILL_OPACITY } },
        },
      ],
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
    };
  }, [overview, spans, bucketSize, tooltipDecimals, zoom, showTime, windowStartMs, msPerBucket]);

  if (overview.length === 0) return <Text>Loading…</Text>;

  return <EChart option={option} height={zoom ? 210 : showTime ? 176 : 160} group={group} />;
}
