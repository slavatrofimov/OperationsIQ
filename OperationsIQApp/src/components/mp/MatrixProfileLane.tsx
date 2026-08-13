import { useMemo, useRef } from 'react';
import { Text, makeStyles } from '@fluentui/react-components';
import { ChartFrame } from '../ChartFrame';
import { mpLaneLabel } from '../../lib/mp/interpret';
import { PATTERN_COLORS, standardDataZoom } from '../../lib/mp/patternColors';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import type { ChartData } from '../../lib/export';
import type { EChartsOption } from 'echarts';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column' },
});

/**
 * The Matrix Profile lane, relabeled in plain language (design spec §7.3 item 2):
 * valleys = "most repeated", peaks = "most unusual". Uses ECharts line chart.
 */
export function MatrixProfileLane({
  mp,
  onHover,
}: {
  mp: number[];
  onHover?: (idx: number) => void;
}) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const finite = mp.filter(Number.isFinite);
  const option: EChartsOption = useMemo(
    () => ({
      animation: false,
      grid: { top: 8, bottom: 28, left: 8, right: 8, containLabel: true },
      dataZoom: standardDataZoom({ showSlider: true }),
      xAxis: {
        type: 'value' as const,
        min: 0,
        max: mp.length - 1,
        show: false,
      },
      yAxis: {
        type: 'value' as const,
        // Low values at top = "most unusual" peaks, high values at bottom = "most repeated"
        // Per spec: valleys (low MP values) = most repeated; peaks = most unusual.
        // We use splitNumber: 2 with custom min/max labels.
        splitNumber: 1,
        axisLabel: {
          formatter: (_v: number, i: number) =>
            i === 0 ? `▲ ${mpLaneLabel('high')}` : `▼ ${mpLaneLabel('low')}`,
          fontSize: 10,
          color: '#666',
        },
      },
      series: [
        {
          name: 'Novelty score',
          type: 'line' as const,
          data: mp.map((v, i) => [i, v]),
          showSymbol: false,
          lineStyle: { color: PATTERN_COLORS.signal, width: 1 },
          smooth: false,
          sampling: 'lttb',
        },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mp, tooltipDecimals],
  );

  const chartData: ChartData = useMemo(
    () => ({
      columns: ['Index', 'ProfileValue'],
      rows: mp.map((v, i) => [i, Number.isFinite(v) ? v : null]),
    }),
    [mp],
  );

  const events = useMemo(
    () => ({
      mousemove: (params: unknown) => {
        const p = params as { dataIndex?: number; data?: number[] };
        const idx = Array.isArray(p?.data) ? (p.data[0] as number) : (p.dataIndex ?? 0);
        onHoverRef.current?.(idx);
      },
    }),
    [],
  );

  if (finite.length === 0) return <Text>No scores yet</Text>;

  return (
    <div className={styles.root}>
      <ChartFrame
        option={option}
        height={100}
        onEvents={events}
        fileName="matrix_profile"
        data={chartData}
      />
    </div>
  );
}
