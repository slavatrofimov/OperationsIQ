import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  Body1,
  Button,
  Caption1,
  Card,
  Field,
  InlineDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  MessageBar,
  MessageBarBody,
  MessageBarActions,
  Spinner,
  Subtitle1,
  Subtitle2,
  Select,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Settings24Regular, Dismiss24Regular, ArrowDownload24Regular, Table24Regular, DataArea24Regular, CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { chooseBin } from '../lib/binning';
import { buildExploreQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, type ExploreSeries } from '../lib/series';
import { exploreSeriesToCsv, exploreSeriesToChartData, downloadText, downloadDataUrl, fileStamp } from '../lib/export';
import { useAsyncAction } from '../hooks/useAsync';
import { TagBrowser } from '../components/TagBrowser';
import { SettingsPanel } from '../components/SettingsPanel';
import { GlobalOverviewChart } from '../components/GlobalOverviewChart';
import { TimelineTable } from '../components/TimelineTable';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { DataTable } from '../components/DataTable';
import { ToggleButton } from '@fluentui/react-components';
import { DetailCharts } from '../components/DetailCharts';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { PREFERRED_MILLIS_MAX, formatResolution, type BinningSettings } from '../lib/binningSettings';
import { StatisticsPanel } from '../components/StatisticsPanel';
import { DistributionPanel } from '../components/DistributionPanel';
import { type TimeRange } from '../components/TimeRangePicker';
import { type SimilarityQuerySeed } from '../lib/appTypes';
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import {
  DEFAULT_SETTINGS,
  type ExploreSettings,
  LAYOUT_OPTIONS,
  AGGREGATION_OPTIONS,
} from '../lib/exploreSettings';
import { getFabricAccountId, ensureFabricSession } from '../lib/rayfinClient';
import {
  listViews,
  saveView,
  deleteView,
  type SavedViewSummary,
  type ExploreState,
} from '../lib/savedViews';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { withInfo } from '../components/fieldInfo';
import { EXPLAINERS } from '../lib/explainers';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, yesNo } from '../lib/captureContextHelpers';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import { tagField, rangeField } from '../hooks/pageControllerFields';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { toChartMs, fromChartMs } from '../lib/timezone';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { distinctMarkerTypes } from '../lib/timelineMarkers';

const useStyles = makeStyles({
  root: { display: 'flex', height: '100%', minHeight: 0 },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    overflowY: 'auto',
    // `overflowY: 'auto'` turns this into a scroll container whose box edges
    // clip content flush against them (per CSS, overflow-x also resolves to
    // 'auto'). A tiny padding keeps the child Card borders — the Tags sidebar's
    // left edge and the content cards' right/bottom edges — from being clipped.
    padding: tokens.spacingHorizontalXXS,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  spacer: { flex: 1 },
  body: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'flex-start', minWidth: 0 },
  sidebar: { width: '320px', flexShrink: 0, padding: tokens.spacingVerticalM },
  content: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: { padding: tokens.spacingVerticalL },
  cardActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
  selectionBar: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  tagField: { minWidth: '260px' },
});

interface GlobalResult {
  series: ExploreSeries[];
  range: TimeRange;
  tagIds: string[];
}

export interface ExplorePageProps {
  tags: TagInfo[];
  onUseAsQuery: (seed: SimilarityQuerySeed) => void;
}

export function ExplorePage({ tags, onUseAsQuery }: ExplorePageProps) {
  const styles = useStyles();

  const [selected, setSelected] = useSharedTags();
  const [range, setRange] = useSharedRange();
  const [settings, setSettings] = useState<ExploreSettings>(DEFAULT_SETTINGS);
  const [panelOpen, setPanelOpen] = useState(false);

  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [pattern, setPattern] = useState<{ start: Date; end: Date } | null>(null);
  const [patternTag, setPatternTag] = useState<string[]>([]);
  const [hasRun, setHasRun] = useState(false);
  const queriedRangeRef = useRef<TimeRange>(range);
  const [overviewAsTable, setOverviewAsTable] = useState(false);
  const [detailAsTable, setDetailAsTable] = useState(false);

  const [signedIn, setSignedIn] = useState<boolean>(() => !!getFabricAccountId());
  const [savedViews, setSavedViews] = useState<SavedViewSummary[]>([]);
  const [viewsBusy, setViewsBusy] = useState(false);
  const [viewsError, setViewsError] = useState<string | null>(null);

  // Establish (or confirm) the Fabric SSO session used for persistence so the
  // saved-views feature reflects the real sign-in state rather than a stale
  // synchronous read taken before the session hydrates.
  useEffect(() => {
    let cancelled = false;
    ensureFabricSession()
      .then((ok) => {
        if (!cancelled) setSignedIn(ok);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(!!getFabricAccountId());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();
  const tzOffset = useTimezoneOffset();
  const displayNameById = useMemo(
    () => new Map(tags.map((t) => [t.tagId, labeler(t.tagId, t.tagName)])),
    [tags, labeler],
  );

  const previewSignals = useMemo(
    () => selected.map((id) => ({ tagId: id, name: nameById.get(id) ?? id })),
    [selected, nameById],
  );

  const [globalState, runGlobal] = useAsyncAction(
    async (tagIds: string[], r: TimeRange, s: ExploreSettings): Promise<GlobalResult> => {
      const bin = chooseBin({
        start: r.start,
        end: r.end,
        maxBins: s.globalMaxBins,
        preferredMillis: s.preferredMillis ?? undefined,
      });
      const table = await executeKql(
        buildExploreQuery({
          tagIds,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
          sensitivity: s.sensitivity,
        }),
      );
      return { series: parseExploreRows(table), range: r, tagIds };
    },
  );

  const [detailState, runDetail] = useAsyncAction(
    async (tagIds: string[], startMs: number, endMs: number, s: ExploreSettings) => {
      const start = new Date(startMs);
      const end = new Date(endMs);
      const bin = chooseBin({
        start,
        end,
        maxBins: s.maxBins,
        preferredMillis: s.detailPreferredMillis ?? undefined,
      });
      const table = await executeKql(
        buildExploreQuery({
          tagIds,
          start,
          end,
          binKql: bin.kql,
          aggregation: s.detailAggregation,
          sensitivity: s.sensitivity,
        }),
      );
      return { series: parseExploreRows(table) };
    },
  );

  // Debounced detail fetch (brushing fires rapidly).
  const detailTimer = useRef<ReturnType<typeof setTimeout>>();
  const runDetailDebounced = (
    tagIds: string[],
    startMs: number,
    endMs: number,
    s: ExploreSettings,
    delay = 400,
  ) => {
    clearTimeout(detailTimer.current);
    detailTimer.current = setTimeout(() => {
      runDetail(tagIds, startMs, endMs, s).catch(() => {});
    }, delay);
  };


  const explore = () => {
    if (selected.length === 0) return;
    setHasRun(true);
    queriedRangeRef.current = range;
    setPattern(null);
    runGlobal(selected, range, settings).catch(() => {});
  };

  // When a global result arrives, reset the brush to the full range and fetch detail.
  // Annotations reload automatically inside useChartAnnotations when tagIds/range change.
  useEffect(() => {
    const g = globalState.data;
    if (!g || g.series.length === 0) return;
    const startMs = g.range.start.getTime();
    const endMs = g.range.end.getTime();
    setBrush({ start: startMs, end: endMs });
    runDetailDebounced(g.tagIds, startMs, endMs, settings, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalState.data]);

  // Re-run the overview query when overview-affecting settings change (after the
  // first Explore). This resets the brush to the full range and refetches detail.
  const firstSettingsRef = useRef(true);
  useEffect(() => {
    if (firstSettingsRef.current) {
      firstSettingsRef.current = false;
      return;
    }
    if (!hasRun || selected.length === 0) return;
    runGlobal(selected, queriedRangeRef.current, settings).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings.aggregation,
    settings.sensitivity,
    settings.globalMaxBins,
    settings.preferredMillis,
  ]);

  // Re-run only the detail query when detail-specific binning changes, keeping
  // the current overview brush intact (no full-range reset).
  const firstDetailSettingsRef = useRef(true);
  useEffect(() => {
    if (firstDetailSettingsRef.current) {
      firstDetailSettingsRef.current = false;
      return;
    }
    if (!hasRun || !brush) return;
    const tagIds = globalState.data?.tagIds ?? selected;
    if (tagIds.length === 0) return;
    runDetailDebounced(tagIds, brush.start, brush.end, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.detailAggregation, settings.maxBins, settings.detailPreferredMillis]);

  // The overview chart plots in chart/wall-clock space (its axis min/max and
  // brush props are shifted +offset). Its datazoom therefore reports the window
  // in chart space, so bring it back to real UTC before storing it as brush
  // state / feeding it to the detail query (which re-applies +offset in KQL).
  const handleBrush = (chartStartMs: number, chartEndMs: number) => {
    const startMs = fromChartMs(chartStartMs, tzOffset);
    const endMs = fromChartMs(chartEndMs, tzOffset);
    setBrush({ start: startMs, end: endMs });
    const tagIds = globalState.data?.tagIds ?? selected;
    runDetailDebounced(tagIds, startMs, endMs, settings);
  };

  const handleSelectPattern = (startSec: number, endSec: number) => {
    setPattern({ start: new Date(startSec * 1000), end: new Date(endSec * 1000) });
    const tagIds = globalState.data?.tagIds ?? selected;
    if (patternTag.length === 0 && tagIds.length > 0) setPatternTag([tagIds[0]]);
  };

  // --- saved views ---
  const refreshViews = () => {
    if (!signedIn) return;
    setViewsBusy(true);
    setViewsError(null);
    listViews()
      .then(setSavedViews)
      .catch((e) => setViewsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setViewsBusy(false));
  };

  useEffect(() => {
    refreshViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  const handleSaveView = (name: string) => {
    const state: ExploreState = { tagIds: selected, start: range.start, end: range.end, settings };
    setViewsBusy(true);
    setViewsError(null);
    saveView(name, state)
      .then(() => refreshViews())
      .catch((e) => {
        setViewsError(e instanceof Error ? e.message : String(e));
        setViewsBusy(false);
      });
  };

  const handleLoadView = (id: string) => {
    const v = savedViews.find((x) => x.id === id);
    if (!v) return;
    const start = new Date(v.config.start);
    const end = new Date(v.config.end);
    setSelected(v.config.tagIds);
    setRange({ start, end });
    setSettings(v.config.settings);
    setHasRun(true);
    queriedRangeRef.current = { start, end };
    setPattern(null);
    runGlobal(v.config.tagIds, { start, end }, v.config.settings).catch(() => {});
  };

  const handleDeleteView = (id: string) => {
    setViewsBusy(true);
    setViewsError(null);
    deleteView(id)
      .then(() => refreshViews())
      .catch((e) => {
        setViewsError(e instanceof Error ? e.message : String(e));
        setViewsBusy(false);
      });
  };

  const patchSettings = (patch: Partial<ExploreSettings>) => setSettings((s) => ({ ...s, ...patch }));

  // Independent binning views for the Overview and Detail areas, projected onto
  // the flat ExploreSettings shape (kept flat for deep-links / saved views).
  const overviewBinning: BinningSettings = {
    aggregation: settings.aggregation,
    maxBins: settings.globalMaxBins,
    preferredMillis: settings.preferredMillis,
  };
  const detailBinning: BinningSettings = {
    aggregation: settings.detailAggregation,
    maxBins: settings.maxBins,
    preferredMillis: settings.detailPreferredMillis,
  };
  const patchOverviewBinning = (p: Partial<BinningSettings>) =>
    setSettings((s) => ({
      ...s,
      ...(p.aggregation !== undefined ? { aggregation: p.aggregation } : {}),
      ...(p.maxBins !== undefined ? { globalMaxBins: p.maxBins } : {}),
      ...(p.preferredMillis !== undefined ? { preferredMillis: p.preferredMillis } : {}),
    }));
  const patchDetailBinning = (p: Partial<BinningSettings>) =>
    setSettings((s) => ({
      ...s,
      ...(p.aggregation !== undefined ? { detailAggregation: p.aggregation } : {}),
      ...(p.maxBins !== undefined ? { maxBins: p.maxBins } : {}),
      ...(p.preferredMillis !== undefined ? { detailPreferredMillis: p.preferredMillis } : {}),
    }));
  const setOverviewRange = (r: TimeRange) => {
    setRange(r);
  };

  const exportOverviewPng = () => {
    const url = annot.chartRef.current?.getDataURL();
    if (url) downloadDataUrl(`overview_${fileStamp()}.png`, url);
  };
  const exportSeriesCsv = (series: ExploreSeries[], prefix: string) => {
    const csv = exploreSeriesToCsv(series, nameById);
    if (csv) downloadText(`${prefix}_${fileStamp()}.csv`, csv);
  };

  const globalData = globalState.data;
  const detailSeries = detailState.data?.series ?? [];
  const busy = globalState.loading || detailState.loading;
  const error = globalState.error ?? detailState.error;
  const fullExtent = globalData
    ? { start: globalData.range.start.getTime(), end: globalData.range.end.getTime() }
    : null;

  // The Detail area's range is controlled by the overview brush (or the full
  // overview range when nothing is brushed) — shown read-only in its panel.
  const detailRange = useMemo<TimeRange>(() => {
    if (brush) return { start: new Date(brush.start), end: new Date(brush.end) };
    if (globalData) return globalData.range;
    return range;
  }, [brush, globalData, range]);

  const levels = useHierarchyLevels();

  // Reusable annotation orchestration (load/refresh, unified markers, dialog
  // state, brush-to-annotate) — shared with every other instrumented page.
  const annot = useChartAnnotations({
    tags,
    levels,
    tagIds: globalData?.tagIds ?? selected,
    range: globalData?.range ?? null,
    showMarkers: settings.showEvents,
    offsetMinutes: tzOffset,
    // No ECharts instance to arm while the overview is rendered as a table.
    suppressBrushArming: overviewAsTable,
  });
  const allMarkers = annot.allMarkers;
  // Markers inside the currently brushed window (or the whole overview range when
  // nothing is brushed) — this feeds the interactive table and the type filters.
  // A span marker counts as in-range when it overlaps the window at all.
  const rangeMarkers = useMemo(() => {
    const loReal = brush ? brush.start : fullExtent?.start ?? -Infinity;
    const hiReal = brush ? brush.end : fullExtent?.end ?? Infinity;
    // Markers arrive from KQL already in wall-clock/chart space, while
    // brush/fullExtent are real UTC — shift the comparison window into chart
    // space so the overlap test is done in a single consistent clock.
    const lo = Number.isFinite(loReal) ? toChartMs(loReal, tzOffset) : loReal;
    const hi = Number.isFinite(hiReal) ? toChartMs(hiReal, tzOffset) : hiReal;
    return allMarkers.filter((m) => {
      const s = m.timestamp.getTime();
      const e = (m.endTimestamp ?? m.timestamp).getTime();
      return s <= hi && e >= lo;
    });
  }, [allMarkers, brush, fullExtent, tzOffset]);
  // Distinct (source, type) groups present in range, for the filter toggles.
  const markerTypeGroups = useMemo(() => distinctMarkerTypes(rangeMarkers), [rangeMarkers]);
  const chartMarkers = annot.chartMarkers;

  // "Show/hide all" only affects the markers currently in view (the windowed
  // range), matching the table's own scope.
  const toggleAllMarkers = (visible: boolean) => {
    for (const m of rangeMarkers) annot.toggleMarker(m.id, visible);
  };

  const currentUserId = annot.currentUserId;

  useControlledPage({
    pageKey: 'explore',
    title: 'Explore',
    fields: [
      tagField({
        tags,
        current: selected,
        set: setSelected,
        multi: true,
        description: 'One or more signals to explore together.',
      }),
      rangeField({ current: range, set: setOverviewRange }),
      {
        field: pf.enumOf(
          'aggregation',
          'Overview aggregation',
          settings.aggregation,
          AGGREGATION_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          patchOverviewBinning({
            aggregation: coerce.enumValue(
              v,
              AGGREGATION_OPTIONS.map((o) => o.value),
            ) as BinningSettings['aggregation'],
          }),
      },
      {
        field: pf.integer('resolution', 'Overview resolution (ms)', settings.preferredMillis ?? 0, {
          min: 0,
          max: PREFERRED_MILLIS_MAX,
          description: 'Overview preferred bin width in milliseconds; 0 = auto.',
        }),
        apply: (v) => {
          const ms = coerce.integer(v, { min: 0, max: PREFERRED_MILLIS_MAX });
          patchOverviewBinning({ preferredMillis: ms > 0 ? ms : null });
        },
      },
      {
        field: pf.integer('overviewMaxBins', 'Overview max bins', settings.globalMaxBins, {
          min: 1,
          description: 'Maximum number of bins in the overview query.',
        }),
        apply: (v) => patchOverviewBinning({ maxBins: coerce.integer(v, { min: 1 }) }),
      },
      {
        field: pf.enumOf(
          'detailAggregation',
          'Detail aggregation',
          settings.detailAggregation,
          AGGREGATION_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          patchDetailBinning({
            aggregation: coerce.enumValue(
              v,
              AGGREGATION_OPTIONS.map((o) => o.value),
            ) as BinningSettings['aggregation'],
          }),
      },
      {
        field: pf.integer('detailResolution', 'Detail resolution (ms)', settings.detailPreferredMillis ?? 0, {
          min: 0,
          max: PREFERRED_MILLIS_MAX,
          description: 'Detail preferred bin width in milliseconds; 0 = auto.',
        }),
        apply: (v) => {
          const ms = coerce.integer(v, { min: 0, max: PREFERRED_MILLIS_MAX });
          patchDetailBinning({ preferredMillis: ms > 0 ? ms : null });
        },
      },
      {
        field: pf.integer('detailMaxBins', 'Detail max bins', settings.maxBins, {
          min: 1,
          description: 'Maximum number of bins in the detail query.',
        }),
        apply: (v) => patchDetailBinning({ maxBins: coerce.integer(v, { min: 1 }) }),
      },
      {
        field: pf.enumOf(
          'layout',
          'Chart layout',
          settings.layout,
          LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          patchSettings({
            layout: coerce.enumValue(v, LAYOUT_OPTIONS.map((o) => o.value)) as ExploreSettings['layout'],
          }),
      },
      {
        field: pf.boolean('sharedYAxis', 'Shared Y axis', settings.sharedYAxis),
        apply: (v) => patchSettings({ sharedYAxis: coerce.boolean(v) }),
      },
      {
        field: pf.boolean('smoothLines', 'Smooth lines', settings.smoothLines),
        apply: (v) => patchSettings({ smoothLines: coerce.boolean(v) }),
      },
      {
        field: pf.boolean('showAnomalies', 'Anomaly detection', settings.showAnomalies),
        apply: (v) => patchSettings({ showAnomalies: coerce.boolean(v) }),
      },
      {
        field: pf.number('sensitivity', 'Anomaly sensitivity', settings.sensitivity, {
          min: 0.5,
          max: 5,
          description: 'Anomaly sensitivity from 0.5 to 5; lower is more sensitive.',
        }),
        apply: (v) => patchSettings({ sensitivity: coerce.number(v, { min: 0.5, max: 5 }) }),
      },
      {
        field: pf.boolean('showBaseline', 'Decomposition baseline', settings.showBaseline),
        apply: (v) => patchSettings({ showBaseline: coerce.boolean(v) }),
      },
      {
        field: pf.boolean('showEvents', 'Event flags', settings.showEvents),
        apply: (v) => patchSettings({ showEvents: coerce.boolean(v) }),
      },
      {
        field: pf.boolean('showStatistics', 'Statistics panel', settings.showStatistics),
        apply: (v) => patchSettings({ showStatistics: coerce.boolean(v) }),
      },
      {
        field: pf.boolean('showDistributions', 'Distributions panel', settings.showDistributions),
        apply: (v) => patchSettings({ showDistributions: coerce.boolean(v) }),
      },
    ],
    canRun: selected.length > 0 && !busy,
    run: explore,
    loading: busy,
    error: error ?? undefined,
    hasResult: !!globalData && globalData.series.length > 0,
  });

  // Entry point for the Annotate button. In chart mode we arm a visual selection
  // on the overview so the user picks the time range/point directly; in table mode
  // (no chart to brush) we fall back to seeding from the focused detail window.
  const beginAnnotation = () => {
    if (!overviewAsTable && globalData && globalData.series.length > 0) {
      annot.beginSelecting();
      return;
    }
    const start = brush ? new Date(brush.start) : globalData ? globalData.range.start : new Date();
    const isSpan =
      !!brush &&
      !!fullExtent &&
      (brush.start !== fullExtent.start || brush.end !== fullExtent.end);
    const end = isSpan && brush ? new Date(brush.end) : null;
    annot.openCreate(start, end);
  };

  // Note: the shared `useChartAnnotations` hook arms/disarms the overview
  // chart's brush cursor internally (via `annot.chartRef`), gated by
  // `suppressBrushArming: overviewAsTable` passed above.

  // Publish the page's parameters so "Add to investigation" captures the
  // selected tags, time window, and configuration that the DOM snapshot strips.
  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (selected.length === 0) return null;

    const tagNames = selected.map((id) => nameById.get(id) ?? id);
    const aggLabel =
      AGGREGATION_OPTIONS.find((o) => o.value === settings.aggregation)?.label ??
      settings.aggregation;
    const detailAggLabel =
      AGGREGATION_OPTIONS.find((o) => o.value === settings.detailAggregation)?.label ??
      settings.detailAggregation;
    const layoutLabel =
      LAYOUT_OPTIONS.find((o) => o.value === settings.layout)?.label ?? settings.layout;

    const timeFields = [
      { label: 'Time window', value: fmtWindow(range.start, range.end) },
    ];
    if (brush && fullExtent && (brush.start !== fullExtent.start || brush.end !== fullExtent.end)) {
      timeFields.push({
        label: 'Detail window (brushed)',
        value: fmtWindow(new Date(brush.start), new Date(brush.end)),
      });
    }
    if (pattern) {
      timeFields.push({
        label: 'Selected pattern window',
        value: fmtWindow(pattern.start, pattern.end),
      });
    }

    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Selected tags', value: tagNames.join(', ') },
            { label: 'Tags selected', value: String(selected.length) },
          ],
        },
        { title: 'Time range', fields: timeFields },
        {
          title: 'Configuration',
          fields: [
            { label: 'Aggregation (overview)', value: aggLabel },
            { label: 'Aggregation (detail)', value: detailAggLabel },
            { label: 'Detail max bins', value: String(settings.maxBins) },
            { label: 'Overview max bins', value: String(settings.globalMaxBins) },
            {
              label: 'Preferred bin (overview)',
              value: settings.preferredMillis != null ? formatResolution(settings.preferredMillis) : 'Auto',
            },
            {
              label: 'Preferred bin (detail)',
              value:
                settings.detailPreferredMillis != null
                  ? formatResolution(settings.detailPreferredMillis)
                  : 'Auto',
            },
            { label: 'Layout', value: layoutLabel },
            { label: 'Shared Y axis', value: yesNo(settings.sharedYAxis) },
            { label: 'Smooth lines', value: yesNo(settings.smoothLines) },
            { label: 'Anomaly detection', value: yesNo(settings.showAnomalies) },
            { label: 'Anomaly sensitivity', value: String(settings.sensitivity) },
            { label: 'Decomposition baseline', value: yesNo(settings.showBaseline) },
            { label: 'Event flags', value: yesNo(settings.showEvents) },
            { label: 'Statistics panel', value: yesNo(settings.showStatistics) },
            { label: 'Distributions panel', value: yesNo(settings.showDistributions) },
          ],
        },
      ],
    };
  }, [
    selected,
    nameById,
    range,
    settings,
    brush,
    fullExtent,
    pattern,
  ]);
  useRegisterCaptureContext(captureSummary);

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <div className={styles.toolbar}>
          <Subtitle1>Explore</Subtitle1>

          <Caption1>{selected.length} tag(s) selected</Caption1>
          <div className={styles.spacer} />
          <Button
            appearance={panelOpen ? 'primary' : 'secondary'}
            icon={<Settings24Regular />}
            onClick={() => setPanelOpen((o) => !o)}
          >
            Configuration
          </Button>
        </div>

        <PageIntro
          title="Explore"
          overview={EXPLAINERS.explore.overview}
          interpretation={EXPLAINERS.explore.interpretation}
          technical={EXPLAINERS.explore.technical}
        />

        <div className={styles.body}>
          <Card className={styles.sidebar}>
            <Subtitle2>Tags</Subtitle2>
            <TagBrowser tags={tags} selected={selected} onChange={setSelected} />
          </Card>

          <div className={styles.content}>
            <Card className={styles.card}>
              <Subtitle2>Overview</Subtitle2>
              <div style={{ margin: `${tokens.spacingVerticalM} 0` }}>
                <AdaptiveBinningPanel
                  range={range}
                  onRangeChange={setOverviewRange}
                  signals={previewSignals}
                  contextRange={range}
                  rangeInfo={EXPLAINERS.explore.inputs?.timeRange}
                  settings={overviewBinning}
                  onChange={patchOverviewBinning}
                  disabled={busy}
                  densityTagIds={selected}
                  densityEnabled={!busy}
                />
              </div>
              <div className={styles.actionRow}>
                <Button appearance="primary" disabled={selected.length === 0 || busy} onClick={explore}>
                  {busy ? <Spinner size="tiny" /> : 'Explore'}
                </Button>
              </div>
              {error && (
                <ErrorMessageBar error={error} />
              )}
              {globalData && globalData.series.length > 0 && fullExtent ? (
                <>
                  <div className={styles.cardActions}>
                    <Caption1>Drag the slider below the chart to focus the detail view.</Caption1>
                    <div className={styles.spacer} />
                    <ToggleButton
                      appearance="subtle"
                      size="small"
                      icon={<CommentAdd24Regular />}
                      checked={annot.selecting}
                      disabled={!currentUserId}
                      title={
                        currentUserId
                          ? annot.selecting
                            ? 'Selecting a time range or point on the chart…'
                            : 'Pick a time range or point on the chart to annotate'
                          : 'Sign in with Fabric to add annotations'
                      }
                      onClick={() =>
                        annot.selecting ? annot.cancelSelecting() : beginAnnotation()
                      }
                    >
                      {annot.selecting ? 'Selecting…' : 'Annotate'}
                    </ToggleButton>
                    <ToggleButton
                      appearance="subtle"
                      size="small"
                      checked={overviewAsTable}
                      icon={overviewAsTable ? <DataArea24Regular /> : <Table24Regular />}
                      onClick={() => setOverviewAsTable((v) => !v)}
                    >
                      {overviewAsTable ? 'Chart' : 'Table'}
                    </ToggleButton>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ArrowDownload24Regular />}
                      onClick={() => exportSeriesCsv(globalData.series, 'overview')}
                    >
                      CSV
                    </Button>
                    {!overviewAsTable && (
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<ArrowDownload24Regular />}
                        onClick={exportOverviewPng}
                      >
                        PNG
                      </Button>
                    )}
                  </div>
                  {overviewAsTable ? (
                    <>
                      <OutputDescription label="Overview table">
                        {EXPLAINERS.explore.outputs!.overviewTable}
                      </OutputDescription>
                      <DataTable data={exploreSeriesToChartData(globalData.series, displayNameById)} />
                    </>
                  ) : (
                    <>
                      <OutputDescription label="Overview chart">
                        {EXPLAINERS.explore.outputs!.overviewChart}
                      </OutputDescription>
                      <GlobalOverviewChart
                        chartRef={annot.chartRef}
                        series={globalData.series}
                        nameById={nameById}
                        markers={chartMarkers}
                        settings={settings}
                        fullStart={toChartMs(fullExtent.start, tzOffset)}
                        fullEnd={toChartMs(fullExtent.end, tzOffset)}
                        brush={
                          brush
                            ? {
                                start: toChartMs(brush.start, tzOffset),
                                end: toChartMs(brush.end, tzOffset),
                              }
                            : null
                        }
                        onBrush={handleBrush}
                        brushEnabled={annot.selecting}
                        onBrushEnd={annot.handleBrushEndDates}
                      />
                      {annot.selecting && (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Drag across the chart to select a time range, or click a single
                            point, then fill in the annotation details.
                          </MessageBarBody>
                          <MessageBarActions>
                            <Button size="small" onClick={annot.cancelSelecting}>
                              Cancel
                            </Button>
                          </MessageBarActions>
                        </MessageBar>
                      )}
                      {annot.error && (
                        <MessageBar intent="error">
                          <MessageBarBody>{annot.error}</MessageBarBody>
                        </MessageBar>
                      )}
                      {settings.showEvents && (
                        <>
                          <OutputDescription label="Events &amp; annotations">
                            {EXPLAINERS.explore.outputs!.eventsTable}
                          </OutputDescription>
                          <TimelineTable
                            markers={rangeMarkers}
                            hiddenIds={annot.hiddenMarkerIds}
                            typeGroups={markerTypeGroups}
                            hiddenTypes={annot.hiddenTypes}
                            onToggle={annot.toggleMarker}
                            onToggleAll={toggleAllMarkers}
                            onToggleType={annot.toggleMarkerType}
                            currentUserId={currentUserId}
                            onEdit={annot.openEdit}
                            onDelete={annot.handleDeleteAnnotation}
                          />
                        </>
                      )}
                    </>
                  )}
                </>
              ) : (
                <Body1>
                  {globalState.loading
                    ? 'Loading overview\u2026'
                    : 'Pick one or more tags, then choose Explore.'}
                </Body1>
              )}
            </Card>

            {(detailSeries.length > 0 || detailState.loading) && (
              <Card className={styles.card}>
                <div className={styles.cardActions}>
                  <Subtitle2>Detail</Subtitle2>
                  <div className={styles.spacer} />
                  {detailSeries.length > 0 && (
                    <>
                      <ToggleButton
                        appearance="subtle"
                        size="small"
                        checked={detailAsTable}
                        icon={detailAsTable ? <DataArea24Regular /> : <Table24Regular />}
                        onClick={() => setDetailAsTable((v) => !v)}
                      >
                        {detailAsTable ? 'Chart' : 'Table'}
                      </ToggleButton>
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<ArrowDownload24Regular />}
                        onClick={() => exportSeriesCsv(detailSeries, 'detail')}
                      >
                        CSV
                      </Button>
                    </>
                  )}
                </div>
                <div style={{ margin: `0 0 ${tokens.spacingVerticalM}` }}>
                  <AdaptiveBinningPanel
                    range={detailRange}
                    rangeReadOnly
                    rangeInfo="The detail window is set by dragging the slider on the Overview chart above."
                    settings={detailBinning}
                    onChange={patchDetailBinning}
                    disabled={busy}
                    densityTagIds={globalData?.tagIds ?? selected}
                    densityEnabled={!busy}
                  />
                </div>
                {detailState.loading && detailSeries.length === 0 ? (
                  <Body1>{'Loading detail\u2026'}</Body1>
                ) : detailAsTable ? (
                  <>
                    <OutputDescription label="Detail table">
                      {EXPLAINERS.explore.outputs!.detailTable}
                    </OutputDescription>
                    <DataTable data={exploreSeriesToChartData(detailSeries, displayNameById)} />
                  </>
                ) : (
                  <>
                    <OutputDescription label="Detail charts">
                      {EXPLAINERS.explore.outputs!.detailChart}
                    </OutputDescription>
                    <DetailCharts
                      series={detailSeries}
                      nameById={nameById}
                      settings={settings}
                      onSelect={handleSelectPattern}
                      selection={
                        pattern ? { start: pattern.start.getTime(), end: pattern.end.getTime() } : null
                      }
                    />
                  </>
                )}
              </Card>
            )}

            {pattern && (
              <div className={styles.selectionBar}>
                <Field label={withInfo('Query tag', EXPLAINERS.explore.inputs!.queryTag)} className={styles.tagField}>
                  <Select
                    value={patternTag[0] ?? ''}
                    onChange={(_, d) => setPatternTag(d.value ? [d.value] : [])}
                  >
                    <option value="">Select a tag</option>
                    {(globalData?.tagIds ?? selected).map((id) => (
                      <option key={id} value={id}>
                        {labeler(id, nameById.get(id))}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div>
                  <Caption1>Selection</Caption1>
                  <Body1>
                    {pattern.start.toISOString()} &rarr; {pattern.end.toISOString()}
                  </Body1>
                </div>
                <Button
                  appearance="primary"
                  disabled={patternTag.length === 0}
                  onClick={() =>
                    onUseAsQuery({
                      tagId: patternTag[0],
                      // `pattern` is in chart/wall-clock space (selected on the
                      // wall-clock detail axis); the Similarity seed feeds a query
                      // range that KQL re-shifts by +offset, so un-shift to real UTC.
                      start: new Date(fromChartMs(pattern.start.getTime(), tzOffset)),
                      end: new Date(fromChartMs(pattern.end.getTime(), tzOffset)),
                    })
                  }
                >
                  Find similar patterns
                </Button>
                <Button appearance="subtle" onClick={() => setPattern(null)}>
                  Clear
                </Button>
              </div>
            )}

            {settings.showStatistics && detailSeries.length > 0 && (
              <Card className={styles.card}>
                <OutputDescription label="Statistics panel">
                  {EXPLAINERS.explore.outputs!.statistics}
                </OutputDescription>
                <StatisticsPanel series={detailSeries} nameById={nameById} />
              </Card>
            )}

            {settings.showDistributions && detailSeries.length > 0 && (
              <Card className={styles.card}>
                <OutputDescription label="Distribution panel">
                  {EXPLAINERS.explore.outputs!.distributions}
                </OutputDescription>
                <DistributionPanel
                  series={detailSeries}
                  nameById={nameById}
                />
              </Card>
            )}
          </div>
        </div>
      </div>

      <InlineDrawer separator position="end" open={panelOpen} style={{ width: '360px' }}>
        <DrawerHeader>
          <DrawerHeaderTitle
            action={
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                aria-label="Close configuration"
                onClick={() => setPanelOpen(false)}
              />
            }
          >
            Configuration
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>
          <SettingsPanel
            settings={settings}
            onSettingsChange={patchSettings}
            savedViews={savedViews}
            savedViewsBusy={viewsBusy}
            savedViewsError={viewsError}
            signedIn={signedIn}
            onSaveView={handleSaveView}
            onLoadView={handleLoadView}
            onDeleteView={handleDeleteView}
          />
        </DrawerBody>
      </InlineDrawer>

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
