import { useEffect, useId, useMemo } from 'react';
import * as echarts from 'echarts';
import { makeStyles, tokens, Caption1 } from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import type { LayoutMode } from '../lib/exploreSettings';
import { tooltipValueFormatter } from '../lib/exploreSettings';
import type { MatchRow } from '../lib/similarityViz';
import { matchColor, resampleToLength, znorm } from '../lib/similarityViz';
import type { ChartData } from '../lib/export';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  title: { paddingBottom: tokens.spacingVerticalXS },
});

/** Distinct, high-contrast styling for the query reference line. */
const QUERY_COLOR = '#242424';

export interface SimilarityComparisonChartProps {
  /** Raw (binned) query pattern sample array. */
  queryValues: number[];
  /** Similarity-sorted matches (index = rank, drives color). */
  matches: MatchRow[];
  /** Full binned sample array per search tag, keyed by series_id. */
  searchSeries: Map<string, number[]>;
  /** tagId → display name. */
  nameById: Map<string, string>;
  layout: LayoutMode;
  smooth: boolean;
  decimals: number;
}

interface PreparedMatch {
  rank: number;
  label: string;
  color: string;
  values: number[];
}

function legendLabel(
  m: MatchRow,
  rank: number,
  nameById: Map<string, string>,
  labeler: (tagId: string, tagName?: string) => string,
): string {
  const name = labeler(m.seriesId, nameById.get(m.seriesId));
  const sim = Number.isFinite(m.similarity) ? m.similarity.toFixed(3) : '—';
  const scale = Number.isFinite(m.scale) ? `${m.scale.toFixed(2)}\u00d7` : '';
  return `#${rank + 1} ${name} \u00b7 sim ${sim}${scale ? ` \u00b7 ${scale}` : ''}`;
}

function baseOption(qLen: number, decimals: number): echarts.EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 48, right: 20, top: 32, bottom: 40 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      valueFormatter: tooltipValueFormatter(decimals),
    },
    legend: { type: 'scroll', top: 0 },
    xAxis: {
      type: 'value',
      name: 'Data point',
      nameLocation: 'middle',
      nameGap: 24,
      min: 0,
      max: Math.max(1, qLen - 1),
    },
    yAxis: { type: 'value', scale: true, name: 'z-score', nameGap: 8 },
  };
}

function querySeries(qz: number[], smooth: boolean) {
  return {
    name: 'Query pattern',
    type: 'line',
    showSymbol: false,
    smooth,
    z: 10,
    lineStyle: { width: 2.5, color: QUERY_COLOR, type: 'dashed' },
    itemStyle: { color: QUERY_COLOR },
    data: qz.map((v, i) => [i, v]),
  };
}

function matchSeries(pm: PreparedMatch, smooth: boolean) {
  return {
    name: pm.label,
    type: 'line',
    showSymbol: false,
    smooth,
    lineStyle: { width: 1.75, color: pm.color },
    itemStyle: { color: pm.color },
    data: pm.values.map((v, i) => [i, v]),
  };
}

function cell(v: number | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function comparisonChartData(qz: number[], prepared: PreparedMatch[]): ChartData {
  const len = Math.max(qz.length, ...prepared.map((pm) => pm.values.length));
  return {
    columns: ['Index', 'Query', ...prepared.map((pm) => pm.label)],
    rows: Array.from({ length: len }, (_, i) => [
      i,
      cell(qz[i]),
      ...prepared.map((pm) => cell(pm.values[i])),
    ]),
  };
}

/**
 * Overlays the query pattern and every matched subsequence on a common
 * data-point axis. Each match is resampled to the query's length and
 * z-normalized, so shapes align and compare directly even when a match spans a
 * different duration (scale ≠ 1). Color-coded with a legend; supports combined,
 * separate, and small-multiple layouts.
 */
export function SimilarityComparisonChart({
  queryValues,
  matches,
  searchSeries,
  nameById,
  layout,
  smooth,
  decimals,
}: SimilarityComparisonChartProps) {
  const styles = useStyles();
  const groupId = useId();
  const labeler = useTagLabeler();

  const qLen = queryValues.length;
  const qz = useMemo(() => znorm(queryValues), [queryValues]);

  const prepared = useMemo<PreparedMatch[]>(() => {
    return matches.map((m, rank) => {
      const full = searchSeries.get(m.seriesId) ?? [];
      const subseq = full.slice(m.startIndex, m.endIndex + 1);
      const aligned = znorm(resampleToLength(subseq, qLen));
      return { rank, label: legendLabel(m, rank, nameById, labeler), color: matchColor(rank), values: aligned };
    });
  }, [matches, searchSeries, nameById, labeler, qLen]);
  const combinedChartData = useMemo(() => comparisonChartData(qz, prepared), [qz, prepared]);

  useEffect(() => {
    echarts.connect(groupId);
    return () => echarts.disconnect(groupId);
  }, [groupId, layout, prepared.length]);

  if (qLen === 0) return null;

  if (layout === 'combined') {
    const option = {
      ...baseOption(qLen, decimals),
      series: [querySeries(qz, smooth), ...prepared.map((pm) => matchSeries(pm, smooth))],
    };
    return (
      <div className={styles.stack}>
        <Caption1>
          Each match is resampled to the query length and z-normalized, so shapes line up by data
          point regardless of duration.
        </Caption1>
        <ChartFrame
          option={option}
          height={400}
          group={groupId}
          fileName="similarity_comparison"
          data={combinedChartData}
        />
      </div>
    );
  }

  const containerClass = layout === 'smallMultiples' ? styles.grid : styles.stack;
  const chartHeight = layout === 'smallMultiples' ? 240 : 300;

  return (
    <div className={containerClass}>
      {prepared.map((pm) => {
        const option = {
          ...baseOption(qLen, decimals),
          series: [querySeries(qz, smooth), matchSeries(pm, smooth)],
        };
        return (
          <div key={pm.rank} className={styles.panel}>
            <Caption1 className={styles.title}>{pm.label}</Caption1>
            <ChartFrame
              option={option}
              height={chartHeight}
              group={groupId}
              fileName="similarity_comparison"
              data={() => comparisonChartData(qz, [pm])}
            />
          </div>
        );
      })}
    </div>
  );
}
