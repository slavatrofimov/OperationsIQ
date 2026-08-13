import { useEffect, useId, useMemo } from 'react';
import * as echarts from 'echarts';
import { makeStyles, tokens, Caption1 } from '@fluentui/react-components';
import { EChart } from './EChart';
import type { ExploreSeries } from '../lib/series';
import { PALETTE, ANOMALY_COLOR } from '../lib/series';
import type { ExploreSettings } from '../lib/exploreSettings';
import { tooltipValueFormatter, TIME_AXIS_LABEL, timeAxisPointerLabel } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  title: { paddingBottom: tokens.spacingVerticalXS },
});

export interface DetailChartsProps {
  series: ExploreSeries[];
  nameById: Map<string, string>;
  settings: ExploreSettings;
  /** Emitted (unix seconds) when the user brushes a horizontal range. */
  onSelect: (startSec: number, endSec: number) => void;
  /** Currently selected pattern window (ms), highlighted persistently. */
  selection?: { start: number; end: number } | null;
}

interface YBounds {
  min?: number;
  max?: number;
}

/** Highlight band color for the persisted pattern selection. */
const SELECTION_COLOR = 'rgba(15, 108, 189, 0.12)';
const SELECTION_BORDER = 'rgba(15, 108, 189, 0.6)';

/**
 * Robust shared Y bounds across all series. Uses the 1st/99th percentile of the
 * combined finite values (with a small pad) so a single spurious reading can't
 * blow the axis up to an unreadable scale.
 */
function globalYBounds(series: ExploreSeries[]): YBounds {
  const all: number[] = [];
  for (const s of series) {
    for (const v of s.values) {
      if (v != null && Number.isFinite(v)) all.push(v);
    }
  }
  if (all.length === 0) return {};
  all.sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = (all.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return all[lo] + (all[hi] - all[lo]) * (idx - lo);
  };
  const min = q(0.01);
  const max = q(0.99);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { min: all[0], max: all[all.length - 1] };
  }
  const pad = (max - min) * 0.05 || 1;
  return { min: min - pad, max: max + pad };
}

function buildOption(
  subset: ExploreSeries[],
  nameById: Map<string, string>,
  settings: ExploreSettings,
  paletteOffset: number,
  yBounds: YBounds,
  selection: { start: number; end: number } | null,
  decimals: number,
): echarts.EChartsCoreOption {
  const lineSeries = subset.flatMap((s, i) => {
    const color = PALETTE[(paletteOffset + i) % PALETTE.length];
    const name = nameById.get(s.tagId) ?? s.tagId;
    const parts: Record<string, unknown>[] = [
      {
        name,
        type: 'line',
        showSymbol: false,
        smooth: settings.smoothLines,
        sampling: 'lttb',
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        data: s.x.map((t, idx) => [t * 1000, s.values[idx]]),
      },
    ];
    if (settings.showBaseline && s.baseline.some((b) => b != null)) {
      parts.push({
        name: `${name} baseline`,
        type: 'line',
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 1, color, type: 'dashed', opacity: 0.7 },
        itemStyle: { color },
        data: s.x.map((t, idx) => [t * 1000, s.baseline[idx]]),
      });
    }
    if (settings.showAnomalies) {
      const pts = s.x
        .map((t, idx) => [t * 1000, s.anomalies[idx]] as [number, number | null])
        .filter((p) => p[1] != null);
      if (pts.length > 0) {
        parts.push({
          name: `${name} \u26a0`,
          type: 'scatter',
          symbolSize: 7,
          itemStyle: { color: ANOMALY_COLOR },
          data: pts,
        });
      }
    }
    return parts;
  });

  // Persistently highlight the selected pattern window as a shaded band on the
  // first line series so it stays visible after the brush tool is released.
  if (selection && lineSeries.length > 0) {
    (lineSeries[0] as Record<string, unknown>).markArea = {
      silent: true,
      itemStyle: { color: SELECTION_COLOR, borderColor: SELECTION_BORDER, borderWidth: 1 },
      label: { show: true, position: 'insideTop', color: SELECTION_BORDER, fontSize: 10, formatter: 'Selected' },
      data: [[{ xAxis: selection.start }, { xAxis: selection.end }]],
    };
  }

  return {
    animation: false,
    grid: { left: 56, right: 24, top: 32, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: timeAxisPointerLabel(decimals) },
      valueFormatter: tooltipValueFormatter(decimals),
    },
    legend: { type: 'scroll', top: 0 },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    toolbox: {
      right: 12,
      feature: {
        brush: { type: ['lineX', 'clear'], title: { lineX: 'Select pattern', clear: 'Clear' } },
        dataZoom: { yAxisIndex: 'none' },
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
    xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
    yAxis: { type: 'value', scale: true, min: yBounds.min, max: yBounds.max },
    series: lineSeries,
  };
}

/**
 * Zoomed detail view of the brushed window. Supports three layouts — one
 * combined chart, separate stacked charts, or small multiples — with cursors
 * synced across charts via echarts.connect. A horizontal brush selects a
 * pattern window handed off to similarity search.
 */
export function DetailCharts({ series, nameById, settings, onSelect, selection = null }: DetailChartsProps) {
  const styles = useStyles();
  const groupId = useId();
  const tooltipDecimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const yBounds = useMemo(
    () => (settings.sharedYAxis ? globalYBounds(series) : {}),
    [series, settings.sharedYAxis],
  );
  const displayNameById = useMemo(
    () => new Map(series.map((s) => [s.tagId, labeler(s.tagId, nameById.get(s.tagId))])),
    [series, nameById, labeler],
  );

  // Connect all charts in this group so hovering/zoom syncs across them.
  useEffect(() => {
    echarts.connect(groupId);
    return () => echarts.disconnect(groupId);
  }, [groupId, settings.layout, series.length]);

  const handleBrush = useMemo(
    () => ({
      brushEnd: (params: unknown) => {
        const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas;
        const range = areas?.[0]?.coordRange;
        if (range && range.length === 2 && range[1] > range[0]) {
          onSelect(Math.round(range[0] / 1000), Math.round(range[1] / 1000));
        }
      },
    }),
    [onSelect],
  );

  if (series.length === 0) return null;

  if (settings.layout === 'combined') {
    return (
      <div className={styles.stack}>
        <Caption1>Use the &ldquo;Select pattern&rdquo; brush tool to choose a window to search for.</Caption1>
        <EChart
          option={buildOption(series, displayNameById, settings, 0, yBounds, selection, tooltipDecimals)}
          height={420}
          group={groupId}
          onEvents={handleBrush}
        />
      </div>
    );
  }

  const containerClass = settings.layout === 'smallMultiples' ? styles.grid : styles.stack;
  const chartHeight = settings.layout === 'smallMultiples' ? 240 : 320;

  return (
    <div className={containerClass}>
      {series.map((s, i) => (
        <div key={s.tagId} className={styles.panel}>
          <Caption1 className={styles.title}>{labeler(s.tagId, nameById.get(s.tagId))}</Caption1>
          <EChart
            option={buildOption([s], displayNameById, settings, i, yBounds, selection, tooltipDecimals)}
            height={chartHeight}
            group={groupId}
            onEvents={handleBrush}
          />
        </div>
      ))}
    </div>
  );
}
