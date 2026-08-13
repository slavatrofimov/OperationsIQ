import { useMemo } from 'react';
import * as echarts from 'echarts';
import {
  Subtitle2,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import type { ExploreSeries } from '../lib/series';
import { PALETTE } from '../lib/series';
import { histogram, boxSummary, durationCurve } from '../lib/stats';
import { tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import type { ChartData } from '../lib/export';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

export interface DistributionPanelProps {
  series: ExploreSeries[];
  nameById: Map<string, string>;
  /** Number of histogram bins. */
  bins?: number;
}

/** Add alpha to a #rrggbb hex color for translucent overlaid histogram bars. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Value-distribution views for the selected detail series, all computed
 * client-side from the already-fetched values: overlaid histograms, a
 * per-series box plot (Tukey whiskers + outliers), and load-duration curves.
 */
export function DistributionPanel({
  series,
  nameById,
  bins = 30,
}: DistributionPanelProps) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const names = useMemo(
    () => series.map((s) => labeler(s.tagId, nameById.get(s.tagId))),
    [series, nameById, labeler],
  );
  const tooltipDecimals = useTooltipDecimals();
  const fmtVal = tooltipValueFormatter(tooltipDecimals);

  const histOption = useMemo<echarts.EChartsCoreOption>(() => {
    const barSeries = series.map((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const hist = histogram(s.values, bins);
      return {
        name: names[i],
        type: 'bar' as const,
        barGap: '-100%',
        barCategoryGap: '0%',
        itemStyle: { color: withAlpha(color, 0.5), borderColor: color, borderWidth: 0.5 },
        data: hist.map((b) => [(b.lo + b.hi) / 2, b.count] as [number, number]),
      };
    });
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 40, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? String(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: names },
      xAxis: { type: 'value', scale: true, name: 'Value', nameLocation: 'middle', nameGap: 26 },
      yAxis: { type: 'value', name: 'Count' },
      series: barSeries,
    };
  }, [series, names, bins]);

  const boxOption = useMemo<echarts.EChartsCoreOption>(() => {
    const boxes: ({ value: number[]; itemStyle: object } | null)[] = [];
    const outliers: [number, number][] = [];
    series.forEach((s, i) => {
      const b = boxSummary(s.values);
      if (!b) {
        boxes.push(null);
        return;
      }
      const color = PALETTE[i % PALETTE.length];
      boxes.push({
        value: [b.whiskerLow, b.q1, b.median, b.q3, b.whiskerHigh],
        itemStyle: { color: withAlpha(color, 0.25), borderColor: color },
      });
      for (const o of b.outliers) outliers.push([i, o]);
    });
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 44 },
      tooltip: {
        trigger: 'item',
        formatter: (p: unknown) => {
          const params = p as { seriesType?: string; value?: number[]; dataIndex?: number };
          if (params.seriesType === 'boxplot' && Array.isArray(params.value)) {
            // value = [dataIndex, low, q1, median, q3, high] for boxplot tooltips.
            const [, low, q1, med, q3, high] = params.value;
            return [
              names[params.dataIndex ?? 0] ?? '',
              `Upper: ${fmtVal(high)}`,
              `Q3: ${fmtVal(q3)}`,
              `Median: ${fmtVal(med)}`,
              `Q1: ${fmtVal(q1)}`,
              `Lower: ${fmtVal(low)}`,
            ].join('<br/>');
          }
          if (Array.isArray(params.value)) return `Outlier: ${fmtVal(params.value[1])}`;
          return '';
        },
      },
      xAxis: { type: 'category', data: names, axisLabel: { interval: 0, hideOverlap: true } },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          name: 'Box',
          type: 'boxplot',
          data: boxes,
        },
        {
          name: 'Outliers',
          type: 'scatter',
          data: outliers,
          symbolSize: 6,
          itemStyle: { color: '#d13438' },
        },
      ],
    };
  }, [series, names, fmtVal]);

  const durationOption = useMemo<echarts.EChartsCoreOption>(() => {
    const lineSeries = series.map((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const curve = durationCurve(s.values);
      return {
        name: names[i],
        type: 'line' as const,
        showSymbol: false,
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        data: curve.map((p) => [p.percent, p.value] as [number, number]),
      };
    });
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 40, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          label: {
            formatter: (p: { value: number | string; axisDimension?: string }) =>
              p.axisDimension === 'x'
                ? `${Number(p.value).toFixed(0)}%`
                : typeof p.value === 'number'
                  ? fmtVal(p.value)
                  : String(p.value),
          },
        },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: names },
      xAxis: {
        type: 'value',
        min: 0,
        max: 100,
        name: '% of time \u2265 value',
        nameLocation: 'middle',
        nameGap: 26,
        axisLabel: { formatter: '{value}%' },
      },
      yAxis: { type: 'value', scale: true, name: 'Value' },
      series: lineSeries,
    };
  }, [series, names, fmtVal]);

  if (series.length === 0) return null;

  const histData: ChartData = {
    columns: ['Series', 'Bin center', 'Count'],
    rows: series.flatMap((s, i) =>
      histogram(s.values, bins).map((b) => [names[i], (b.lo + b.hi) / 2, b.count]),
    ),
  };

  const boxData: ChartData = {
    columns: ['Series', 'Whisker low', 'Q1', 'Median', 'Q3', 'Whisker high'],
    rows: series.flatMap((s, i) => {
      const b = boxSummary(s.values);
      return b ? [[names[i], b.whiskerLow, b.q1, b.median, b.q3, b.whiskerHigh]] : [];
    }),
  };

  const durationData: ChartData = {
    columns: ['Series', '% of time \u2265 value', 'Value'],
    rows: series.flatMap((s, i) =>
      durationCurve(s.values).map((p) => [names[i], p.percent, p.value]),
    ),
  };

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <Subtitle2>Value distribution (histogram)</Subtitle2>
        <ChartFrame option={histOption} height={260} data={histData} fileName="distribution_histogram" />
      </div>
      <div className={styles.section}>
        <Subtitle2>Box plot</Subtitle2>
        <Caption1>Box spans Q1–Q3; whiskers use the 1.5×IQR Tukey fence; dots are outliers.</Caption1>
        <ChartFrame
          option={boxOption}
          height={260}
          data={boxData}
          fileName="distribution_boxplot"
          allowScaleToggle={false}
        />
      </div>
      <div className={styles.section}>
        <Subtitle2>Load-duration curve</Subtitle2>
        <Caption1>Values sorted high-to-low against the fraction of time at or above each level.</Caption1>
        <ChartFrame
          option={durationOption}
          height={260}
          data={durationData}
          fileName="distribution_duration"
          allowScaleToggle={false}
        />
      </div>
    </div>
  );
}
