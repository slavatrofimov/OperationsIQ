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
import { buildChangePointsQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseChangePoint, type ChangePoint, type ChangeKind } from '../lib/changePoints';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
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
import { formatQueryInstant } from '../lib/timezone';
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
  controls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  card: { padding: tokens.spacingVerticalL },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  spacer: { flex: 1 },
  stats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS, alignItems: 'center' },
});

const MODEL_NAME = 'series_fit_2lines';
const MODEL_VERSION = '1';

interface ChangePointResult {
  changePoint: ChangePoint;
  binSeconds: number;
}

const KIND_LABEL: Record<ChangeKind, string> = {
  'level-shift': 'Level shift',
  'slope-break': 'Slope break',
  mixed: 'Level shift + slope break',
  none: 'No material change',
};

/**
 * Change points workspace. Fits two line segments to a single signal via
 * `series_fit_2lines` and marks the single best break — a level shift or a
 * change in trend rate — with the two fitted segments overlaid and a badge for
 * the split strength (R-square) and the kind of change detected.
 */
export function ChangePointsPage({ tags }: { tags: TagInfo[] }) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });
  const binning = usePageBinning();
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        { title: 'Time range', fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }] },
        { title: 'Configuration', fields: [...binningFields(binning.settings)] },
      ],
    };
  }, [tag, nameById, range, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (tagId: string, r: TimeRange, s: BinningSettings): Promise<ChangePointResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const table = await executeKql(
        buildChangePointsQuery({
          tagId,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );
      const changePoint = parseChangePoint(table);
      if (!changePoint) return null;
      return { changePoint, binSeconds: (bin.millis / 1000) };
    },
  );

  const analyze = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings).catch(() => {});
  };

  const result = state.data;

  useControlledPage({
    pageKey: 'changepoints',
    title: 'Change points',
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
    const cp = result.changePoint;
    const p = buildProvenance({
      outputType: 'signal_validation',
      tagId: cp.tagId,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: cp.splitTime != null ? new Date(cp.splitTime) : range.end,
      summary: {
        kind: cp.kind,
        rSquare: cp.rSquare,
        splitTime: cp.splitTime != null ? new Date(cp.splitTime).toISOString() : null,
        levelShift: cp.levelShift,
        slopeDeltaPerBin: cp.slopeDelta,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const cp = result.changePoint;
    const axis = cp.t;
    const valuePts = axis.map((t, i) => [t, cp.value[i] ?? null]);
    // Split the fitted line at the break so the two segments read as distinct.
    const leftFit = axis.map((t, i) => [t, i <= cp.splitIdx ? cp.lineFit[i] ?? null : null]);
    const rightFit = axis.map((t, i) => [t, i >= cp.splitIdx ? cp.lineFit[i] ?? null : null]);
    const series: echarts.SeriesOption[] = [
      {
        name: 'Signal',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.4, color: '#0f6cbd' },
        itemStyle: { color: '#0f6cbd' },
        data: valuePts,
      },
      {
        name: 'Segment 1',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 2, color: '#8764b8' },
        itemStyle: { color: '#8764b8' },
        data: leftFit,
        markLine:
          cp.splitTime != null
            ? {
                symbol: 'none',
                silent: true,
                lineStyle: { color: '#a4262c', width: 1.5, type: 'dashed' },
                label: { formatter: 'Change point', position: 'insideEndTop', color: '#a4262c' },
                data: [{ xAxis: cp.splitTime }],
              }
            : undefined,
      },
      {
        name: 'Segment 2',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 2, color: '#038387' },
        itemStyle: { color: '#038387' },
        data: rightFit,
      },
    ];
    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      legend: { top: 0 },
      grid: { left: 60, right: 24, top: 36, bottom: 56 },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', scale: true },
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', bottom: 8, height: 18 },
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
    const cp = result.changePoint;
    return {
      columns: ['Timestamp', 'Value', 'Fit'],
      rows: cp.t.map((t, i) => [new Date(t).toISOString(), cp.value[i] ?? null, cp.lineFit[i] ?? null]),
    };
  };

  const cp = result?.changePoint ?? null;
  const strengthColor = cp && cp.rSquare >= 0.75 ? 'success' : cp && cp.rSquare >= 0.4 ? 'warning' : 'subtle';

  return (
    <div className={styles.root}>
      <Subtitle1>Change points</Subtitle1>

      <PageIntro
        title="Change points"
        overview={EXPLAINERS.changepoints.overview}
        interpretation={EXPLAINERS.changepoints.interpretation}
        technical={EXPLAINERS.changepoints.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.changepoints.inputs!.tag} />
        </div>
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
          {state.loading ? <Spinner size="tiny" /> : 'Detect change point'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && cp && (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Body1>{labeler(cp.tagId, nameById.get(cp.tagId))}</Body1>
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
          <OutputDescription label="Fitted two-line model">
            {EXPLAINERS.changepoints.outputs!.chart}
          </OutputDescription>
          <ChartFrame
            option={annotatedOption}
            height={460}
            fileName="change-points"
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
          <div className={styles.stats}>
            <Badge appearance="filled" color={cp.kind === 'none' ? 'subtle' : 'brand'}>
              {KIND_LABEL[cp.kind]}
            </Badge>
            <Badge appearance="tint" color={strengthColor}>
              Split strength R² {cp.rSquare.toFixed(2)}
            </Badge>
            {cp.splitTime != null && (
              <Badge appearance="tint" color="informative">
                Break at {formatQueryInstant(cp.splitTime)}
              </Badge>
            )}
            <Caption1>
              Level shift {cp.levelShift.toFixed(tooltipDecimals)} · slope Δ {cp.slopeDelta.toFixed(tooltipDecimals)}/bin ·{' '}
              {result.binSeconds >= 3600
                ? `${(result.binSeconds / 3600).toFixed(1)}h bins`
                : `${(result.binSeconds / 60).toFixed(1)}m bins`}
            </Caption1>
          </div>
          <OutputDescription label="Change summary">
            {EXPLAINERS.changepoints.outputs!.stats}
          </OutputDescription>
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
