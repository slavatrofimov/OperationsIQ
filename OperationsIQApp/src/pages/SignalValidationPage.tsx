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
  Caption1,
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  Subtitle2,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { useTerminology } from '../hooks/useTerminology';
import { usePageBinning } from '../context/BinningContext';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildAlignedSeriesQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseAlignedSeries, type AlignedSeries } from '../lib/rootCause';
import { validateSignal, VERDICT_LABEL, type ValidationReport } from '../lib/signalValidation';
import { fireAlert, type AlertSeverity } from '../lib/alertCenter';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { ChartFrame } from '../components/ChartFrame';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { withInfo } from '../components/fieldInfo';
import { EXPLAINERS } from '../lib/explainers';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { ProvenanceChip } from '../components/ProvenanceChip';
import { buildProvenance, writeModelOutput, FEATURE_VERSION, type Provenance } from '../lib/provenance';
import type { ChartData } from '../lib/export';
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
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  num: { width: '120px' },
  stats: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', alignItems: 'center', marginTop: tokens.spacingVerticalS },
});

const MSET_MODEL_NAME = 'mset_linear_estimator';
const MSET_MODEL_VERSION = '1';

interface ValidationResult {
  report: ValidationReport;
  targetTagId: string;
}

const VERDICT_COLOR = { valid: 'success', suspect: 'warning', faulty: 'danger' } as const;

export interface SignalValidationPageProps {
  tags: TagInfo[];
}

/**
 * Signal validation workspace (functional spec §MSET / signal validation).
 * Estimates a target sensor from correlated peer sensors (a virtual sensor)
 * learned over a healthy training window, then flags drift/fault when the
 * residual shows persistent bias or inflated variance the peers can't explain.
 */
export function SignalValidationPage({ tags }: SignalValidationPageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const tooltipDecimals = useTooltipDecimals();
  const [target, setTarget] = useSharedPrimaryTag();
  const [refs, setRefs] = useState<string[]>([]);
  const [range, setRange] = useSharedRange();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: target, range, showMarkers: showOnChart });
  const [trainPct, setTrainPct] = useState(60);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [alertNote, setAlertNote] = useState<string | null>(null);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (target.length === 0 && refs.length === 0) return null;
    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Target', value: tagNames(target, nameById) },
            { label: 'Reference signals', value: tagNames(refs, nameById) },
          ],
        },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Settings',
          fields: [
            { label: 'Training split', value: `${trainPct}%` },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [target, refs, nameById, range, trainPct, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      targetId: string,
      refIds: string[],
      r: TimeRange,
      trainFraction: number,
      settings: BinningSettings,
    ): Promise<ValidationResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, settings);
      const allTags = [targetId, ...refIds.filter((x) => x !== targetId)];
      const table = await executeKql(
        buildAlignedSeriesQuery({ tagIds: allTags, start: r.start, end: r.end, binKql: bin.kql, aggregation: settings.aggregation }),
      );
      const aligned = parseAlignedSeries(table);
      const targetSeries = aligned.find((a) => a.tagId === targetId);
      if (!targetSeries) return null;
      const refSeries: AlignedSeries[] = aligned.filter((a) => a.tagId !== targetId);
      const report = validateSignal(targetSeries, refSeries, trainFraction);
      if (!report) return null;
      return { report, targetTagId: targetId };
    },
  );

  const validate = () => {
    if (target.length === 0 || refs.length === 0) return;
    run(target[0], refs, range, trainPct / 100, binning.settings).catch(() => {});
  };

  const result = state.data;

  // Record a finding into the Findings queue from the current validation report.
  const recordFinding = async () => {
    if (!result) return;
    const { verdict, bias, maxAbsZ, outOfBoundsFraction, fit } = result.report;
    const severity: AlertSeverity =
      verdict === 'faulty' ? 'critical' : verdict === 'suspect' ? 'warning' : 'info';
    try {
      await fireAlert({
        tagId: result.targetTagId,
        severity,
        title: `Signal validation: ${VERDICT_LABEL[verdict]} for ${labeler(result.targetTagId, nameById.get(result.targetTagId))}`,
        message: `${VERDICT_LABEL[verdict]}. Bias ${bias.toFixed(3)}, max|z| ${maxAbsZ.toFixed(1)}, ${(outOfBoundsFraction * 100).toFixed(1)}% out of bounds, fit R² ${(fit.r2 * 100).toFixed(1)}%.`,
        dedupKey: `validation:${result.targetTagId}`,
        evidence: {
          tagId: result.targetTagId,
          verdict,
          bias,
          maxAbsZ,
          outOfBoundsFraction,
          r2: fit.r2,
          trainSigma: fit.trainSigma,
          refs: fit.refTagIds,
          window: { start: range.start.toISOString(), end: range.end.toISOString() },
        },
      });
      setAlertNote('Finding recorded.');
    } catch (e) {
      setAlertNote(e instanceof Error ? e.message : String(e));
    }
  };

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'validation',
    title: 'Signal validation',
    fields: [
      tagField({
        name: 'target',
        label: 'Target',
        tags,
        current: target,
        set: setTarget,
        description: 'The target signal to validate.',
      }),
      tagField({
        name: 'refs',
        label: 'Reference signals',
        tags,
        current: refs,
        set: setRefs,
        multi: true,
        description: 'One or more correlated reference signals.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.integer('trainPct', 'Train %', trainPct, {
          min: 10,
          max: 95,
          description: 'Percent of the window used for training.',
        }),
        apply: (v) => setTrainPct(coerce.integer(v, { min: 10, max: 95 })),
      },
    ],
    canRun: target.length > 0 && refs.length > 0 && !state.loading,
    run: validate,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  useEffect(() => {
    if (!result) return;
    const p = buildProvenance({
      outputType: 'signal_validation',
      tagId: result.targetTagId,
      modelName: MSET_MODEL_NAME,
      modelVersion: MSET_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        verdict: result.report.verdict,
        r2: result.report.fit.r2,
        bias: result.report.bias,
        maxAbsZ: result.report.maxAbsZ,
        refs: result.report.fit.refTagIds,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const s = result.report.series;
    const trainCut = s.t[result.report.trainEnd] ?? null;
    const pair = (arr: (number | null)[]) => s.t.map((t, i) => [t, arr[i] ?? null]);
    const markArea = trainCut != null
      ? {
          silent: true,
          itemStyle: { color: 'rgba(15,108,189,0.06)' },
          data: [[{ xAxis: s.t[0] }, { xAxis: trainCut }]],
        }
      : undefined;
    return {
      animation: false,
      grid: [
        { left: 60, right: 24, top: 40, height: '48%' },
        { left: 60, right: 24, top: '66%', height: '24%' },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      legend: { top: 0, data: ['Actual', 'Virtual sensor', 'Residual (z)'] },
      xAxis: [
        { type: 'time', gridIndex: 0 },
        { type: 'time', gridIndex: 1 },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, scale: true },
        { type: 'value', gridIndex: 1, scale: true, name: 'z' },
      ],
      series: [
        {
          name: 'Actual',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#0f6cbd' },
          itemStyle: { color: '#0f6cbd' },
          data: pair(s.actual),
          ...(markArea ? { markArea } : {}),
        },
        {
          name: 'Virtual sensor',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#8764b8', type: 'dashed' },
          itemStyle: { color: '#8764b8' },
          data: pair(s.estimate),
        },
        {
          name: 'Residual (z)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          showSymbol: false,
          lineStyle: { width: 1, color: '#a4262c' },
          itemStyle: { color: '#a4262c' },
          data: pair(s.residualZ),
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#c8c6c4', type: 'dashed' },
            data: [{ yAxis: 3 }, { yAxis: -3 }],
          },
        },
      ],
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
    const s = result.report.series;
    return {
      columns: ['Timestamp', 'Actual', 'Expected', 'Residual (z)'],
      rows: s.t.map((t, i) => [
        new Date(t).toISOString(),
        s.actual[i] ?? null,
        s.estimate[i] ?? null,
        s.residualZ[i] ?? null,
      ]),
    };
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle1>Signal validation</Subtitle1>
        {result && (
          <Button appearance="secondary" onClick={() => void recordFinding()}>
            Record Finding
          </Button>
        )}
      </div>

      {alertNote && (
        <MessageBar intent="success">
          <MessageBarBody>{alertNote}</MessageBarBody>
        </MessageBar>
      )}

      <PageIntro
        title="Signal validation"
        overview={EXPLAINERS.validation.overview}
        interpretation={EXPLAINERS.validation.interpretation}
        technical={EXPLAINERS.validation.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 240 }}>
          <TagSelect
            label={`Target ${term.metricIdLabel.toLowerCase()}`}
            tags={tags}
            selected={target}
            onChange={setTarget}
            info={EXPLAINERS.validation.inputs!.target}
          />
        </div>
        <div style={{ minWidth: 280 }}>
          <TagSelect
            label={`Reference ${term.metricIdLabelPlural.toLowerCase()}`}
            tags={tags}
            selected={refs}
            onChange={setRefs}
            multiselect
            info={EXPLAINERS.validation.inputs!.refs}
          />
        </div>
        <Field label={withInfo('Train %', EXPLAINERS.validation.inputs!.trainPct)} className={styles.num}>
          <Input
            type="number"
            min={10}
            max={95}
            value={String(trainPct)}
            onChange={(_, d) => setTrainPct(Math.min(95, Math.max(10, Number(d.value) || 60)))}
          />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={[...target, ...refs].map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.validation.inputs!.range}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        disabled={state.loading}
        densityTagIds={[...target, ...refs]}
        densityEnabled={!state.loading}
      />

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={target.length === 0 || refs.length === 0 || state.loading} onClick={validate}>
          {state.loading ? <Spinner size="tiny" /> : 'Validate'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result ? (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Subtitle2>{labeler(result.targetTagId, nameById.get(result.targetTagId))}</Subtitle2>
            <Badge appearance="filled" color={VERDICT_COLOR[result.report.verdict]}>
              {VERDICT_LABEL[result.report.verdict]}
            </Badge>
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
          <OutputDescription label="Signal validation chart">
            {EXPLAINERS.validation.outputs!.chart}
          </OutputDescription>
          <ChartFrame
            option={annotatedOption}
            height={460}
            fileName="signal_validation"
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
          <OutputDescription label="Validation statistics">
            {EXPLAINERS.validation.outputs!.stats}
          </OutputDescription>
          <div className={styles.stats}>
            <Badge appearance="tint" color="brand">
              Fit R² {(result.report.fit.r2 * 100).toFixed(1)}%
            </Badge>
            <Badge appearance="tint" color="informative">
              Train σ {result.report.fit.trainSigma.toFixed(3)}
            </Badge>
            <Badge appearance="tint" color={Math.abs(result.report.bias) / (result.report.fit.trainSigma || 1) > 1 ? 'warning' : 'subtle'}>
              Bias {result.report.bias.toFixed(3)}
            </Badge>
            <Badge appearance="tint" color={result.report.maxAbsZ > 3 ? 'danger' : 'subtle'}>
              Max |z| {result.report.maxAbsZ.toFixed(1)}
            </Badge>
            <Badge appearance="tint" color={result.report.outOfBoundsFraction > 0.02 ? 'warning' : 'subtle'}>
              {(result.report.outOfBoundsFraction * 100).toFixed(1)}% out of bounds
            </Badge>
          </div>
          <Caption1 style={{ marginTop: tokens.spacingVerticalS }}>
            Estimator: {labeler(result.targetTagId, nameById.get(result.targetTagId))} ≈ β₀ +{' '}
            {result.report.fit.refTagIds
              .map((id, k) => `${result.report.fit.beta[k + 1].toFixed(3)}·${labeler(id, nameById.get(id))}`)
              .join(' + ')}
          </Caption1>
        </Card>
      ) : (
        <Body1>
          {state.loading
            ? 'Fitting virtual sensor\u2026'
            : 'Pick a target sensor and one or more correlated reference sensors, then Validate.'}
        </Body1>
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
