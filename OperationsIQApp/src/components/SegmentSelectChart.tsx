import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { Caption1, MessageBar, MessageBarBody, Spinner, makeStyles, tokens } from '@fluentui/react-components';
import { EChart, type EChartHandle } from './EChart';
import type { TimeRange } from './TimeRangePicker';
import { usePageBinning } from '../context/BinningContext';
import { chooseBinFor } from '../lib/binningSettings';
import { buildBinnedSeriesQuery, type Aggregation } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows } from '../lib/series';
import { useAsyncAction } from '../hooks/useAsync';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { toChartMs, fromChartMs } from '../lib/timezone';

/** Highlight band color for the persisted segment selection (matches DetailCharts). */
const SELECTION_COLOR = 'rgba(15, 108, 189, 0.12)';
const SELECTION_BORDER = 'rgba(15, 108, 189, 0.6)';
const LINE_COLOR = '#0f6cbd';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  hintRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  placeholder: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalXXL,
  },
});

export interface SegmentSelectChartProps {
  /** The signal to preview and brush on. When empty, a hint is shown. */
  tagId?: string;
  /** Display name for the previewed signal. */
  tagName?: string;
  /** The currently selected segment; drawn as a persistent highlight band. */
  value: TimeRange;
  /** Emitted when the user finishes brushing a new segment. */
  onChange: (range: TimeRange) => void;
  /** Broader window the preview chart displays and pans within. */
  contextRange: TimeRange;
  /** Aggregation used to sample the preview series (default avg). */
  aggregation?: Aggregation;
  height?: number;
  disabled?: boolean;
}

interface Preview {
  /** [ms, value] pairs for the preview line. */
  data: [number, number | null][];
}

/**
 * Reusable graphical segment selector. Fetches an adaptive-binned preview of one
 * tag over `contextRange`, renders it as an ECharts line, and lets the user drag
 * a horizontal (`lineX`) brush to pick a `{start, end}` window — emitted via
 * `onChange`. The current selection is persistently highlighted as a shaded band.
 * The numeric inputs remain the source of truth; this is an additive affordance.
 */
export function SegmentSelectChart({
  tagId,
  tagName,
  value,
  onChange,
  contextRange,
  aggregation = 'avg',
  height = 220,
  disabled = false,
}: SegmentSelectChartProps) {
  const styles = useStyles();
  const chartRef = useRef<EChartHandle>(null);
  const binning = usePageBinning();
  const tooltipDecimals = useTooltipDecimals();
  const tzOffset = useTimezoneOffset();

  const [state, run] = useAsyncAction(async (id: string, r: TimeRange): Promise<Preview> => {
    const bin = chooseBinFor({ start: r.start, end: r.end }, binning.settings);
    const table = await executeKql(
      buildBinnedSeriesQuery({ tagId: id, start: r.start, end: r.end, binKql: bin.kql, aggregation }),
    );
    const series = parseExploreRows(table)[0];
    if (!series) return { data: [] };
    return { data: series.x.map((t, i) => [t * 1000, series.values[i]] as [number, number | null]) };
  });

  const ctxStartMs = contextRange.start.getTime();
  const ctxEndMs = contextRange.end.getTime();
  // The preview series comes back from KQL already shifted +offset into
  // wall-clock/chart space, so client-created (real-UTC) axis bounds and
  // selection bands must be shifted the same way to line up with it.
  const ctxStartChartMs = toChartMs(ctxStartMs, tzOffset);
  const ctxEndChartMs = toChartMs(ctxEndMs, tzOffset);

  // (Re)fetch whenever the previewed tag or context window changes.
  useEffect(() => {
    if (!tagId) return;
    run(tagId, contextRange).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, ctxStartMs, ctxEndMs, aggregation]);

  const selStartMs = value.start.getTime();
  const selEndMs = value.end.getTime();
  const selStartChartMs = toChartMs(selStartMs, tzOffset);
  const selEndChartMs = toChartMs(selEndMs, tzOffset);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const data = state.data?.data ?? [];
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 16, bottom: 64 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: tooltipValueFormatter(tooltipDecimals),
      },
      toolbox: {
        right: 12,
        feature: {
          brush: { type: ['lineX', 'clear'], title: { lineX: 'Select segment', clear: 'Clear' } },
        },
      },
      brush: {
        xAxisIndex: 0,
        brushType: 'lineX',
        brushMode: 'single',
        throttleType: 'debounce',
        throttleDelay: 200,
        transformable: true,
      },
      dataZoom: [
        { type: 'inside', filterMode: 'none' },
        { type: 'slider', height: 20, bottom: 24, filterMode: 'none' },
      ],
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL, min: ctxStartChartMs, max: ctxEndChartMs },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          name: tagName ?? tagId ?? 'series',
          type: 'line',
          showSymbol: false,
          sampling: 'lttb',
          lineStyle: { width: 1.5, color: LINE_COLOR },
          itemStyle: { color: LINE_COLOR },
          data,
          markArea: {
            silent: true,
            itemStyle: { color: SELECTION_COLOR, borderColor: SELECTION_BORDER, borderWidth: 1 },
            label: {
              show: true,
              position: 'insideTop',
              color: SELECTION_BORDER,
              fontSize: 10,
              formatter: 'Selected',
            },
            data: [[{ xAxis: selStartChartMs }, { xAxis: selEndChartMs }]],
          },
        },
      ],
    };
  }, [state.data, tagId, tagName, ctxStartChartMs, ctxEndChartMs, selStartChartMs, selEndChartMs, tooltipDecimals]);

  // Keep the brush cursor armed and mirror the current selection as a brush area
  // so the handles are draggable and reflect the numeric value.
  useEffect(() => {
    const chart = chartRef.current?.getInstance();
    if (!chart || disabled) return;
    chart.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
    chart.dispatchAction({
      type: 'brush',
      areas: [{ brushType: 'lineX', xAxisIndex: 0, coordRange: [selStartChartMs, selEndChartMs] }],
    });
  }, [option, disabled, selStartChartMs, selEndChartMs]);

  const onEvents = useMemo(
    () => ({
      brushEnd: (params: unknown) => {
        if (disabled) return;
        const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas;
        const range = areas?.[0]?.coordRange;
        if (range && range.length === 2 && range[1] > range[0]) {
          // coordRange is in chart/wall-clock space; onChange consumers work in
          // real UTC, so un-shift by -offset.
          onChange({
            start: new Date(Math.round(fromChartMs(range[0], tzOffset))),
            end: new Date(Math.round(fromChartMs(range[1], tzOffset))),
          });
        }
      },
    }),
    [disabled, onChange, tzOffset],
  );

  if (!tagId) {
    return (
      <div className={styles.placeholder}>
        <Caption1>Select a signal to pick a segment on the chart.</Caption1>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.hintRow}>
        <Caption1>Drag across the chart to select a segment. Use the slider to pan or zoom.</Caption1>
        {state.loading && <Spinner size="tiny" />}
      </div>
      {state.error ? (
        <MessageBar intent="warning">
          <MessageBarBody>Could not load a preview ({state.error}). Enter the segment numerically instead.</MessageBarBody>
        </MessageBar>
      ) : (
        <EChart ref={chartRef} option={option} height={height} onEvents={onEvents} />
      )}
    </div>
  );
}
