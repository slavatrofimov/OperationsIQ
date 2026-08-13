import { useEffect, useMemo, useState } from 'react';
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
  Card,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildDecompositionQuery, buildPeriodsQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseDecomposition, residualStats, type Decomposition } from '../lib/decompose';
import {
  parseDetectedPeriods,
  periodToSeasonalityBins,
  type DetectedPeriod,
} from '../lib/periods';
import { SeasonalityDetector } from '../components/SeasonalityDetector';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
import { withInfo } from '../components/fieldInfo';
import { type TimeRange } from '../components/TimeRangePicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { ChartFrame } from '../components/ChartFrame';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { ProvenanceChip } from '../components/ProvenanceChip';
import { buildProvenance, writeModelOutput, FEATURE_VERSION, type Provenance } from '../lib/provenance';
import type { ChartData } from '../lib/export';
import { usePageBinning } from '../context/BinningContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
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
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  spacer: { flex: 1 },
  num: { width: '120px' },
  stats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
});

const DECOMP_MODEL_NAME = 'series_decompose';
const DECOMP_MODEL_VERSION = '1';

interface DecompResult {
  decomposition: Decomposition;
  binSeconds: number;
}

const PANELS: { key: keyof Pick<Decomposition, 'value' | 'trend' | 'seasonal' | 'residual'>; title: string; color: string }[] = [
  { key: 'value', title: 'Signal + baseline', color: '#0f6cbd' },
  { key: 'trend', title: 'Trend', color: '#8764b8' },
  { key: 'seasonal', title: 'Seasonal', color: '#038387' },
  { key: 'residual', title: 'Residual', color: '#a4262c' },
];

export interface DecompositionPageProps {
  tags: TagInfo[];
}

/**
 * Decomposition workspace (functional spec §Decomposition). Splits a signal
 * into trend, seasonal, and residual components via `series_decompose` and
 * shows four synchronized panels sharing a time axis. Helps distinguish drift
 * (trend) from cycles (seasonal) from transients/anomalies (residual).
 */
export function DecompositionPage({ tags }: DecompositionPageProps) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const binning = usePageBinning();
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  // Seasonality period in bins passed to series_decompose. null = auto-detect
  // (KQL -1). Populated one-click from the "Detect cycles" chips.
  const [seasonality, setSeasonality] = useState<number | null>(null);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });
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
          title: 'Configuration',
          fields: [
            ...binningFields(binning.settings),
            {
              label: 'Seasonality',
              value: seasonality == null ? 'Auto-detect' : `${seasonality} bins`,
            },
          ],
        },
      ],
    };
  }, [tag, nameById, range, binning.settings, seasonality]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      s: BinningSettings,
      seasonalityBins: number | null,
    ): Promise<DecompResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const table = await executeKql(
        buildDecompositionQuery({
          tagId,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
          seasonality: seasonalityBins ?? -1,
        }),
      );
      const decomposition = parseDecomposition(table);
      if (!decomposition) return null;
      return { decomposition, binSeconds: (bin.millis / 1000) };
    },
  );

  const analyze = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings, seasonality).catch(() => {});
  };

  // Run series_periods_detect over the same binned window the decomposition uses,
  // so detected periods are expressed in the same bins the seasonality control expects.
  const detectCycles = async (): Promise<DetectedPeriod[]> => {
    const tagId = tag[0];
    if (!tagId) return [];
    const bin = chooseBinFor({ start: range.start, end: range.end }, binning.settings);
    const table = await executeKql(
      buildPeriodsQuery({
        tagId,
        start: range.start,
        end: range.end,
        binKql: bin.kql,
        aggregation: binning.settings.aggregation,
      }),
    );
    return parseDetectedPeriods(table, bin.millis);
  };

  // Apply a detected cycle as the seasonality and immediately re-decompose.
  const applyPeriod = (p: DetectedPeriod) => {
    const bins = periodToSeasonalityBins(p);
    setSeasonality(bins);
    if (tag[0]) run(tag[0], range, binning.settings, bins).catch(() => {});
  };

  const result = state.data;
  const stats = useMemo(() => (result ? residualStats(result.decomposition) : null), [result]);

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'decompose',
    title: 'Decomposition',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
    ],
    canRun: tag.length > 0 && !state.loading,
    run: analyze,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  useEffect(() => {
    if (!result) return;
    const p = buildProvenance({
      outputType: 'signal_validation',
      tagId: result.decomposition.tagId,
      modelName: DECOMP_MODEL_NAME,
      modelVersion: DECOMP_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        ...(stats ? (stats as unknown as Record<string, unknown>) : {}),
        seasonality: seasonality == null ? 'auto' : seasonality,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const d = result.decomposition;
    const axis = d.t;
    const rows = PANELS.length;
    const topPct = 4;
    const bottomPct = 10;
    const gap = 4;
    const avail = 100 - topPct - bottomPct - gap * (rows - 1);
    const h = avail / rows;
    const grids = PANELS.map((_, i) => ({
      left: 60,
      right: 24,
      top: `${topPct + i * (h + gap)}%`,
      height: `${h}%`,
    }));
    const xAxes = PANELS.map((_, i) => ({
      type: 'time' as const,
      gridIndex: i,
      axisLabel: { show: i === rows - 1 },
    }));
    const yAxes = PANELS.map((_, i) => ({ type: 'value' as const, gridIndex: i, scale: true }));
    const series = PANELS.flatMap((panel, i) => {
      const pts = axis.map((t, j) => [t, d[panel.key][j] ?? null]);
      const arr: echarts.SeriesOption[] = [
        {
          name: panel.title,
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          lineStyle: { width: 1.4, color: panel.color },
          itemStyle: { color: panel.color },
          data: pts,
        },
      ];
      // Overlay the baseline on the top panel for context.
      if (panel.key === 'value') {
        arr.push({
          name: 'Baseline',
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#605e5c' },
          data: axis.map((t, j) => [t, d.baseline[j] ?? null]),
        });
      }
      // Zero reference line on the residual panel.
      if (panel.key === 'residual') {
        arr.push({
          name: 'zero',
          type: 'line',
          xAxisIndex: i,
          yAxisIndex: i,
          showSymbol: false,
          silent: true,
          lineStyle: { width: 1, color: '#c8c6c4' },
          data: axis.map((t) => [t, 0]),
        });
      }
      return arr;
    });
    return {
      animation: false,
      title: PANELS.map((panel, i) => ({
        text: panel.title,
        left: 60,
        top: grids[i].top,
        textStyle: { fontSize: 12, fontWeight: 600 },
      })),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: PANELS.map((_, i) => i) },
        { type: 'slider', xAxisIndex: PANELS.map((_, i) => i), bottom: 8, height: 18 },
      ],
      series,
    };
  }, [result, tooltipDecimals]);

  const annotatedOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(option, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: range.start.getTime(),
        fullEnd: range.end.getTime(),
      }),
    [option, annot.chartMarkers, annot.selecting, range],
  );

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    const d = result.decomposition;
    return {
      columns: ['Timestamp', 'Value', 'Trend', 'Seasonal', 'Residual'],
      rows: d.t.map((t, i) => [
        new Date(t).toISOString(),
        d.value[i] ?? null,
        d.trend[i] ?? null,
        d.seasonal[i] ?? null,
        d.residual[i] ?? null,
      ]),
    };
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Decomposition</Subtitle1>

      <PageIntro
        title="Decomposition"
        overview={EXPLAINERS.decompose.overview}
        interpretation={EXPLAINERS.decompose.interpretation}
        technical={EXPLAINERS.decompose.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.decompose.inputs!.tag} />
        </div>
        <Field label={withInfo('Seasonality (bins)', EXPLAINERS.decompose.inputs!.seasonality)}>
          <Input
            className={styles.num}
            type="number"
            min={0}
            placeholder="auto"
            value={seasonality == null ? '' : String(seasonality)}
            onChange={(_, d) => {
              const v = d.value.trim();
              if (v === '') return setSeasonality(null);
              const n = Number(v);
              setSeasonality(Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);
            }}
          />
        </Field>
        <SeasonalityDetector
          detect={detectCycles}
          onApply={applyPeriod}
          disabled={tag.length === 0 || state.loading}
          appliedBins={seasonality}
        />
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={analyze}>
          {state.loading ? <Spinner size="tiny" /> : 'Decompose'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Body1>{labeler(result.decomposition.tagId, nameById.get(result.decomposition.tagId))}</Body1>
            <div className={styles.spacer} />
            {provenance && <ProvenanceChip provenance={provenance} />}
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
          <OutputDescription label="Decomposition panels">
            {EXPLAINERS.decompose.outputs!.chart}
          </OutputDescription>
          <ChartFrame
            option={annotatedOption}
            height={640}
            fileName="decomposition"
            data={chartData}
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
          {stats && (
            <div className={styles.stats}>
              <Badge appearance="tint" color="brand">
                Variance explained {(stats.varianceExplained * 100).toFixed(1)}%
              </Badge>
              <Badge appearance="tint" color="informative">
                Residual σ {stats.residualStdDev.toFixed(3)}
              </Badge>
              <Badge appearance="tint" color={stats.maxResidualZ > 3 ? 'danger' : 'subtle'}>
                Max residual {stats.maxResidualZ.toFixed(1)}σ
              </Badge>
              <Caption1>
                {result.binSeconds >= 3600
                  ? `${(result.binSeconds / 3600).toFixed(1)}h bins`
                  : `${(result.binSeconds / 60).toFixed(1)}m bins`}
              </Caption1>
            </div>
          )}
          {stats && (
            <OutputDescription label="Decomposition statistics">
              {EXPLAINERS.decompose.outputs!.stats}
            </OutputDescription>
          )}
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
    </div>
  );
}
