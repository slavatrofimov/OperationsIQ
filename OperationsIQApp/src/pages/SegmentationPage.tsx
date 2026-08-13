import { useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields } from '../lib/captureContextHelpers';
import * as echarts from 'echarts';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Subtitle1,
  Subtitle2,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildCycleExtractionQuery } from '../lib/kql';
import { executeKql, rowsToObjects } from '../lib/eventhouse';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { usePageBinning } from '../context/BinningContext';
import { EChart } from '../components/EChart';
import { ChartFrame } from '../components/ChartFrame';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { withInfo } from '../components/fieldInfo';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { TIME_AXIS_LABEL } from '../lib/exploreSettings';
import { PALETTE } from '../lib/series';
import { toSax, clusterCycles, type Cluster } from '../lib/segmentation';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  spacer: { flex: 1 },
  controls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  card: { padding: tokens.spacingVerticalL },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  num: { width: '100px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingVerticalM,
  },
  cycleCard: {
    cursor: 'pointer',
    transition: 'all 0.2s',
    '&:hover': {
      transform: 'scale(1.02)',
      boxShadow: tokens.shadow8,
    },
  },
  clusterBadge: { marginRight: tokens.spacingHorizontalS },
});

const CYCLE_DURATIONS = [
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: '8h', label: '8 hours (shift)' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '1 week' },
];

/** Above this many cycles, boundary labels are hidden to avoid clutter. */
const MAX_BOUNDARY_LABELS = 40;

interface CycleRow {
  CycleIndex: number;
  CycleStart: string;
  series: (number | null)[];
}

interface CycleData {
  index: number;
  start: Date;
  series: number[];
  saxWord: string;
  clusterId: number;
}

interface SegmentationResult {
  tagId: string;
  cycles: CycleData[];
  clusters: Cluster[];
  fullSignalStart: Date;
  fullSignalEnd: Date;
}

export interface SegmentationPageProps {
  tags: TagInfo[];
}

/** Curve segmentation & clustering with SAX-based pattern recognition. */
export function SegmentationPage({ tags }: SegmentationPageProps) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });
  const binning = usePageBinning({ maxBins: 200 });
  const [cycleDuration, setCycleDuration] = useState('1d');
  const [paaSize, setPaaSize] = useState(8);
  const [alphabetSize, setAlphabetSize] = useState(5);
  const [numClusters, setNumClusters] = useState(3);
  const [, setSelectedCycle] = useState<number | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Segmentation settings',
          fields: [
            { label: 'Cycle duration', value: cycleDuration },
            { label: 'PAA size', value: String(paaSize) },
            { label: 'Alphabet size', value: String(alphabetSize) },
            { label: 'Clusters', value: String(numClusters) },
            {
              label: 'Selected cluster',
              value: selectedCluster != null ? String(selectedCluster) : 'None',
            },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [
    tag,
    nameById,
    range,
    cycleDuration,
    paaSize,
    alphabetSize,
    numClusters,
    selectedCluster,
    binning.settings,
  ]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      s: BinningSettings,
      cycleDur: string,
      paa: number,
      alpha: number,
      k: number,
    ): Promise<SegmentationResult> => {
      // Adaptive bin for cycle detail
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);

      const table = await executeKql(
        buildCycleExtractionQuery({
          tagId,
          start: r.start,
          end: r.end,
          cycleDuration: cycleDur,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );

      const rows = rowsToObjects<CycleRow>(table);
      const cycles: CycleData[] = rows.map((row) => {
        const series = (row.series ?? []).filter((v): v is number => v != null);
        const saxWord = toSax(series, paa, alpha);
        return {
          index: row.CycleIndex,
          start: new Date(row.CycleStart),
          series,
          saxWord,
          clusterId: 0, // Will be assigned by clustering
        };
      });

      // Perform clustering
      const clusters = clusterCycles(cycles, k, alpha, cycles[0]?.series.length ?? 100);

      // Assign cluster IDs to cycles
      const cycleClusterMap = new Map<number, number>();
      clusters.forEach((cluster) => {
        cluster.members.forEach((idx) => {
          cycleClusterMap.set(idx, cluster.clusterId);
        });
      });

      cycles.forEach((cycle) => {
        cycle.clusterId = cycleClusterMap.get(cycle.index) ?? 0;
      });

      return {
        tagId,
        cycles,
        clusters,
        fullSignalStart: r.start,
        fullSignalEnd: r.end,
      };
    },
  );

  const load = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings, cycleDuration, paaSize, alphabetSize, numClusters).catch(
      () => {},
    );
  };

  const result = state.data;

  useControlledPage({
    pageKey: 'segmentation',
    title: 'Segmentation',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf(
          'cycleDuration',
          'Cycle duration',
          cycleDuration,
          CYCLE_DURATIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) =>
          setCycleDuration(
            coerce.enumValue(
              v,
              CYCLE_DURATIONS.map((o) => o.value),
            ) as string,
          ),
      },
      {
        field: pf.integer('paaSize', 'PAA size', paaSize, {
          min: 3,
          max: 20,
          description: 'Number of PAA segments used before SAX encoding.',
        }),
        apply: (v) => setPaaSize(coerce.integer(v, { min: 3, max: 20 })),
      },
      {
        field: pf.integer('alphabetSize', 'Alphabet size', alphabetSize, {
          min: 3,
          max: 8,
          description: 'SAX alphabet size.',
        }),
        apply: (v) => setAlphabetSize(coerce.integer(v, { min: 3, max: 8 })),
      },
      {
        field: pf.integer('numClusters', 'Clusters (K)', numClusters, {
          min: 2,
          max: 12,
          description: 'Number of clusters to produce.',
        }),
        apply: (v) => setNumClusters(coerce.integer(v, { min: 2, max: 12 })),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: load,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  // Build overview chart with cycle boundaries and cluster coloring
  const overviewOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || result.cycles.length === 0) return {};

    // Build full signal by concatenating all cycles
    const allData: [number, number][] = [];
    result.cycles.forEach((cycle) => {
      const cycleStart = cycle.start.getTime();
      const step = 60000; // Approximate 1-minute step for viz
      cycle.series.forEach((val, i) => {
        allData.push([cycleStart + i * step, val]);
      });
    });

    // Build markLines for cycle boundaries, labeled with each cycle's cluster
    const showBoundaryLabels = result.cycles.length <= MAX_BOUNDARY_LABELS;
    const markLineData = result.cycles.map((cycle) => ({
      xAxis: cycle.start.getTime(),
      lineStyle: { type: 'dashed' as const, color: tokens.colorNeutralStroke2 },
      label: {
        show: showBoundaryLabels,
        formatter: `C${cycle.clusterId}`,
        position: 'end' as const,
        color: PALETTE[cycle.clusterId % PALETTE.length],
        fontSize: 10,
      },
    }));

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          type: 'line',
          showSymbol: false,
          data: allData,
          lineStyle: { width: 1 },
          markLine: {
            symbol: 'none',
            data: markLineData,
            silent: true,
          },
        },
      ],
    };
  }, [result, tooltipDecimals]);

  const annotatedOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(overviewOption, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: range.start.getTime(),
        fullEnd: range.end.getTime(),
      }),
    [overviewOption, annot.chartMarkers, annot.selecting, range],
  );

  // Build small-multiples grid
  const cycleCharts = useMemo(() => {
    if (!result) return [];

    return result.cycles.slice(0, 50).map((cycle) => {
      const clusterColor = PALETTE[cycle.clusterId % PALETTE.length];
      const data: [number, number][] = cycle.series.map((val, i) => [i, val]);

      const option: echarts.EChartsCoreOption = {
        animation: false,
        grid: { left: 32, right: 8, top: 16, bottom: 32 },
        xAxis: { type: 'value', show: false },
        yAxis: { type: 'value', scale: true },
        series: [
          {
            type: 'line',
            showSymbol: false,
            data,
            lineStyle: { color: clusterColor, width: 2 },
          },
        ],
      };

      return { cycle, option, clusterColor };
    });
  }, [result]);

  // Build cluster overlay view
  const clusterOverlayOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || selectedCluster === null) return {};

    const cluster = result.clusters.find((c) => c.clusterId === selectedCluster);
    if (!cluster) return {};

    const memberCycles = cluster.members
      .map((idx) => result.cycles.find((c) => c.index === idx))
      .filter((c): c is CycleData => c != null);

    const centroidCycle = result.cycles.find((c) => c.index === cluster.centroidIndex);

    const series: echarts.SeriesOption[] = memberCycles.map((cycle) => ({
      type: 'line',
      showSymbol: false,
      data: cycle.series.map((val, i) => [i, val]),
      lineStyle: { width: 1, color: PALETTE[cluster.clusterId % PALETTE.length], opacity: 0.4 },
    }));

    if (centroidCycle) {
      series.push({
        type: 'line',
        showSymbol: false,
        data: centroidCycle.series.map((val, i) => [i, val]),
        lineStyle: { width: 3, color: PALETTE[cluster.clusterId % PALETTE.length] },
      });
    }

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      xAxis: { type: 'value', name: 'Time (bin index)' },
      yAxis: { type: 'value', scale: true },
      series,
    };
  }, [result, selectedCluster, tooltipDecimals]);

  const segmentationChartData = (): ChartData => ({
    columns: ['cycle_index', 'cycle_start', 'cluster_id', 'sax_word'],
    rows:
      result?.cycles.map((cycle) => [
        cycle.index,
        cycle.start.toISOString(),
        cycle.clusterId,
        cycle.saxWord,
      ]) ?? [],
  });

  const clusterOverlayChartData = (): ChartData => {
    if (!result || selectedCluster === null) return { columns: [], rows: [] };
    const cluster = result.clusters.find((c) => c.clusterId === selectedCluster);
    if (!cluster) return { columns: [], rows: [] };

    const memberCycles = cluster.members
      .map((idx) => result.cycles.find((c) => c.index === idx))
      .filter((c): c is CycleData => c != null);
    const centroidCycle = result.cycles.find((c) => c.index === cluster.centroidIndex);
    const plottedCycles =
      centroidCycle != null ? [...memberCycles, centroidCycle] : memberCycles;
    const maxLength = plottedCycles.reduce((max, cycle) => Math.max(max, cycle.series.length), 0);

    return {
      columns: [
        'BinIndex',
        ...memberCycles.map((cycle) => `Cycle ${cycle.index}`),
        ...(centroidCycle ? [`Centroid Cycle ${centroidCycle.index}`] : []),
      ],
      rows: Array.from({ length: maxLength }, (_, i) => [
        i,
        ...memberCycles.map((cycle) => cycle.series[i] ?? null),
        ...(centroidCycle ? [centroidCycle.series[i] ?? null] : []),
      ]),
    };
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Curve Segmentation &amp; Clustering</Subtitle1>

      <PageIntro
        title="Segmentation"
        overview={EXPLAINERS.segmentation.overview}
        interpretation={EXPLAINERS.segmentation.interpretation}
        technical={EXPLAINERS.segmentation.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.segmentation.inputs!.tag} />
        </div>
        <Field label={withInfo('Cycle duration', EXPLAINERS.segmentation.inputs!.cycleDuration)}>
          <Select
            value={cycleDuration}
            onChange={(_, d) => setCycleDuration(d.value as string)}
          >
            {CYCLE_DURATIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={withInfo('PAA size', EXPLAINERS.segmentation.inputs!.paaSize)} className={styles.num}>
          <Input
            type="number"
            min={3}
            max={20}
            value={String(paaSize)}
            onChange={(_, d) => {
              const n = Number(d.value);
              if (Number.isFinite(n) && n >= 3 && n <= 20) setPaaSize(Math.floor(n));
            }}
          />
        </Field>
        <Field label={withInfo('Alphabet (3-8)', EXPLAINERS.segmentation.inputs!.alphabetSize)} className={styles.num}>
          <Input
            type="number"
            min={3}
            max={8}
            value={String(alphabetSize)}
            onChange={(_, d) => {
              const n = Number(d.value);
              if (Number.isFinite(n) && n >= 3 && n <= 8) setAlphabetSize(Math.floor(n));
            }}
          />
        </Field>
        <Field label={withInfo('Clusters (K)', EXPLAINERS.segmentation.inputs!.clusters)} className={styles.num}>
          <Input
            type="number"
            min={2}
            max={12}
            value={String(numClusters)}
            onChange={(_, d) => {
              const n = Number(d.value);
              if (Number.isFinite(n) && n >= 2 && n <= 12) setNumClusters(Math.floor(n));
            }}
          />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
        rangeInfo={EXPLAINERS.segmentation.inputs!.range}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        disabled={state.loading}
        densityTagIds={tag}
        densityEnabled={!state.loading}
      />

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={load}>
          {state.loading ? <Spinner size="tiny" /> : 'Segment & Cluster'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {/* Full signal overview */}
      {result && result.cycles.length > 0 && (
        <Card className={styles.card}>
          <div className={styles.cardActions}>
            <Subtitle2>
              {labeler(result.tagId, nameById.get(result.tagId))} — {result.cycles.length} cycles
            </Subtitle2>
            <div className={styles.spacer} />
          </div>
          {annot.selecting && (
            <MessageBar intent="info">
              <MessageBarBody>
                Drag across the chart to select a time range, or click a single point, then fill in
                the annotation details.
              </MessageBarBody>
            </MessageBar>
          )}
          {annot.error && (
            <MessageBar intent="error">
              <MessageBarBody>{annot.error}</MessageBarBody>
            </MessageBar>
          )}
          <Caption1>
            Vertical dashed lines mark cycle boundaries; labels (e.g. C0) show each cycle&apos;s cluster.
          </Caption1>
          <OutputDescription label="Cycle overview">
            {EXPLAINERS.segmentation.outputs!.overview}
          </OutputDescription>
          <ChartFrame
            option={annotatedOption}
            height={300}
            fileName="segmentation"
            data={segmentationChartData}
            chartRef={annot.chartRef}
            onEvents={{ brushEnd: annot.onBrushEndEvent }}
            actions={
              <>
                <ToggleButton
                  appearance="subtle"
                  size="small"
                  icon={<CommentAdd24Regular />}
                  checked={annot.selecting}
                  disabled={!annot.currentUserId || !result}
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
        </Card>
      )}

      {/* Cluster summary */}
      {result && result.clusters.length > 0 && (
        <Card className={styles.card}>
          <Subtitle2>Cluster Summary</Subtitle2>
          <OutputDescription label="Cluster summary">
            {EXPLAINERS.segmentation.outputs!.clusterSummary}
          </OutputDescription>
          <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, marginTop: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
            {result.clusters.map((cluster) => {
              const color = PALETTE[cluster.clusterId % PALETTE.length];
              return (
                <Badge
                  key={cluster.clusterId}
                  appearance="filled"
                  color="brand"
                  style={{ backgroundColor: color, cursor: 'pointer' }}
                  onClick={() => setSelectedCluster(cluster.clusterId)}
                >
                  Cluster {cluster.clusterId + 1}: {cluster.members.length} cycles
                </Badge>
              );
            })}
          </div>
        </Card>
      )}

      {/* Cluster overlay view */}
      {result && selectedCluster !== null && (
        <Card className={styles.card}>
          <div className={styles.cardActions}>
            <Subtitle2>Cluster {selectedCluster + 1} Overlay</Subtitle2>
            <div className={styles.spacer} />
            <Button appearance="subtle" size="small" onClick={() => setSelectedCluster(null)}>
              Close
            </Button>
          </div>
          <Caption1>All member cycles overlaid (thick line = centroid).</Caption1>
          <OutputDescription label="Cluster overlay">
            {EXPLAINERS.segmentation.outputs!.clusterOverlay}
          </OutputDescription>
          <ChartFrame
            option={clusterOverlayOption}
            height={300}
            fileName="cluster_overlay"
            data={clusterOverlayChartData}
          />
        </Card>
      )}

      {/* Small-multiples grid */}
      {cycleCharts.length > 0 && (
        <Card className={styles.card}>
          <Subtitle2>Individual Cycles (showing first 50)</Subtitle2>
          <div className={styles.grid}>
            {cycleCharts.map(({ cycle, option, clusterColor }) => (
              <Card
                key={cycle.index}
                className={styles.cycleCard}
                style={{ border: `2px solid ${clusterColor}` }}
                onClick={() => setSelectedCycle(cycle.index)}
              >
                <Caption1>
                  Cycle {cycle.index} | SAX: {cycle.saxWord}
                </Caption1>
                <OutputDescription label="Individual cycle">
                  {EXPLAINERS.segmentation.outputs!.cycles}
                </OutputDescription>
                <EChart option={option} height={120} />
              </Card>
            ))}
          </div>
        </Card>
      )}

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

      {!result && !state.loading && (
        <Body1>Pick a tag, time range, and cycle parameters, then click Segment & Cluster.</Body1>
      )}
    </div>
  );
}