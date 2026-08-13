import { useEffect, useId, useMemo, type ReactNode, type Ref } from 'react';
import * as echarts from 'echarts';
import { makeStyles, tokens, Caption1 } from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import type { EChartHandle } from './EChart';
import { PALETTE } from '../lib/series';
import type { LayoutMode } from '../lib/exploreSettings';
import {
  tooltipValueFormatter,
  TIME_AXIS_LABEL,
  timeAxisPointerLabel,
} from '../lib/exploreSettings';
import type { MatchRow } from '../lib/similarityViz';
import { matchColor } from '../lib/similarityViz';
import type { ChartData } from '../lib/export';
import { useTagLabeler } from '../context/TagDisplayContext';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import type { TimelineMarker } from '../lib/timelineMarkers';

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

/** A match with its global rank (for consistent color coding across views). */
interface RankedMatch {
  rank: number;
  match: MatchRow;
}

export interface SimilarityTimelineChartProps {
  /** Full binned sample array per search tag, keyed by series_id. */
  searchSeries: Map<string, number[]>;
  /** Similarity-sorted matches (index = rank). */
  matches: MatchRow[];
  /** tagId → display name. */
  nameById: Map<string, string>;
  /** Bin width in seconds — maps sample index → absolute time. */
  binSeconds: number;
  /** Start of the search range in epoch ms — sample index 0's timestamp. */
  searchStartMs: number;
  layout: LayoutMode;
  smooth: boolean;
  decimals: number;
  /**
   * Chart annotation markers to overlay (combined layout only — see
   * `useChartAnnotations`). Unused in the `separate`/`smallMultiples` layouts.
   */
  markers?: TimelineMarker[];
  /** Ref for the combined layout's `ChartFrame`, so a caller can arm the annotation brush. */
  chartRef?: Ref<EChartHandle | null>;
  /** ECharts `brushEnd` handler for the combined layout's annotation-brush flow. */
  onBrushEnd?: (params: unknown) => void;
  /** Arms the ECharts brush cursor + toolbox for the combined layout. */
  brushEnabled?: boolean;
  /** Extra `ChartFrame` toolbar action (e.g. an "Annotate" toggle) for the combined layout. */
  annotateAction?: ReactNode;
}

function tsMs(index: number, startMs: number, binSeconds: number): number {
  return startMs + index * binSeconds * 1000;
}

/** Build markArea highlight bands for the matches belonging to one tag. */
function markAreas(tagMatches: RankedMatch[], startMs: number, binSeconds: number) {
  return {
    silent: false,
    data: tagMatches.map(({ rank, match }) => {
      const color = matchColor(rank);
      return [
        {
          xAxis: tsMs(match.startIndex, startMs, binSeconds),
          itemStyle: { color: `${color}26` },
          label: {
            show: true,
            position: 'insideTop',
            color,
            fontSize: 10,
            formatter: `#${rank + 1}`,
          },
        },
        { xAxis: tsMs(match.endIndex, startMs, binSeconds) },
      ];
    }),
  };
}

function lineFor(
  values: number[],
  name: string,
  color: string,
  smooth: boolean,
  startMs: number,
  binSeconds: number,
  bands?: RankedMatch[],
) {
  const series: Record<string, unknown> = {
    name,
    type: 'line',
    showSymbol: false,
    smooth,
    sampling: 'lttb',
    lineStyle: { width: 1.25, color },
    itemStyle: { color },
    data: values.map((v, i) => [tsMs(i, startMs, binSeconds), v]),
  };
  if (bands && bands.length > 0) {
    series.markArea = markAreas(bands, startMs, binSeconds);
  }
  return series;
}

function cell(v: number | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function timelineChartData(
  tags: string[],
  searchSeries: Map<string, number[]>,
  nameById: Map<string, string>,
  startMs: number,
  binSeconds: number,
  labeler: (tagId: string, tagName?: string) => string,
): ChartData {
  const len = Math.max(0, ...tags.map((tag) => searchSeries.get(tag)?.length ?? 0));
  return {
    columns: ['Timestamp', ...tags.map((tag) => labeler(tag, nameById.get(tag)))],
    rows: Array.from({ length: len }, (_, i) => [
      new Date(tsMs(i, startMs, binSeconds)).toISOString(),
      ...tags.map((tag) => cell(searchSeries.get(tag)?.[i])),
    ]),
  };
}

function baseOption(decimals: number): echarts.EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 56, right: 24, top: 32, bottom: 48 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', label: timeAxisPointerLabel(decimals) },
      valueFormatter: tooltipValueFormatter(decimals),
    },
    legend: { type: 'scroll', top: 0 },
    dataZoom: [{ type: 'slider', height: 18, bottom: 8 }, { type: 'inside' }],
    xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
    yAxis: { type: 'value', scale: true },
  };
}

/**
 * Shows each search-space series over its full extent with the matched
 * subsequences highlighted as shaded, numbered bands (color-matched to the
 * comparison chart). A data-zoom slider lets the user scrub the timeline.
 * Supports combined, separate, and small-multiple layouts.
 */
export function SimilarityTimelineChart({
  searchSeries,
  matches,
  nameById,
  binSeconds,
  searchStartMs,
  layout,
  smooth,
  decimals,
  markers,
  chartRef,
  onBrushEnd,
  brushEnabled,
  annotateAction,
}: SimilarityTimelineChartProps) {
  const styles = useStyles();
  const groupId = useId();
  const labeler = useTagLabeler();

  // Only chart tags that carry data; group ranked matches under their tag.
  const tags = useMemo(() => Array.from(searchSeries.keys()), [searchSeries]);
  const byTag = useMemo(() => {
    const map = new Map<string, RankedMatch[]>();
    matches.forEach((match, rank) => {
      const arr = map.get(match.seriesId) ?? [];
      arr.push({ rank, match });
      map.set(match.seriesId, arr);
    });
    return map;
  }, [matches]);
  const combinedChartData = useMemo(
    () => timelineChartData(tags, searchSeries, nameById, searchStartMs, binSeconds, labeler),
    [tags, searchSeries, nameById, searchStartMs, binSeconds, labeler],
  );

  useEffect(() => {
    echarts.connect(groupId);
    return () => echarts.disconnect(groupId);
  }, [groupId, layout, tags.length]);

  if (tags.length === 0) return null;

  if (layout === 'combined') {
    const maxLen = Math.max(0, ...tags.map((tag) => searchSeries.get(tag)?.length ?? 0));
    const fullEnd = tsMs(Math.max(0, maxLen - 1), searchStartMs, binSeconds);
    const series = tags.map((tag, i) =>
      lineFor(
        searchSeries.get(tag) ?? [],
        labeler(tag, nameById.get(tag)),
        PALETTE[i % PALETTE.length],
        smooth,
        searchStartMs,
        binSeconds,
        byTag.get(tag),
      ),
    );
    const option = mergeAnnotationMarkers(
      { ...baseOption(decimals), series },
      markers ?? [],
      { brushEnabled, fullStart: searchStartMs, fullEnd },
    );
    return (
      <div className={styles.stack}>
        <Caption1>Shaded bands mark where each match was found across the full search space.</Caption1>
        <ChartFrame
          option={option}
          height={380}
          group={groupId}
          fileName="similarity_timeline"
          data={combinedChartData}
          chartRef={chartRef}
          onEvents={onBrushEnd ? { brushEnd: onBrushEnd } : undefined}
          actions={annotateAction}
        />
      </div>
    );
  }

  const containerClass = layout === 'smallMultiples' ? styles.grid : styles.stack;
  const chartHeight = layout === 'smallMultiples' ? 260 : 320;

  return (
    <div className={containerClass}>
      {tags.map((tag, i) => {
        const name = labeler(tag, nameById.get(tag));
        const series = [
          lineFor(
            searchSeries.get(tag) ?? [],
            name,
            PALETTE[i % PALETTE.length],
            smooth,
            searchStartMs,
            binSeconds,
            byTag.get(tag),
          ),
        ];
        return (
          <div key={tag} className={styles.panel}>
            <Caption1 className={styles.title}>{name}</Caption1>
            <ChartFrame
              option={{ ...baseOption(decimals), series }}
              height={chartHeight}
              group={groupId}
              fileName="similarity_timeline"
              data={() => timelineChartData([tag], searchSeries, nameById, searchStartMs, binSeconds, labeler)}
            />
          </div>
        );
      })}
    </div>
  );
}
