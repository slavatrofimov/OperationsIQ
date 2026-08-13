import { useEffect, useId, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import {
  Badge,
  Body1,
  Caption1,
  Subtitle1,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import { PALETTE } from '../lib/series';
import {
  tooltipValueFormatter,
  TIME_AXIS_LABEL,
  timeAxisPointerLabel,
} from '../lib/exploreSettings';
import { resampleToLength, sliceInclusive, znorm } from '../lib/similarityViz';
import type { MultidimRow } from '../lib/discover';
import type { ChartData } from '../lib/export';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  matchList: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  matchButton: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalXXS,
    minWidth: '180px',
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    textAlign: 'left',
  },
  matchButtonActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorBrandBackground2,
  },
  matchMeta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalS,
  },
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Track names and SAX words can be long; let the flex cell shrink and wrap
  // rather than overflow into the next column.
  wrapCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  title: { paddingBottom: tokens.spacingVerticalXS },
});

/** Distinct, high-contrast styling for the query reference line. */
const QUERY_COLOR = '#242424';

export interface MultiSeriesResultProps {
  /** Rank-sorted multivariate matches from sax_similarity_search_multidim. */
  matches: MultidimRow[];
  /** track_id (tagId) → binned query-window sample array. */
  queryTracks: Map<string, number[]>;
  /** track_id (tagId) → binned search-window sample array. */
  searchTracks: Map<string, number[]>;
  /** tagId → display name. */
  nameById: Map<string, string>;
  /** Bin width in seconds — maps sample index → absolute time. */
  binSeconds: number;
  /** Start of the search range in epoch ms — sample index 0's timestamp. */
  searchStartMs: number;
  smooth: boolean;
  decimals: number;
}

function cell(v: number | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(3) : '\u2014';
}

function tsMs(index: number, startMs: number, binSeconds: number): number {
  return startMs + index * binSeconds * 1000;
}

/** Per-track data prepared for the selected multivariate match. */
interface PreparedTrack {
  trackId: string;
  name: string;
  color: string;
  /** z-normalized query pattern for this track. */
  queryZ: number[];
  /** z-normalized candidate window, resampled to the query length. */
  candidateZ: number[];
  /** Full binned search series for this track (timeline context). */
  fullSearch: number[];
  startIndex: number;
  endIndex: number;
  distance: number;
  similarity: number;
  queryWord: string;
  candidateWord: string;
}

function comparisonOption(qLen: number, decimals: number): echarts.EChartsCoreOption {
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

function timelineOption(decimals: number): echarts.EChartsCoreOption {
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

function comparisonData(pt: PreparedTrack): ChartData {
  const len = Math.max(pt.queryZ.length, pt.candidateZ.length);
  return {
    columns: ['Index', 'Query', 'Match'],
    rows: Array.from({ length: len }, (_, i) => [i, cell(pt.queryZ[i]), cell(pt.candidateZ[i])]),
  };
}

function timelineData(pt: PreparedTrack, startMs: number, binSeconds: number): ChartData {
  return {
    columns: ['Timestamp', pt.name],
    rows: pt.fullSearch.map((v, i) => [
      new Date(tsMs(i, startMs, binSeconds)).toISOString(),
      cell(v),
    ]),
  };
}

/**
 * Rich result view for a multivariate (multi-tag) similarity search. Lets the
 * user pick one assembled match, then shows — for every track of that match — a
 * query-vs-candidate shape overlay (z-normalized, resampled to the query length)
 * and a full-timeline view with the matched window highlighted, plus a per-track
 * details table. Tracks are aligned by data-point index so co-occurring matches
 * line up across signals.
 */
export function MultiSeriesResult({
  matches,
  queryTracks,
  searchTracks,
  nameById,
  binSeconds,
  searchStartMs,
  smooth,
  decimals,
}: MultiSeriesResultProps) {
  const styles = useStyles();
  const comparisonGroup = useId();
  const timelineGroup = useId();
  const [selected, setSelected] = useState(0);

  // Reset the selection whenever a fresh result set arrives.
  useEffect(() => {
    setSelected(0);
  }, [matches]);

  const colorByTrack = useMemo(() => {
    const map = new Map<string, string>();
    const ids = Array.from(queryTracks.keys()).sort();
    ids.forEach((id, i) => map.set(id, PALETTE[i % PALETTE.length]));
    return map;
  }, [queryTracks]);

  const match = matches[Math.min(selected, matches.length - 1)];

  const tracks = useMemo<PreparedTrack[]>(() => {
    if (!match) return [];
    return match.trackMatches.map((tm) => {
      const query = queryTracks.get(tm.trackId) ?? [];
      const fullSearch = searchTracks.get(tm.trackId) ?? [];
      const candidate = sliceInclusive(fullSearch, tm.startIndex, tm.endIndex);
      return {
        trackId: tm.trackId,
        name: nameById.get(tm.trackId) ?? tm.trackId,
        color: colorByTrack.get(tm.trackId) ?? PALETTE[0],
        queryZ: znorm(query),
        candidateZ: znorm(resampleToLength(candidate, query.length)),
        fullSearch,
        startIndex: tm.startIndex,
        endIndex: tm.endIndex,
        distance: tm.distance,
        similarity: tm.similarity,
        queryWord: tm.queryWord,
        candidateWord: tm.candidateWord,
      } satisfies PreparedTrack;
    });
  }, [match, queryTracks, searchTracks, nameById, colorByTrack]);

  useEffect(() => {
    echarts.connect(comparisonGroup);
    echarts.connect(timelineGroup);
    return () => {
      echarts.disconnect(comparisonGroup);
      echarts.disconnect(timelineGroup);
    };
  }, [comparisonGroup, timelineGroup, tracks.length]);

  if (matches.length === 0) {
    return <Body1>No multivariate matches found for these parameters.</Body1>;
  }

  const span = match
    ? `${new Date(tsMs(match.startIndex, searchStartMs, binSeconds)).toISOString()} \u2192 ${new Date(
        tsMs(match.endIndex, searchStartMs, binSeconds),
      ).toISOString()}`
    : '';

  return (
    <div className={styles.stack}>
      <Subtitle1>Matches ({matches.length})</Subtitle1>
      <Caption1>
        Each match is a window where all query tracks recur together. Select one to inspect its
        per-track shapes and timeline.
      </Caption1>
      <div className={styles.matchList}>
        {matches.map((m, i) => (
          <button
            key={`${m.entityId}-${m.startIndex}-${m.rank}`}
            type="button"
            className={mergeClasses(styles.matchButton, i === selected && styles.matchButtonActive)}
            onClick={() => setSelected(i)}
          >
            <div className={styles.matchMeta}>
              <Badge appearance="filled" color="brand" size="small">{`#${i + 1}`}</Badge>
              <Badge appearance="tint" color="informative" size="small">
                {`${m.matchedTrackCount} tracks`}
              </Badge>
            </div>
            <Caption1>{`score ${fmt(m.exactScore)} \u00b7 dist ${fmt(m.meanDistance)}`}</Caption1>
            <Caption1>
              {new Date(tsMs(m.startIndex, searchStartMs, binSeconds)).toISOString()}
            </Caption1>
          </button>
        ))}
      </div>

      {match && (
        <>
          <Subtitle1>Pattern comparison</Subtitle1>
          <Caption1>{span}</Caption1>
          <div className={styles.grid}>
            {tracks.map((pt) => {
              const qLen = pt.queryZ.length;
              const option = {
                ...comparisonOption(qLen, decimals),
                series: [
                  {
                    name: 'Query',
                    type: 'line',
                    showSymbol: false,
                    smooth,
                    z: 10,
                    lineStyle: { width: 2.5, color: QUERY_COLOR, type: 'dashed' },
                    itemStyle: { color: QUERY_COLOR },
                    data: pt.queryZ.map((v, i) => [i, v]),
                  },
                  {
                    name: 'Match',
                    type: 'line',
                    showSymbol: false,
                    smooth,
                    lineStyle: { width: 1.75, color: pt.color },
                    itemStyle: { color: pt.color },
                    data: pt.candidateZ.map((v, i) => [i, v]),
                  },
                ],
              };
              return (
                <div key={pt.trackId} className={styles.panel}>
                  <Caption1 className={styles.title}>{`${pt.name} \u00b7 sim ${fmt(
                    pt.similarity,
                  )}`}</Caption1>
                  <ChartFrame
                    option={option}
                    height={260}
                    group={comparisonGroup}
                    fileName="multiseries_comparison"
                    data={() => comparisonData(pt)}
                  />
                </div>
              );
            })}
          </div>

          <Subtitle1>Track timelines</Subtitle1>
          <Caption1>
            Full search window per track; the shaded band marks this match. Bands line up across
            tracks (within the allowed inter-track delay).
          </Caption1>
          <div className={styles.grid}>
            {tracks.map((pt) => {
              const startMs = tsMs(pt.startIndex, searchStartMs, binSeconds);
              const endMs = tsMs(pt.endIndex, searchStartMs, binSeconds);
              const option = {
                ...timelineOption(decimals),
                series: [
                  {
                    name: pt.name,
                    type: 'line',
                    showSymbol: false,
                    smooth,
                    sampling: 'lttb',
                    lineStyle: { width: 1.25, color: pt.color },
                    itemStyle: { color: pt.color },
                    data: pt.fullSearch.map((v, i) => [tsMs(i, searchStartMs, binSeconds), v]),
                    markArea: {
                      silent: false,
                      data: [
                        [
                          {
                            xAxis: startMs,
                            itemStyle: { color: `${pt.color}26` },
                            label: {
                              show: true,
                              position: 'insideTop',
                              color: pt.color,
                              fontSize: 10,
                              formatter: `#${selected + 1}`,
                            },
                          },
                          { xAxis: endMs },
                        ],
                      ],
                    },
                  },
                ],
              };
              return (
                <div key={pt.trackId} className={styles.panel}>
                  <Caption1 className={styles.title}>{pt.name}</Caption1>
                  <ChartFrame
                    option={option}
                    height={260}
                    group={timelineGroup}
                    fileName="multiseries_timeline"
                    data={() => timelineData(pt, searchStartMs, binSeconds)}
                  />
                </div>
              );
            })}
          </div>

          <Subtitle1>Match details</Subtitle1>
          <div className={styles.tableScroll}>
            <Table size="small" aria-label="Track matches">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Track</TableHeaderCell>
                  <TableHeaderCell>Similarity</TableHeaderCell>
                  <TableHeaderCell>Distance</TableHeaderCell>
                  <TableHeaderCell>Query word</TableHeaderCell>
                  <TableHeaderCell>Match word</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tracks.map((pt) => (
                  <TableRow key={pt.trackId}>
                    <TableCell className={styles.wrapCell}>{pt.name}</TableCell>
                    <TableCell>{fmt(pt.similarity)}</TableCell>
                    <TableCell>{fmt(pt.distance)}</TableCell>
                    <TableCell className={styles.wrapCell}>{pt.queryWord}</TableCell>
                    <TableCell className={styles.wrapCell}>{pt.candidateWord}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
