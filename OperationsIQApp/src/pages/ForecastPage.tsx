import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, yesNo, binningFields } from '../lib/captureContextHelpers';
import * as echarts from 'echarts';
import {
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
  Switch,
  ToggleButton,
  Badge,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { forecastThresholdDefault } from '../lib/metadataDefaults';
import { buildForecastQuery, buildPeriodsQuery, buildBacktestQuery } from '../lib/kql';
import { getActiveTimeseriesRef } from '../lib/activeConnection';
import { executeKql } from '../lib/eventhouse';
import {
  parseForecastResult,
  quantileBands,
  exceedanceProbability,
  planBacktest,
  parseBacktestResult,
  applyMeasuredBands,
  selectForecastModel,
  pooledRmse,
  modelSelectionCaption,
  recentWindowPoints,
  selectHistoryWindow,
  windowSelectionCaption,
  type ForecastResult,
  type ThresholdDirection,
  type ModelSelection,
  type HorizonErrorCalibration,
  type WindowSelection,
} from '../lib/forecast';
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
import { PALETTE } from '../lib/series';
import type { ChartData } from '../lib/export';
import { formatQueryInstant } from '../lib/timezone';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { ProvenanceChip } from '../components/ProvenanceChip';
import { buildProvenance, writeModelOutput, FEATURE_VERSION, type Provenance } from '../lib/provenance';
import { usePageBinning } from '../context/BinningContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import {
  parseDetectedPeriods,
  periodToSeasonalityBins,
  type DetectedPeriod,
} from '../lib/periods';
import { SeasonalityDetector } from '../components/SeasonalityDetector';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
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
  readout: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap', marginTop: tokens.spacingVerticalS, alignItems: 'center' },
});

const HISTORY_COLOR = PALETTE[0];
const FORECAST_COLOR = '#a4262c';
const BAND_COLOR = 'rgba(164, 38, 44, 0.15)';
const QUANTILE_COLOR = '#8764b8';
// Imputed (linearly-filled) history spans reuse the History hue but faint/dotted.
const IMPUTED_COLOR = HISTORY_COLOR;

/** Percentile levels drawn when the quantile overlay is enabled. */
const QUANTILE_PROBS = [0.1, 0.5, 0.9];

/** Model identity for forecast provenance (functional spec: traceability). */
const FORECAST_MODEL_NAME = 'series_decompose_forecast';
const FORECAST_MODEL_VERSION = '1';

const CONFIDENCE_OPTIONS = [
  { value: 0.8, label: '80%' },
  { value: 0.9, label: '90%' },
  { value: 0.95, label: '95%' },
  { value: 0.98, label: '98%' },
  { value: 0.99, label: '99%' },
];

export interface ForecastPageProps {
  tags: TagInfo[];
}

/** Forecasting view: history + `series_decompose_forecast` with a prediction band. */
export function ForecastPage({ tags }: ForecastPageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [horizon, setHorizon] = useState(48);
  const [confidence, setConfidence] = useState(0.95);
  // Seasonality period in bins passed to series_decompose_forecast. null =
  // auto-detect (KQL default). Populated one-click from the "Detect cycles" chips.
  const [seasonality, setSeasonality] = useState<number | null>(null);
  const binning = usePageBinning();
  const [showQuantiles, setShowQuantiles] = useState(false);
  const [thresholdText, setThresholdText] = useState('');
  const [direction, setDirection] = useState<ThresholdDirection>('above');
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();
  const annotationRange = useMemo(() => {
    const bin = chooseBinFor({ start: range.start, end: range.end }, binning.settings);
    return {
      start: range.start,
      end: new Date(range.end.getTime() + horizon * bin.millis),
    };
  }, [range, horizon, binning.settings]);
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({
    tags,
    levels,
    tagIds: tag,
    range: annotationRange,
    showMarkers: showOnChart,
  });

  // Prefill the breach threshold + direction from the selected tag's governed
  // metadata (spec/operating limits) once per selection, without clobbering a
  // value the user has already entered. Fully overridable.
  const prefilledTagRef = useRef<string | null>(null);
  useEffect(() => {
    if (tag.length !== 1) {
      prefilledTagRef.current = null;
      return;
    }
    const id = tag[0];
    if (prefilledTagRef.current === id) return;
    prefilledTagRef.current = id;
    if (thresholdText.trim() !== '') return;
    const d = forecastThresholdDefault(tags.find((t) => t.tagId === id));
    if (d) {
      setThresholdText(String(d.threshold));
      setDirection(d.direction);
    }
  }, [tag, tags, thresholdText]);

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Forecast tag', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Training window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Forecast settings',
          fields: [
            { label: 'Horizon', value: `${horizon} bins` },
            { label: 'Confidence', value: `${Math.round(confidence * 100)}%` },
            {
              label: 'Seasonality',
              value: seasonality == null ? 'Auto-detect' : `${seasonality} bins`,
            },
            { label: 'Quantile bands', value: yesNo(showQuantiles) },
            {
              label: 'Threshold',
              value: thresholdText.trim() ? `${thresholdText.trim()} (${direction})` : 'None',
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
    horizon,
    confidence,
    seasonality,
    showQuantiles,
    thresholdText,
    direction,
    binning.settings,
  ]);
  useRegisterCaptureContext(captureSummary);
  const tooltipDecimals = useTooltipDecimals();

  // Snapshot of the inputs used for the last submitted forecast, so provenance
  // reflects what was actually computed rather than later control edits.
  const [provenance, setProvenance] = useState<Provenance | null>(null);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      horizonPoints: number,
      conf: number,
      s: BinningSettings,
      seasonalityBins: number | null,
    ): Promise<ForecastResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const futureEnd = new Date(r.end.getTime() + horizonPoints * bin.millis);
      const table = await executeKql(
        buildForecastQuery({
          tagId,
          start: r.start,
          end: r.end,
          futureEnd,
          binKql: bin.kql,
          horizonPoints,
          aggregation: s.aggregation,
          seasonality: seasonalityBins ?? undefined,
          timeseriesRef: getActiveTimeseriesRef(),
        }),
      );
      const result = parseForecastResult(table, conf);
      if (!result || horizonPoints <= 0) return result;
      const plan = planBacktest(result.forecastStart, horizonPoints);
      if (!plan.feasible) return result;
      const backtestBase = {
        tagId,
        start: r.start,
        end: r.end,
        binKql: bin.kql,
        horizonPoints,
        historyPoints: plan.historyPoints,
        foldStep: plan.foldStep,
        aggregation: s.aggregation,
        seasonality: seasonalityBins ?? undefined,
        timeseriesRef: getActiveTimeseriesRef(),
      };
      try {
        // Rolling-origin backtest on the raw model input: drives measured bands and is the selection baseline.
        const calBase = parseBacktestResult(await executeKql(buildBacktestQuery(backtestBase)));
        // Candidate backtest on the outlier-cleaned model input (best-effort).
        let calClean: HorizonErrorCalibration | null = null;
        try {
          calClean = parseBacktestResult(
            await executeKql(buildBacktestQuery({ ...backtestBase, cleanOutliers: {} })),
          );
        } catch {
          calClean = null;
        }
        const choice = calClean ? selectForecastModel(calBase, calClean) : 'baseline';
        const selection: ModelSelection | undefined = calClean
          ? { choice, baselineRmse: pooledRmse(calBase), cleanedRmse: pooledRmse(calClean) }
          : undefined;
        if (choice === 'cleaned' && calClean) {
          // Cleaned candidate won: recompute the point forecast on the winsorized input.
          const cleanResult = parseForecastResult(
            await executeKql(
              buildForecastQuery({
                tagId,
                start: r.start,
                end: r.end,
                futureEnd,
                binKql: bin.kql,
                horizonPoints,
                aggregation: s.aggregation,
                seasonality: seasonalityBins ?? undefined,
                timeseriesRef: getActiveTimeseriesRef(),
                cleanOutliers: {},
              }),
            ),
            conf,
          );
          if (cleanResult) {
            return { ...applyMeasuredBands(cleanResult, calClean, conf), modelSelection: selection };
          }
        }
        // A4: recent-regime shorter fit-window candidate (raw input), considered only
        // when the raw full-window model was kept (cleaning did not win). Best-effort.
        const recentBins = recentWindowPoints(plan.historyPoints, horizonPoints);
        if (recentBins != null) {
          try {
            const calRecent = parseBacktestResult(
              await executeKql(buildBacktestQuery({ ...backtestBase, fitWindowPoints: recentBins })),
            );
            if (selectHistoryWindow(calBase, calRecent) === 'recent') {
              // Fit only the most recent `recentBins` bins by moving the query start forward.
              const recentStart = new Date(r.end.getTime() - recentBins * bin.millis);
              const recentResult = parseForecastResult(
                await executeKql(
                  buildForecastQuery({
                    tagId,
                    start: recentStart,
                    end: r.end,
                    futureEnd,
                    binKql: bin.kql,
                    horizonPoints,
                    aggregation: s.aggregation,
                    seasonality: seasonalityBins ?? undefined,
                    timeseriesRef: getActiveTimeseriesRef(),
                  }),
                ),
                conf,
              );
              if (recentResult) {
                const windowSelection: WindowSelection = {
                  choice: 'recent',
                  fullRmse: pooledRmse(calBase),
                  recentRmse: pooledRmse(calRecent),
                  recentBins,
                };
                return {
                  ...applyMeasuredBands(recentResult, calRecent, conf),
                  modelSelection: selection,
                  windowSelection,
                };
              }
            }
          } catch {
            // recent-window candidate is best-effort; keep the full-window result
          }
        }
        return { ...applyMeasuredBands(result, calBase, conf), modelSelection: selection };
      } catch {
        return result; // backtest is best-effort; keep the in-sample band
      }
    },
  );

  const forecast = () => {
    if (tag.length === 0) return;
    run(tag[0], range, horizon, confidence, binning.settings, seasonality).catch(() => {});
  };

  // Detect dominant cycles over the training window, in the same bins the
  // forecast seasonality expects.
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
        timeseriesRef: getActiveTimeseriesRef(),
      }),
    );
    return parseDetectedPeriods(table, bin.millis);
  };

  // Apply a detected cycle as the forecast seasonality and immediately re-run.
  const applyPeriod = (p: DetectedPeriod) => {
    const bins = periodToSeasonalityBins(p);
    setSeasonality(bins);
    if (tag[0]) run(tag[0], range, horizon, confidence, binning.settings, bins).catch(() => {});
  };

  const result = state.data;

  // Register this page with the Operations Advisor so it can drive the
  // forecast end-to-end: set inputs, run, and read back the rendered result.
  useControlledPage({
    pageKey: 'forecast',
    title: 'Forecast',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.integer('horizon', 'Horizon (bins)', horizon, {
          min: 1,
          max: 2000,
          description: 'How many future bins to predict.',
        }),
        apply: (v) => setHorizon(coerce.integer(v, { min: 1, max: 2000 })),
      },
      {
        field: pf.enumOf(
          'confidence',
          'Confidence',
          confidence,
          CONFIDENCE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: 'Prediction-interval confidence level.' },
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
        field: pf.string('threshold', 'Threshold', thresholdText, {
          description: 'Optional breach threshold value; empty to disable.',
        }),
        apply: (v) => setThresholdText(coerce.string(v)),
      },
      {
        field: pf.enumOf('direction', 'Breach when', direction, [
          { value: 'above', label: 'Above' },
          { value: 'below', label: 'Below' },
        ]),
        apply: (v) =>
          setDirection(coerce.enumValue(v, ['above', 'below']) as ThresholdDirection),
      },
      {
        field: pf.boolean('showQuantiles', 'P10/P50/P90 bands', showQuantiles, {
          description: 'Overlay P10/P50/P90 quantile bands on the forecast.',
        }),
        apply: (v) => setShowQuantiles(coerce.boolean(v)),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: forecast,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  // Parsed threshold (NaN when the field is empty/invalid → no exceedance calc).
  const threshold = useMemo(() => {
    const t = Number(thresholdText);
    return thresholdText.trim() !== '' && Number.isFinite(t) ? t : NaN;
  }, [thresholdText]);

  const quantiles = useMemo(
    () => (result && showQuantiles ? quantileBands(result, QUANTILE_PROBS) : []),
    [result, showQuantiles],
  );

  const exceedance = useMemo(
    () => (result && Number.isFinite(threshold) ? exceedanceProbability(result, threshold, direction) : null),
    [result, threshold, direction],
  );

  // History data-quality readout: surfaces imputed bins, longest gap and
  // trailing staleness. Escalates to a warning when the forecast rests on
  // sparse or stale history — a large share of history was imputed
  // (missingFraction > 20%) OR the longest contiguous gap is at least half the
  // requested horizon (and no smaller than 3 bins). Additive only — the
  // forecast is never withheld in this slice.
  const quality = useMemo(() => {
    const cov = result?.coverage;
    if (!cov || cov.missingBins <= 0) return null;
    const pct = Math.round(cov.missingFraction * 100);
    const gapThreshold = Math.max(3, Math.ceil(horizon * 0.5));
    const warn = cov.missingFraction > 0.2 || cov.longestGapBins >= gapThreshold;
    const text =
      `History quality: ${cov.missingBins} of ${cov.historyBins} bins imputed (${pct}%); ` +
      `longest gap ${cov.longestGapBins} bins; ` +
      `last observed ${cov.trailingStaleBins} bins before forecast origin.`;
    return { text, warn };
  }, [result, horizon]);

  // Record traceability for each successful forecast (spec: non-negotiable).
  useEffect(() => {
    if (!result) return;
    const p = buildProvenance({
      outputType: 'forecast',
      tagId: result.tagId,
      modelName: FORECAST_MODEL_NAME,
      modelVersion: FORECAST_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        horizon,
        confidence,
        sigma: result.sigma,
        seasonality: seasonality == null ? 'auto' : seasonality,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // Only re-run when a new result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    const quantileColumns = quantiles.map((q) => `P${Math.round(q.p * 100)}`);
    return {
      columns: ['Timestamp', 'History', 'Imputed', 'Forecast', 'Lower', 'Upper', ...quantileColumns],
      rows: result.x.map((ms, i) => [
        new Date(ms).toISOString(),
        result.actual[i] ?? null,
        result.imputed[i] ? result.modelInput[i] ?? null : null,
        result.forecast[i] ?? null,
        result.lower[i] ?? null,
        result.upper[i] ?? null,
        ...quantiles.map((q) => q.values[i] ?? null),
      ]),
    };
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const pair = (arr: (number | null)[]) => result.x.map((t, i) => [t, arr[i]] as [number, number | null]);
    const band = result.x.map((t, i) => {
      const lo = result.lower[i];
      const up = result.upper[i];
      return [t, lo != null && up != null ? up - lo : null] as [number, number | null];
    });
    const quantileSeries: echarts.SeriesOption[] = quantiles.map((q) => ({
      name: `P${Math.round(q.p * 100)}`,
      type: 'line',
      showSymbol: false,
      lineStyle: {
        width: q.p === 0.5 ? 1.75 : 1,
        color: QUANTILE_COLOR,
        type: q.p === 0.5 ? 'solid' : 'dotted',
        opacity: q.p === 0.5 ? 1 : 0.8,
      },
      itemStyle: { color: QUANTILE_COLOR },
      data: pair(q.values),
    }));
    const legendData = ['History', 'Forecast', 'Prediction interval'];
    if (quantiles.length) legendData.push(...quantiles.map((q) => `P${Math.round(q.p * 100)}`));
    const hasImputed = result.imputed.some((v) => v);
    if (hasImputed) legendData.push('Imputed');
    const imputedData = result.x.map(
      (t, i) => [t, result.imputed[i] ? result.modelInput[i] ?? null : null] as [number, number | null],
    );
    const thresholdMark: echarts.SeriesOption[] = Number.isFinite(threshold)
      ? [
          {
            name: 'Threshold',
            type: 'line',
            showSymbol: false,
            data: [],
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: '#b4009e', type: 'dashed', width: 1.5 },
              label: { formatter: `Threshold ${threshold}`, position: 'insideEndTop' as const },
              data: [{ yAxis: threshold }],
            },
          },
        ]
      : [];
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 48, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: legendData },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        // Lower bound (invisible) forms the stack base for the band fill.
        {
          name: 'Lower',
          type: 'line',
          stack: 'confidence',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          silent: true,
          data: pair(result.lower),
        },
        // Band height (upper - lower) stacked on the lower bound fills to upper.
        {
          name: 'Prediction interval',
          type: 'line',
          stack: 'confidence',
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: { color: BAND_COLOR },
          silent: true,
          data: band,
        },
        // Imputed history spans (linearly-filled model input), drawn faint/dotted
        // and behind the History line so real gaps stay visible.
        {
          name: 'Imputed',
          type: 'line',
          z: 1,
          showSymbol: false,
          lineStyle: { width: 1, color: IMPUTED_COLOR, type: 'dotted', opacity: 0.45 },
          itemStyle: { color: IMPUTED_COLOR, opacity: 0.45 },
          silent: true,
          data: imputedData,
        },
        {
          name: 'History',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.5, color: HISTORY_COLOR },
          itemStyle: { color: HISTORY_COLOR },
          data: pair(result.actual),
        },
        {
          name: 'Forecast',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.75, color: FORECAST_COLOR, type: 'dashed' },
          itemStyle: { color: FORECAST_COLOR },
          data: pair(result.forecast),
        },
        ...quantileSeries,
        ...thresholdMark,
      ],
    };
  }, [result, quantiles, threshold, tooltipDecimals]);

  const annotatedOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(option, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: annotationRange.start.getTime(),
        fullEnd: annotationRange.end.getTime(),
      }),
    [option, annot.chartMarkers, annot.selecting, annotationRange],
  );

  return (
    <div className={styles.root}>
      <Subtitle1>Forecast</Subtitle1>

      <PageIntro
        title="Forecast"
        overview={EXPLAINERS.forecast.overview}
        interpretation={EXPLAINERS.forecast.interpretation}
        technical={EXPLAINERS.forecast.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} />
        </div>
        <Field
          label={withInfo('Horizon (bins)', EXPLAINERS.forecast.inputs!.horizon)}
          className={styles.num}
        >
          <Input
            type="number"
            min={1}
            max={2000}
            value={String(horizon)}
            onChange={(_, d) => {
              const n = Number(d.value);
              if (Number.isFinite(n) && n >= 1) setHorizon(Math.floor(n));
            }}
          />
        </Field>
        <Field label={withInfo('Confidence', EXPLAINERS.forecast.inputs!.confidence)}>
          <Select
            value={String(confidence)}
            onChange={(_, d) => setConfidence(Number(d.value))}
          >
            {CONFIDENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={withInfo('Threshold', EXPLAINERS.forecast.inputs!.threshold)} className={styles.num}>
          <Input
            type="number"
            placeholder="value"
            value={thresholdText}
            onChange={(_, d) => setThresholdText(d.value)}
          />
        </Field>
        <Field label={withInfo('Breach when', EXPLAINERS.forecast.inputs!.direction)}>
          <Select value={direction} onChange={(_, d) => setDirection(d.value as ThresholdDirection)}>
            <option value="above">Above</option>
            <option value="below">Below</option>
          </Select>
        </Field>
        <Field label={withInfo('P10/P50/P90', EXPLAINERS.forecast.inputs!.quantiles)}>
          <Switch checked={showQuantiles} onChange={(_, d) => setShowQuantiles(d.checked)} />
        </Field>
        <Field label={withInfo('Seasonality (bins)', EXPLAINERS.forecast.inputs!.seasonality)}>
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={forecast}>
          {state.loading ? <Spinner size="tiny" /> : 'Forecast'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      <Card className={styles.card}>
        <div className={styles.cardActions}>
          <Subtitle2>{result ? labeler(result.tagId, nameById.get(result.tagId)) : 'Forecast'}</Subtitle2>
          <div className={styles.spacer} />
          {result && provenance && <ProvenanceChip provenance={provenance} />}
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
              {result.calibration.method === 'backtest'
                ? `Predicting ${horizon} bin(s) ahead. Band = measured out-of-sample error quantiles from a rolling-origin backtest (${result.calibration.sampleCount} folds/horizon).`
                : result.calibration.method === 'empirical'
                ? `Predicting ${horizon} bin(s) ahead. Band = empirical residual quantiles (asymmetric) scaled by \u221a(steps ahead) \u2014 ${result.calibration.sampleCount} residual samples.`
                : `Predicting ${horizon} bin(s) ahead. Band = \u00b1z\u00b7\u03c3\u00b7\u221a(steps ahead), \u03c3 = ${result.sigma.toFixed(4)} (in-sample residual SD, normal fallback \u2014 only ${result.calibration.sampleCount} residual samples).`}
            </Caption1>
            {result.modelSelection && (
              <div className={styles.readout}>
                <Badge
                  appearance="tint"
                  color={result.modelSelection.choice === 'cleaned' ? 'brand' : 'informative'}
                >
                  {result.modelSelection.choice === 'cleaned' ? 'Outlier-cleaned model' : 'Raw model'}
                </Badge>
                <Caption1>{modelSelectionCaption(result.modelSelection)}</Caption1>
              </div>
            )}
            {result.windowSelection && windowSelectionCaption(result.windowSelection) && (
              <div className={styles.readout}>
                <Badge appearance="tint" color="brand">Recent-regime window</Badge>
                <Caption1>{windowSelectionCaption(result.windowSelection)}</Caption1>
              </div>
            )}
            {quality &&
              (quality.warn ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    {`${quality.text} Forecast rests on sparse/stale history — interpret with caution.`}
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <Caption1>{quality.text}</Caption1>
              ))}
            {exceedance && (
              <div className={styles.readout}>
                <Badge
                  appearance="tint"
                  color={exceedance.anyBreachProbability >= 0.5 ? 'danger' : exceedance.anyBreachProbability >= 0.2 ? 'warning' : 'success'}
                >
                  {exceedance.anyBreachMethod === 'trajectory'
                    ? `P(breach ${exceedance.direction} ${exceedance.threshold}) \u2248 ${(exceedance.anyBreachProbability * 100).toFixed(0)}%`
                    : `P(breach ${exceedance.direction} ${exceedance.threshold}) up to ${(exceedance.anyBreachProbability * 100).toFixed(0)}%`}
                </Badge>
                <Caption1>
                  {`Peak per-bin ${(exceedance.peakProbability * 100).toFixed(0)}%`}
                  {exceedance.peakIndex >= 0
                    ? ` at ${formatQueryInstant(result.x[exceedance.peakIndex])}`
                    : ''}
                  {exceedance.firstLikelyIndex >= 0
                    ? ` · first likely (\u226550%) ${formatQueryInstant(result.x[exceedance.firstLikelyIndex])}`
                    : ' · never reaches 50% in horizon'}
                </Caption1>
              </div>
            )}
            <OutputDescription label="Forecast chart">
              {EXPLAINERS.forecast.outputs!.chart}
            </OutputDescription>
            <ChartFrame
              option={annotatedOption}
              height={420}
              fileName="forecast"
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
            {state.loading ? 'Computing forecast\u2026' : 'Pick a tag and range, then choose Forecast.'}
          </Body1>
        )}
      </Card>
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
