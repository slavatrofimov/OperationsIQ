import { useMemo, useState } from 'react';
import * as echarts from 'echarts';
import {
  Body1,
  Caption1,
  Card,
  Label,
  MessageBar,
  MessageBarBody,
  Select,
  Subtitle1,
  Subtitle2,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { chooseBin } from '../lib/binning';
import { buildExploreQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, PALETTE, ANOMALY_COLOR, type ExploreSeries } from '../lib/series';
import { useLiveTail } from '../hooks/useLiveTail';
import { LiveIndicator } from '../components/LiveIndicator';
import { ChartFrame } from '../components/ChartFrame';
import { StatisticsPanel } from '../components/StatisticsPanel';
import { TagBrowser } from '../components/TagBrowser';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { PageIntro } from '../components/PageIntro';
import { useSharedTags } from '../context/SelectionContext';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { type TimeRange } from '../components/TimeRangePicker';
import {
  resolveRelativeRange,
  type BinningSettings,
  type RelativeTimeSpec,
} from '../lib/binningSettings';
import {
  AGGREGATION_OPTIONS,
  tooltipValueFormatter,
  TIME_AXIS_LABEL,
  timeAxisPointerLabel,
} from '../lib/exploreSettings';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import { tagField } from '../hooks/pageControllerFields';
import { RELATIVE_UNIT_OPTIONS, PREFERRED_MILLIS_MAX } from '../lib/binningSettings';
import type { RelativeUnit } from '../lib/binningSettings';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { formatQueryInstant, toChartMs } from '../lib/timezone';
import { exploreSeriesToChartData } from '../lib/export';

const useStyles = makeStyles({
  root: { display: 'flex', height: '100%', minHeight: 0 },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    overflowY: 'auto',
    padding: tokens.spacingHorizontalXXS,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  spacer: { flex: 1 },
  refreshGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  body: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-start', minWidth: 0 },
  sidebar: { width: '320px', flexShrink: 0, padding: tokens.spacingVerticalM },
  content: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: { padding: tokens.spacingVerticalL },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  refreshSelector: { minWidth: '150px' },
});

/** Default trailing window: the last 15 minutes. */
const DEFAULT_LIVE_SPEC: RelativeTimeSpec = { value: 15, unit: 'minutes' };
const DEFAULT_REFRESH_SEC = 10;
/** Refresh interval options: 5 s … 60 s in 5 s steps. */
const REFRESH_OPTIONS = Array.from({ length: 12 }, (_, i) => (i + 1) * 5);

const DEFAULT_LIVE_BINNING: BinningSettings = {
  aggregation: 'avg',
  maxBins: 500,
  preferredMillis: null,
};

/** Display settings for the live chart (only these fields are honored). */
const CHART_SETTINGS = { smoothLines: false, showAnomalies: false };

export interface LiveViewPageProps {
  tags: TagInfo[];
}

/**
 * A stripped-down, auto-refreshing "live" view: it plots a rolling trailing
 * window that always ends at "now" and re-queries the full window from the
 * Eventhouse on each refresh cycle (Approach A — no incremental tailing). It
 * keeps the adaptive-binning controls (so high-frequency data can be
 * pre-aggregated) but drops the Explore page's absolute date pickers, detail
 * chart, and auxiliary panels, retaining only descriptive statistics.
 */
export function LiveViewPage({ tags }: LiveViewPageProps) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const tzOffset = useTimezoneOffset();

  const [selected, setSelected] = useSharedTags();
  const [relSpec, setRelSpec] = useState<RelativeTimeSpec>(DEFAULT_LIVE_SPEC);
  const [refreshSec, setRefreshSec] = useState<number>(DEFAULT_REFRESH_SEC);
  const [binning, setBinning] = useState<BinningSettings>(DEFAULT_LIVE_BINNING);
  const [range, setRange] = useState<TimeRange>(() => resolveRelativeRange(relSpec));
  const [series, setSeries] = useState<ExploreSeries[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [ticksSinceData, setTicksSinceData] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The real [start, end] actually queried on the most recent tick — used to
  // scope annotation loads/markers to exactly what's plotted (vs. `range`,
  // which only reflects the sidebar's editable window-length controls).
  const [queryRange, setQueryRange] = useState<TimeRange | null>(null);

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);

  const patchBinning = (patch: Partial<BinningSettings>) =>
    setBinning((s) => ({ ...s, ...patch }));

  // The relative selector supplies only the window *length*; useLiveTail
  // re-anchors it to "now" on every tick.
  const windowMs = useMemo(() => {
    const r = resolveRelativeRange(relSpec);
    return Math.max(1, r.end.getTime() - r.start.getTime());
  }, [relSpec]);

  const enabled = selected.length > 0;

  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({
    tags,
    levels,
    tagIds: selected,
    range: queryRange,
    offsetMinutes: tzOffset,
    showMarkers: showOnChart,
  });

  // Pause the polling loop while the user is actively brushing a selection or
  // has the annotation dialog open, so a live re-query never wipes out an
  // in-progress selection or reflows the chart under the dialog. Polling
  // resumes automatically once selecting/dialogOpen clear.
  const liveEnabled = enabled && !annot.selecting && !annot.dialogOpen;

  const { countdown, isFetching, refreshNow } = useLiveTail({
    enabled: liveEnabled,
    windowMs,
    intervalMs: refreshSec * 1000,
    onTick: async (start, end) => {
      if (selected.length === 0) return;
      try {
        const bin = chooseBin({
          start,
          end,
          maxBins: binning.maxBins,
          preferredMillis: binning.preferredMillis ?? undefined,
        });
        const table = await executeKql(
          buildExploreQuery({
            tagIds: selected,
            start,
            end,
            binKql: bin.kql,
            aggregation: binning.aggregation,
          }),
        );
        const parsed = parseExploreRows(table);
        setSeries(parsed);
        setQueryRange({ start, end });
        setError(null);
        if (parsed.some((s) => s.x.length > 0)) {
          setLastUpdated(new Date());
          setTicksSinceData(0);
        } else {
          setTicksSinceData((prev) => prev + 1);
        }
      } catch (err) {
        console.error('[LiveView] Tick failed:', err);
        setError(err instanceof Error ? err.message : String(err));
        setTicksSinceData((prev) => prev + 1);
      }
    },
  });

  const hasData = series.some((s) => s.x.length > 0);

  // Live series come back from the query layer already shifted into chart
  // space (KQL pre-shifts by the timezone offset; wall clock encoded as UTC
  // ticks). The axis bounds and annotation range, however, are computed from
  // real-UTC `queryRange` — convert them into chart space via `toChartMs` so
  // they line up with the plotted data and with `useChartAnnotations`'s
  // `offsetMinutes`-shifted markers.
  const chartMin = queryRange ? toChartMs(queryRange.start.getTime(), tzOffset) : undefined;
  const chartMax = queryRange ? toChartMs(queryRange.end.getTime(), tzOffset) : undefined;

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const lineSeries = series.map((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const name = labeler(s.tagId, nameById.get(s.tagId));
      const data = s.x.map((t, idx) => [t * 1000, s.values[idx]]);
      return {
        name,
        type: 'line' as const,
        showSymbol: false,
        smooth: CHART_SETTINGS.smoothLines,
        sampling: 'lttb' as const,
        lineStyle: { width: 1.25, color },
        itemStyle: { color },
        data,
      };
    });

    const anomalySeries = CHART_SETTINGS.showAnomalies
      ? series
          .map((s) => {
            const name = labeler(s.tagId, nameById.get(s.tagId));
            const pts = s.x
              .map((t, idx) => [t * 1000, s.anomalies[idx]] as [number, number | null])
              .filter((p) => p[1] != null);
            return {
              name: `${name} \u26a0`,
              type: 'scatter' as const,
              symbolSize: 6,
              itemStyle: { color: ANOMALY_COLOR },
              data: pts,
            };
          })
          .filter((s) => s.data.length > 0)
      : [];

    const fmtVal = tooltipValueFormatter(tooltipDecimals);

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 56, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as {
            axisValue?: number;
            marker?: string;
            seriesName?: string;
            value?: unknown;
          }[];
          const axisMs = typeof arr[0]?.axisValue === 'number' ? arr[0].axisValue : undefined;
          const header =
            axisMs != null
              ? formatQueryInstant(axisMs, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : '';
          const rows = arr
            .map((p) => {
              const v = Array.isArray(p.value) ? p.value[1] : p.value;
              if (v == null) return '';
              return `${p.marker ?? ''}${p.seriesName ?? ''}: <b>${fmtVal(v)}</b>`;
            })
            .filter(Boolean);
          let html = header ? `<div style="margin-bottom:4px;">${header}</div>` : '';
          html += rows.join('<br/>');
          return html || '';
        },
      },
      legend: { type: 'scroll', top: 0, data: lineSeries.map((s) => s.name as string) },
      xAxis: {
        type: 'time',
        ...(chartMin != null ? { min: chartMin } : {}),
        ...(chartMax != null ? { max: chartMax } : {}),
        axisLabel: TIME_AXIS_LABEL,
      },
      yAxis: { type: 'value', scale: true },
      series: [...lineSeries, ...anomalySeries],
    };
  }, [series, nameById, labeler, chartMin, chartMax, tooltipDecimals]);

  const annotatedOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(option, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: chartMin,
        fullEnd: chartMax,
      }),
    [option, annot.chartMarkers, annot.selecting, chartMin, chartMax],
  );

  useControlledPage({
    pageKey: 'liveview',
    title: 'Live view',
    fields: [
      tagField({
        tags,
        current: selected,
        set: setSelected,
        multi: true,
        description: 'One or more signals to stream live.',
      }),
      {
        field: pf.integer('windowValue', 'Trailing window value', relSpec.value, {
          min: 1,
          description: 'Size of the rolling window (paired with the window unit).',
        }),
        apply: (v) => setRelSpec((s) => ({ ...s, value: coerce.integer(v, { min: 1 }) })),
      },
      {
        field: pf.enumOf(
          'windowUnit',
          'Trailing window unit',
          relSpec.unit,
          RELATIVE_UNIT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          setRelSpec((s) => ({
            ...s,
            unit: coerce.enumValue(
              v,
              RELATIVE_UNIT_OPTIONS.map((o) => o.value),
            ) as RelativeUnit,
          })),
      },
      {
        field: pf.integer('refreshSeconds', 'Refresh interval (seconds)', refreshSec, {
          min: 5,
          max: 60,
          description: 'How often the window is re-queried, 5–60 seconds.',
        }),
        apply: (v) => setRefreshSec(coerce.integer(v, { min: 5, max: 60 })),
      },
      {
        field: pf.enumOf(
          'aggregation',
          'Aggregation',
          binning.aggregation,
          AGGREGATION_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          patchBinning({
            aggregation: coerce.enumValue(
              v,
              AGGREGATION_OPTIONS.map((o) => o.value),
            ) as BinningSettings['aggregation'],
          }),
      },
      {
        field: pf.integer('resolution', 'Resolution (ms)', binning.preferredMillis ?? 0, {
          min: 0,
          max: PREFERRED_MILLIS_MAX,
          description: 'Preferred bin width in milliseconds; 0 = auto.',
        }),
        apply: (v) => {
          const ms = coerce.integer(v, { min: 0, max: PREFERRED_MILLIS_MAX });
          patchBinning({ preferredMillis: ms > 0 ? ms : null });
        },
      },
      {
        field: pf.integer('maxBins', 'Max points', binning.maxBins, {
          min: 1,
          description: 'Maximum number of points computed per series.',
        }),
        apply: (v) => patchBinning({ maxBins: coerce.integer(v, { min: 1 }) }),
      },
    ],
    canRun: enabled,
    run: refreshNow,
    loading: isFetching,
    error: error ?? undefined,
    hasResult: hasData,
  });

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <div className={styles.toolbar}>
          <Subtitle1>Live view</Subtitle1>

          <div className={styles.refreshGroup}>
            <Label htmlFor="live-refresh-select">Refresh every</Label>
            <Select
              id="live-refresh-select"
              className={styles.refreshSelector}
              value={String(refreshSec)}
              onChange={(_, d) => setRefreshSec(Number(d.value))}
            >
              {REFRESH_OPTIONS.map((s) => (
                <option key={s} value={String(s)}>
                  {s} seconds
                </option>
              ))}
            </Select>
          </div>

          <LiveIndicator
            active={enabled}
            countdown={countdown}
            isFetching={isFetching}
            lastUpdated={lastUpdated}
            ticksSinceData={ticksSinceData}
          />

          <Caption1>{selected.length} tag(s) selected</Caption1>
          <div className={styles.spacer} />
        </div>

        <PageIntro
          title="Live view"
          overview={EXPLAINERS.liveview.overview}
          interpretation={EXPLAINERS.liveview.interpretation}
          technical={EXPLAINERS.liveview.technical}
        />

        <div className={styles.body}>
          <Card className={styles.sidebar}>
            <Subtitle2>Tags</Subtitle2>
            <TagBrowser tags={tags} selected={selected} onChange={setSelected} />
          </Card>

          <div className={styles.content}>
            <Card className={styles.card}>
              <Subtitle2>Trailing window &amp; resolution</Subtitle2>
              <div style={{ marginTop: tokens.spacingVerticalM }}>
                <AdaptiveBinningPanel
                  relativeOnly
                  relSpec={relSpec}
                  onRelSpecChange={setRelSpec}
                  range={range}
                  onRangeChange={setRange}
                  rangeInfo={EXPLAINERS.liveview.inputs?.window}
                  settings={binning}
                  onChange={patchBinning}
                  densityTagIds={selected}
                  densityEnabled={enabled}
                />
              </div>
            </Card>

            <Card className={styles.card}>
              <div className={styles.cardActions}>
                <Subtitle2>Live chart</Subtitle2>
              </div>
              {annot.selecting && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    Drag across the chart to select a time range, or click a single point, then
                    fill in the annotation details. Auto-refresh is paused while you select.
                  </MessageBarBody>
                </MessageBar>
              )}
              {annot.error && (
                <MessageBar intent="error">
                  <MessageBarBody>{annot.error}</MessageBarBody>
                </MessageBar>
              )}
              {hasData ? (
                <>
                  <OutputDescription label="Live chart">
                    {EXPLAINERS.liveview.outputs!.chart}
                  </OutputDescription>
                  <ChartFrame
                    option={annotatedOption}
                    height={360}
                    fileName="live-view"
                    data={() => exploreSeriesToChartData(series, nameById)}
                    chartRef={annot.chartRef}
                    onEvents={{ brushEnd: annot.onBrushEndEvent }}
                    actions={
                      <>
                        <ToggleButton
                          appearance="subtle"
                          size="small"
                          icon={<CommentAdd24Regular />}
                          checked={annot.selecting}
                          disabled={!annot.currentUserId || !hasData}
                          title={
                            annot.currentUserId
                              ? 'Pick a time range or point on the chart to annotate'
                              : 'Sign in with Fabric to add annotations'
                          }
                          onClick={() =>
                            annot.selecting ? annot.cancelSelecting() : annot.beginSelecting()
                          }
                        >
                          {annot.selecting ? 'Selecting…' : 'Annotate'}
                        </ToggleButton>
                        <TimelineMarkersButton
                          annot={annot}
                          showOnChart={showOnChart}
                          onToggleShowOnChart={setShowOnChart}
                        />
                      </>
                    }
                  />
                </>
              ) : (
                <Body1>
                  {enabled
                    ? 'Waiting for data\u2026'
                    : 'Pick one or more tags to start streaming.'}
                </Body1>
              )}
            </Card>

            {hasData && (
              <Card className={styles.card}>
                <OutputDescription label="Descriptive statistics">
                  {EXPLAINERS.liveview.outputs!.statistics}
                </OutputDescription>
                <StatisticsPanel series={series} nameById={nameById} descriptiveOnly />
              </Card>
            )}
          </div>
        </div>
      </div>

      {annot.dialogInitial && (
        <AnnotationDialog
          open={annot.dialogOpen}
          mode={annot.dialogMode}
          tags={tags}
          initial={annot.dialogInitial}
          onClose={annot.closeDialog}
          onSaved={annot.reload}
        />
      )}
    </div>
  );
}
