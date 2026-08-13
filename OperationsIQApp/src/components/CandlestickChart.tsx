import { useMemo } from 'react';
import * as echarts from 'echarts';
import { makeStyles, tokens, Caption1 } from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import { PALETTE } from '../lib/series';
import { computeMA, normalizeMaWindows, type OhlcBar } from '../lib/candlestick';
import { tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import type { ChartData } from '../lib/export';
import { formatQueryInstant } from '../lib/timezone';

const useStyles = makeStyles({
  empty: { padding: tokens.spacingVerticalM },
});

/** Up (close >= open) / down candle colors. */
const UP_COLOR = '#107c10';
const DOWN_COLOR = '#c50f1f';

export interface CandlestickChartProps {
  bars: OhlcBar[];
  /** Display name of the plotted tag (candlestick series name / legend). */
  name: string;
  /** Moving-average windows (in bars) to overlay; derived from the Close price. */
  maWindows: number[];
  height?: number;
  /** Base name for downloaded PNG / CSV files. */
  fileName?: string;
}

/**
 * Candlestick (OHLC) chart with a volume sub-panel and multiple moving averages,
 * modeled on the Apache ECharts "candlestick-brush" example. Every metric is
 * derived from the same pre-aggregated series: the candles are per-bin
 * open/high/low/close, the volume bars are per-bin raw-record counts (colored by
 * up/down), and each MA line is a simple moving average of the Close values.
 */
export function CandlestickChart({
  bars,
  name,
  maWindows,
  height = 480,
  fileName = 'trend_volatility',
}: CandlestickChartProps) {
  const styles = useStyles();
  const decimals = useTooltipDecimals();

  const windows = useMemo(() => normalizeMaWindows(maWindows), [maWindows]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const categories = bars.map((b) => b.t);
    // ECharts candlestick datum order is [open, close, low, high].
    const ohlc = bars.map((b) => [b.open, b.close, b.low, b.high]);
    // Volume datum: [index, value, up(-1)/down(1)] for the visualMap coloring.
    const volumes = bars.map((b, i) => [i, b.volume, b.open > b.close ? 1 : -1]);

    const maSeries = windows.map((w, i) => {
      const color = PALETTE[i % PALETTE.length];
      const ma = computeMA(bars, w);
      return {
        name: `MA${w}`,
        type: 'line',
        data: ma.map((v) => (v == null ? '-' : Number(v.toFixed(decimals)))),
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1.5, opacity: 0.85, color },
        itemStyle: { color },
      };
    });

    return {
      animation: false,
      legend: {
        top: 0,
        data: [name, ...windows.map((w) => `MA${w}`), 'Volume'],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: tooltipValueFormatter(decimals),
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#777' } },
      toolbox: {
        right: 12,
        feature: {
          dataZoom: { yAxisIndex: false },
          restore: {},
        },
      },
      grid: [
        { left: 56, right: 24, top: 36, height: '58%' },
        { left: 56, right: 24, top: '74%', height: '14%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: categories,
          boundaryGap: true,
          axisLine: { onZero: false },
          splitLine: { show: false },
          axisLabel: { formatter: (v: number) => formatBinLabel(Number(v)) },
          min: 'dataMin',
          max: 'dataMax',
          axisPointer: { z: 100, label: { formatter: (p: { value: number }) => formatBinLabel(Number(p.value)) } },
        },
        {
          type: 'category',
          gridIndex: 1,
          data: categories,
          boundaryGap: true,
          axisLine: { onZero: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          min: 'dataMin',
          max: 'dataMax',
        },
      ],
      yAxis: [
        { scale: true, splitArea: { show: true } },
        {
          scale: true,
          gridIndex: 1,
          splitNumber: 2,
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        { show: true, type: 'slider', xAxisIndex: [0, 1], bottom: 8, start: 0, end: 100 },
      ],
      visualMap: {
        show: false,
        seriesIndex: 1 + windows.length,
        dimension: 2,
        pieces: [
          { value: 1, color: DOWN_COLOR },
          { value: -1, color: UP_COLOR },
        ],
      },
      series: [
        {
          name,
          type: 'candlestick',
          data: ohlc,
          itemStyle: {
            color: UP_COLOR,
            color0: DOWN_COLOR,
            borderColor: UP_COLOR,
            borderColor0: DOWN_COLOR,
          },
        },
        ...maSeries,
        {
          name: 'Volume',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
        },
      ],
    };
  }, [bars, name, windows, decimals]);

  if (bars.length === 0) {
    return <Caption1 className={styles.empty}>No candlestick data in this window.</Caption1>;
  }

  return (
    <CandlestickFrame
      option={option}
      bars={bars}
      windows={windows}
      decimals={decimals}
      height={height}
      fileName={fileName}
    />
  );
}

/**
 * Wraps the candlestick option in a {@link ChartFrame} so it shares the same
 * PNG export, CSV export, and "view as table" controls as every other chart.
 * The table / CSV columns mirror what the chart plots: OHLC + Volume plus one
 * column per moving-average overlay. The linear/log scale toggle is disabled
 * because a candlestick + volume panel does not read sensibly on a log axis.
 */
function CandlestickFrame({
  option,
  bars,
  windows,
  decimals,
  height,
  fileName,
}: {
  option: echarts.EChartsCoreOption;
  bars: OhlcBar[];
  windows: number[];
  decimals: number;
  height: number;
  fileName: string;
}) {
  const data = useMemo<ChartData>(() => {
    const maCols = windows.map((w) => `MA${w}`);
    const maSeries = windows.map((w) => computeMA(bars, w));
    return {
      columns: ['Timestamp', 'Open', 'High', 'Low', 'Close', 'Volume', ...maCols],
      rows: bars.map((b, i) => [
        new Date(b.t).toISOString(),
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        ...maSeries.map((ma) => {
          const v = ma[i];
          return v == null ? null : Number(v.toFixed(decimals));
        }),
      ]),
    };
  }, [bars, windows, decimals]);

  return (
    <ChartFrame
      option={option}
      height={height}
      data={data}
      fileName={fileName}
      allowScaleToggle={false}
    />
  );
}

/** Compact bin-start label: date + time so intraday and multi-day grains read well. */
function formatBinLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  // Query bins are pre-shifted into the preferred timezone — render as UTC.
  return formatQueryInstant(ms, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
