import { useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields } from '../lib/captureContextHelpers';
import * as echarts from 'echarts';
import {
  Body1,
  Button,
  Caption1,
  Card,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Subtitle1,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildExploreQuery, buildRobustOutliersQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows } from '../lib/series';
import { PALETTE } from '../lib/series';
import { computeDeviation, type DeviationResult } from '../lib/deviation';
import {
  parseRobustSeries,
  computeRobustDeviation,
  DEFAULT_TUKEY_THRESHOLD,
} from '../lib/robustDeviation';
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
import { ChartFrame } from '../components/ChartFrame';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { withInfo } from '../components/fieldInfo';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { fireAlert, type AlertSeverity } from '../lib/alertCenter';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
import { usePageBinning } from '../context/BinningContext';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
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
  num: { width: '120px' },
  kpis: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  kpi: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: '140px',
  },
  kpiValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold },
});

const HISTORY_COLOR = PALETTE[0];
const EXPECTED_COLOR = '#605e5c';
const BAND_COLOR = 'rgba(96, 94, 92, 0.14)';
const BREACH_COLOR = 'rgba(209, 52, 56, 0.18)';

const CONFIDENCE_OPTIONS = [
  { value: 0.8, label: '80%' },
  { value: 0.9, label: '90%' },
  { value: 0.95, label: '95%' },
  { value: 0.98, label: '98%' },
  { value: 0.99, label: '99%' },
];

/** Anomaly detector: seasonal decomposition band vs. model-free Tukey outliers. */
type Detector = 'seasonal' | 'robust';

const DETECTOR_OPTIONS: { value: Detector; label: string }[] = [
  { value: 'seasonal', label: 'Seasonal baseline (series_decompose_anomalies)' },
  { value: 'robust', label: 'Robust (Tukey, series_outliers)' },
];

/** Tukey score threshold options for the robust detector (|score| beyond = outlier). */
const SENSITIVITY_OPTIONS = [
  { value: 1.5, label: 'Standard (1.5)' },
  { value: 2.25, label: 'Moderate (2.25)' },
  { value: 3.0, label: 'Conservative (3.0)' },
];

export interface MonitorPageProps {
  tags: TagInfo[];
}

/** Deviation monitor: actual vs expected band with breach detection and KPIs. */
export function MonitorPage({ tags }: MonitorPageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [confidence, setConfidence] = useState(0.95);
  const [detector, setDetector] = useState<Detector>('seasonal');
  const [sensitivity, setSensitivity] = useState(DEFAULT_TUKEY_THRESHOLD);
  const binning = usePageBinning();
  const [alertNote, setAlertNote] = useState<string | null>(null);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Monitored tag', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Configuration',
          fields: [
            {
              label: 'Detection method',
              value: detector === 'robust' ? 'Robust (Tukey)' : 'Seasonal baseline',
            },
            detector === 'robust'
              ? { label: 'Sensitivity', value: `Tukey |score| > ${sensitivity}` }
              : { label: 'Confidence', value: `${Math.round(confidence * 100)}%` },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [tag, nameById, range, confidence, detector, sensitivity, binning.settings]);
  useRegisterCaptureContext(captureSummary);
  const tooltipDecimals = useTooltipDecimals();

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      conf: number,
      s: BinningSettings,
      det: Detector,
      tukey: number,
    ): Promise<DeviationResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      if (det === 'robust') {
        const table = await executeKql(
          buildRobustOutliersQuery({
            tagId,
            start: r.start,
            end: r.end,
            binKql: bin.kql,
            aggregation: s.aggregation,
          }),
        );
        const series = parseRobustSeries(table);
        if (!series || series.x.length === 0) return null;
        return computeRobustDeviation(series, tukey);
      }
      const table = await executeKql(
        buildExploreQuery({
          tagIds: [tagId],
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );
      const series = parseExploreRows(table)[0];
      if (!series) return null;
      return computeDeviation(series, conf);
    },
  );

  const monitor = () => {
    if (tag.length === 0) return;
    run(tag[0], range, confidence, binning.settings, detector, sensitivity).catch(() => {});
  };

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'monitor',
    title: 'Deviation Monitor',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf(
          'confidence',
          'Confidence',
          confidence,
          CONFIDENCE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: 'Expected-band confidence level (seasonal detector).' },
        ),
        apply: (v) =>
          setConfidence(
            coerce.enumValue(
              v,
              CONFIDENCE_OPTIONS.map((o) => o.value),
            ) as number,
          ),
      },
      {
        field: pf.enumOf(
          'detector',
          'Detection method',
          detector,
          DETECTOR_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          {
            description:
              'Seasonal baseline (series_decompose_anomalies) models trend+seasonality; Robust ' +
              '(Tukey, series_outliers) is model-free and better for aperiodic signals.',
          },
        ),
        apply: (v) =>
          setDetector(
            coerce.enumValue(v, ['seasonal', 'robust']) as Detector,
          ),
      },
      {
        field: pf.enumOf(
          'sensitivity',
          'Tukey sensitivity',
          sensitivity,
          SENSITIVITY_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: 'Robust detector: flag bins whose Tukey score magnitude exceeds this.' },
        ),
        apply: (v) =>
          setSensitivity(
            coerce.enumValue(
              v,
              SENSITIVITY_OPTIONS.map((o) => o.value),
            ) as number,
          ),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: monitor,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!state.data,
  });

  // Record a finding into the Findings queue from the current breach picture.
  const sendToAlertCenter = async () => {
    const r = state.data;
    if (!r) return;
    const tagName = labeler(r.tagId, nameById.get(r.tagId));
    const severity: AlertSeverity =
      r.breaches.length === 0 ? 'info' : r.pctInBand < 0.9 ? 'critical' : 'warning';
    const worst = r.breaches.reduce(
      (m, b) => (Math.abs(b.peakDeviation) > Math.abs(m) ? b.peakDeviation : m),
      0,
    );
    try {
      await fireAlert({
        tagId: r.tagId,
        severity,
        title: `Deviation on ${tagName}`,
        message: `${r.breaches.length} breach(es), ${(r.pctInBand * 100).toFixed(1)}% in band`,
        dedupKey: `monitor:${r.tagId}`,
        currentValue: Number.isFinite(worst) ? worst : undefined,
        evidence: {
          tagId: r.tagId,
          confidence,
          window: { start: range.start.toISOString(), end: range.end.toISOString() },
          pctInBand: r.pctInBand,
          maxAbsDeviation: r.maxAbsDeviation,
          breaches: r.breaches.map((b) => ({
            start: new Date(b.startMs).toISOString(),
            end: new Date(b.endMs).toISOString(),
            direction: b.direction,
            peakValue: b.peakValue,
            peakDeviation: b.peakDeviation,
          })),
        },
      });
      setAlertNote('Finding recorded.');
    } catch (e) {
      setAlertNote(e instanceof Error ? e.message : String(e));
    }
  };

  const result = state.data;

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['Timestamp', 'Actual', 'Expected', 'Lower', 'Upper', 'Breach'],
      rows: result.x.map((ms, i) => {
        const breach = result.breaches.find((b) => i >= b.startIndex && i <= b.endIndex);
        return [
          new Date(ms).toISOString(),
          result.actual[i] ?? null,
          result.expected[i] ?? null,
          result.lower[i] ?? null,
          result.upper[i] ?? null,
          breach ? (breach.direction === 'high' ? 'Above' : 'Below') : null,
        ];
      }),
    };
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const pair = (arr: (number | null)[]) =>
      result.x.map((t, i) => [t, arr[i]] as [number, number | null]);
    const band = result.x.map((t, i) => {
      const lo = result.lower[i];
      const up = result.upper[i];
      return [t, lo != null && up != null ? up - lo : null] as [number, number | null];
    });
    const markAreas = result.breaches.map((b) => [
      { xAxis: b.startMs },
      { xAxis: b.endMs },
    ]);
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 40, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: ['Actual', 'Expected', 'Normal band'] },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          name: 'Lower',
          type: 'line',
          stack: 'band',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          silent: true,
          data: pair(result.lower),
        },
        {
          name: 'Normal band',
          type: 'line',
          stack: 'band',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { color: BAND_COLOR },
          silent: true,
          data: band,
        },
        {
          name: 'Expected',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.25, color: EXPECTED_COLOR, type: 'dashed' },
          itemStyle: { color: EXPECTED_COLOR },
          data: pair(result.expected),
        },
        {
          name: 'Actual',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.5, color: HISTORY_COLOR },
          itemStyle: { color: HISTORY_COLOR },
          data: pair(result.actual),
          markArea: {
            silent: true,
            itemStyle: { color: BREACH_COLOR },
            data: markAreas,
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

  const fmt = (n: number) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '\u2014';

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle1>Deviation monitor</Subtitle1>
        {result && (
          <Button appearance="secondary" onClick={() => void sendToAlertCenter()}>
            Record Finding
          </Button>
        )}
      </div>

      <PageIntro
        title="Monitor"
        overview={EXPLAINERS.monitor.overview}
        interpretation={EXPLAINERS.monitor.interpretation}
        technical={EXPLAINERS.monitor.technical}
      />

      {alertNote && (
        <MessageBar intent="success">
          <MessageBarBody>{alertNote}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect
            tags={tags}
            selected={tag}
            onChange={setTag}
            info={EXPLAINERS.monitor.inputs!.tag}
          />
        </div>
        <Field label={withInfo('Detection method', EXPLAINERS.monitor.inputs!.detector)}>
          <Select
            value={detector}
            onChange={(_, d) => setDetector(d.value as Detector)}
          >
            {DETECTOR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        {detector === 'robust' ? (
          <Field label={withInfo('Sensitivity', EXPLAINERS.monitor.inputs!.sensitivity)}>
            <Select
              value={String(sensitivity)}
              onChange={(_, d) => setSensitivity(Number(d.value))}
            >
              {SENSITIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={withInfo('Confidence', EXPLAINERS.monitor.inputs!.confidence)}>
            <Select value={String(confidence)} onChange={(_, d) => setConfidence(Number(d.value))}>
              {CONFIDENCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
        rangeInfo={EXPLAINERS.monitor.inputs!.range}
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={monitor}>
          {state.loading ? <Spinner size="tiny" /> : 'Monitor'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && (
        <>
          <OutputDescription label="Monitor summary">
            {EXPLAINERS.monitor.outputs!.kpis}
          </OutputDescription>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <Caption1>In band</Caption1>
              <span className={styles.kpiValue}>{(result.pctInBand * 100).toFixed(1)}%</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>Breaches</Caption1>
              <span className={styles.kpiValue}>{result.breaches.length}</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>Max deviation</Caption1>
              <span className={styles.kpiValue}>{fmt(result.maxAbsDeviation)}</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>Band ±</Caption1>
              <span className={styles.kpiValue}>{fmt(result.z * result.sigma)}</span>
            </div>
          </div>
        </>
      )}

      <Card className={styles.card}>
        <div className={styles.cardActions}>
          <Subtitle2>{result ? labeler(result.tagId, nameById.get(result.tagId)) : 'Deviation monitor'}</Subtitle2>
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
        {result ? (
          <>
            <Caption1>
              {detector === 'robust'
                ? `Expected = series median; normal band = Tukey whisker envelope (series_outliers, |score| > ${sensitivity.toFixed(2)}). Shaded spans are outlier runs.`
                : `Expected = decomposition baseline; normal band = \u00b1${result.z.toFixed(2)}\u00b7\u03c3, \u03c3 = ${result.sigma.toFixed(4)} (residual SD). Shaded spans are breaches.`}
            </Caption1>
            <OutputDescription label="Monitor chart">
              {EXPLAINERS.monitor.outputs!.chart}
            </OutputDescription>
            <ChartFrame
              option={annotatedOption}
              height={420}
              fileName="monitor"
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
          </>
        ) : (
          <Body1>
            {state.loading ? 'Computing\u2026' : 'Pick a tag and range, then choose Monitor.'}
          </Body1>
        )}
      </Card>

      {result && result.breaches.length > 0 && (
        <Card className={styles.card}>
          <Subtitle2>Breaches</Subtitle2>
          <OutputDescription label="Breaches table">
            {EXPLAINERS.monitor.outputs!.breaches}
          </OutputDescription>
          <Table size="small" aria-label="Breaches">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Start</TableHeaderCell>
                <TableHeaderCell>End</TableHeaderCell>
                <TableHeaderCell>Bins</TableHeaderCell>
                <TableHeaderCell>Direction</TableHeaderCell>
                <TableHeaderCell>Peak value</TableHeaderCell>
                <TableHeaderCell>Peak deviation</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.breaches.map((b) => (
                <TableRow key={`${b.startIndex}-${b.endIndex}`}>
                  <TableCell>{new Date(b.startMs).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                  <TableCell>{new Date(b.endMs).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                  <TableCell>{b.endIndex - b.startIndex + 1}</TableCell>
                  <TableCell>{b.direction === 'high' ? 'Above' : 'Below'}</TableCell>
                  <TableCell>{fmt(b.peakValue)}</TableCell>
                  <TableCell>{fmt(b.peakDeviation)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
