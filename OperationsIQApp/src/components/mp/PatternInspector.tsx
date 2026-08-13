import { useMemo } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { ChartFrame } from '../ChartFrame';
import { zNormalize } from '../../lib/mp/signal';
import { seriesColor } from '../../lib/mp/patternColors';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import type { ChartData } from '../../lib/export';
import type { EChartsOption } from 'echarts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  caption: { color: tokens.colorNeutralForeground3 },
});

/**
 * Pattern Inspector (design spec §7.3 item 3): draws the matched subsequences
 * z-normalized and superimposed so the user can visually confirm the match.
 * Uses ECharts multi-line overlay.
 */
export function PatternInspector({
  instances,
  caption,
}: {
  instances: number[][];
  caption?: string;
}) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();

  const normalized = useMemo(
    () => instances.map(zNormalize).filter((a) => a.length > 0),
    [instances],
  );

  const option: EChartsOption = useMemo(() => {
    if (normalized.length === 0) return {};
    const n = Math.max(...normalized.map((a) => a.length));
    return {
      animation: false,
      grid: { top: 4, bottom: 24, left: 8, right: 8, containLabel: true },
      xAxis: { type: 'value' as const, min: 0, max: n - 1, show: false },
      yAxis: { type: 'value' as const, show: false },
      series: normalized.map((arr, i) => ({
        name: `Instance ${i + 1}`,
        type: 'line' as const,
        data: arr.map((v, j) => [j, v]),
        showSymbol: false,
        lineStyle: { color: seriesColor(i), width: 1.5 },
        opacity: 0.8,
        smooth: false,
      })),
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
    };
  }, [normalized, tooltipDecimals]);

  const chartData: ChartData = useMemo(() => {
    const n = Math.max(0, ...normalized.map((a) => a.length));
    return {
      columns: ['Index', ...normalized.map((_, i) => `Instance ${i + 1}`)],
      rows: Array.from({ length: n }, (_, i) => [
        i,
        ...normalized.map((arr) => {
          const v = arr[i];
          return v != null && Number.isFinite(v) ? v : null;
        }),
      ]),
    };
  }, [normalized]);

  if (normalized.length === 0) return <Text>No matches yet</Text>;

  return (
    <div className={styles.root}>
      <Text size={200} className={styles.caption}>
        {caption ?? 'Matched stretches, aligned so you can see where they differ'}
      </Text>
      <ChartFrame option={option} height={120} fileName="motif_instances" data={chartData} />
    </div>
  );
}
