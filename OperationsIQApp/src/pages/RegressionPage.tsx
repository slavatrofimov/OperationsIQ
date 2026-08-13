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
  Label,
  Select,
  Slider,
  Spinner,
  Subtitle1,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import {
  buildCorrelationMatrixQuery,
  buildRegressionQuery,
  buildSensitivityQuery,
} from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import {
  parseCorrelationMatrix,
  parseRegressionFit,
  parseSensitivityResult,
  buildSymmetricCorrelationMatrix,
  predictWhatIf,
  type CorrelationPair,
  type FeatureSensitivity,
  type RegressionFit,
} from '../lib/regression';
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
import { usePageBinning } from '../context/BinningContext';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { PALETTE } from '../lib/series';
import { downloadText, fileStamp, type ChartData } from '../lib/export';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { computeStats } from '../lib/stats';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  spacer: { flex: 1 },
  threePanel: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr 280px',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
  },
  setup: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  whatif: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  card: { padding: tokens.spacingVerticalL },
  cardActions: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: tokens.spacingVerticalS,
  },
  prediction: {
    padding: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
    backgroundColor: tokens.colorBrandBackground2,
    borderRadius: tokens.borderRadiusMedium,
    textAlign: 'center',
  },
  predValue: {
    fontSize: tokens.fontSizeHero900,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorBrandForeground1,
  },
  delta: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  sliderGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
});

const HISTORY_COLOR = PALETTE[0];
const FITTED_COLOR = '#a4262c';

export interface RegressionPageProps {
  tags: TagInfo[];
}

interface AnalysisResult {
  correlations: CorrelationPair[];
  sensitivity: FeatureSensitivity[];
  fits: RegressionFit[];
  targetTagId: string;
  featureTagIds: string[];
}

/** Regression and sensitivity analysis page with three-panel layout. */
export function RegressionPage({ tags }: RegressionPageProps) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  
  const [targetTag, setTargetTag] = useSharedPrimaryTag();
  const [featureTags, setFeatureTags] = useState<string[]>([]);
  const [range, setRange] = useSharedRange();
  const [degree, setDegree] = useState(1);
  const binning = usePageBinning();
  
  const [sliderValues, setSliderValues] = useState<Map<string, number>>(new Map());
  
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (targetTag.length === 0 && featureTags.length === 0) return null;
    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Target', value: tagNames(targetTag, nameById) },
            { label: 'Features', value: tagNames(featureTags, nameById) },
          ],
        },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Settings',
          fields: [
            { label: 'Polynomial degree', value: String(degree) },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [targetTag, featureTags, nameById, range, degree, binning.settings]);
  useRegisterCaptureContext(captureSummary);
  
  const [state, run] = useAsyncAction(
    async (
      target: string,
      features: string[],
      r: TimeRange,
      deg: number,
      s: BinningSettings,
    ): Promise<AnalysisResult | null> => {
      if (features.length === 0) return null;
      
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const allTags = [target, ...features];
      
      // Run all three queries in parallel.
      const [corrTable, sensTable, regTable] = await Promise.all([
        executeKql(
          buildCorrelationMatrixQuery({
            tagIds: allTags,
            start: r.start,
            end: r.end,
            binKql: bin.kql,
            aggregation: s.aggregation,
          }),
        ),
        executeKql(
          buildSensitivityQuery({
            targetTagId: target,
            featureTagIds: features,
            start: r.start,
            end: r.end,
            binKql: bin.kql,
            aggregation: s.aggregation,
          }),
        ),
        executeKql(
          buildRegressionQuery({
            targetTagId: target,
            featureTagIds: features,
            start: r.start,
            end: r.end,
            binKql: bin.kql,
            aggregation: s.aggregation,
            degree: deg,
          }),
        ),
      ]);
      
      return {
        correlations: parseCorrelationMatrix(corrTable),
        sensitivity: parseSensitivityResult(sensTable),
        fits: parseRegressionFit(regTable),
        targetTagId: target,
        featureTagIds: features,
      };
    },
  );
  
  const analyze = () => {
    if (targetTag.length === 0 || featureTags.length === 0) return;
    run(targetTag[0], featureTags, range, degree, binning.settings).catch(() => {});
  };
  
  const result = state.data;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'regression',
    title: 'Regression',
    fields: [
      tagField({
        name: 'target',
        label: 'Target',
        tags,
        current: targetTag,
        set: setTargetTag,
        description: 'Target signal to explain.',
      }),
      tagField({
        name: 'features',
        label: 'Features',
        tags,
        current: featureTags,
        set: (ids) => setFeatureTags(ids.slice(0, 10)),
        multi: true,
        description: 'One or more driver signals to test, up to 10.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf('degree', 'Polynomial degree', degree, [
          { value: 1, label: '1 (Linear)' },
          { value: 2, label: '2 (Quadratic)' },
          { value: 3, label: '3 (Cubic)' },
          { value: 4, label: '4 (Quartic)' },
        ]),
        apply: (v) => setDegree(coerce.enumValue(v, [1, 2, 3, 4]) as number),
      },
    ],
    canRun: targetTag.length > 0 && featureTags.length > 0 && !state.loading,
    run: analyze,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });
  
  // Initialize slider values when result changes (using mean of actual values).
  useMemo(() => {
    if (!result) return;
    const newVals = new Map<string, number>();
    for (const fit of result.fits) {
      if (!sliderValues.has(fit.featureTagId)) {
        const stats = computeStats(fit.targetSeries);
        newVals.set(fit.featureTagId, stats.mean || 0);
      } else {
        newVals.set(fit.featureTagId, sliderValues.get(fit.featureTagId)!);
      }
    }
    setSliderValues(newVals);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  
  // Compute what-if prediction.
  const prediction = useMemo(() => {
    if (!result || result.fits.length === 0) return null;
    const coeffs = result.fits.map((f) => ({ slope: f.slope, intercept: f.intercept }));
    const featVals = result.fits.map((f) => sliderValues.get(f.featureTagId) ?? 0);
    const pred = predictWhatIf(coeffs, featVals);
    const actualMean = computeStats(result.fits[0].targetSeries).mean || 0;
    const delta = pred - actualMean;
    return { value: pred, delta, actualMean };
  }, [result, sliderValues]);
  
  // Correlation heatmap option.
  const corrOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const allTags = [result.targetTagId, ...result.featureTagIds];
    const matrix = buildSymmetricCorrelationMatrix(result.correlations, allTags);
    const data: [number, number, number][] = [];
    allTags.forEach((rowTag, i) => {
      const row = matrix.get(rowTag);
      allTags.forEach((colTag, j) => {
        const val = row?.get(colTag) ?? 0;
        data.push([j, i, val]);
      });
    });
    const labels = allTags.map((id) => labeler(id, nameById.get(id)));
    return {
      animation: false,
      grid: { left: 160, right: 80, top: 40, bottom: 80 },
      tooltip: {
        position: 'top',
        formatter: (p: unknown) => {
          const params = p as { data: [number, number, number] };
          const [x, y, val] = params.data;
          return `${labels[y]} × ${labels[x]}<br/>r = ${val.toFixed(tooltipDecimals)}`;
        },
      },
      xAxis: {
        type: 'category',
        data: labels,
        splitArea: { show: true },
        axisLabel: { rotate: 45, interval: 0 },
      },
      yAxis: {
        type: 'category',
        data: labels,
        splitArea: { show: true },
      },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: 'vertical',
        right: 10,
        top: 'center',
        inRange: {
          color: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'],
        },
      },
      series: [
        {
          name: 'Correlation',
          type: 'heatmap',
          data,
          label: { show: false },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0, 0, 0, 0.5)' } },
        },
      ],
    };
  }, [result, nameById, labeler, tooltipDecimals]);
  
  // Feature ranking (tornado chart) option.
  const rankOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const sens = result.sensitivity;
    const data = sens.map((s) => s.rsquare);
    const labels = sens.map((s) => labeler(s.featureTagId, nameById.get(s.featureTagId)));
    return {
      animation: false,
      grid: { left: 160, right: 80, top: 40, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (p: unknown) => {
          const params = p as { name: string; value: number }[];
          if (!params || params.length === 0) return '';
          const { name, value } = params[0];
          return `${name}<br/>R² = ${value.toFixed(tooltipDecimals)}`;
        },
      },
      xAxis: { type: 'value', name: 'R²', max: 1 },
      yAxis: {
        type: 'category',
        data: labels,
        axisLabel: { interval: 0 },
      },
      series: [
        {
          name: 'R²',
          type: 'bar',
          data: data.map((val, i) => ({
            value: val,
            itemStyle: { color: val < 0.01 ? tokens.colorNeutralForeground4 : PALETTE[i % PALETTE.length] },
          })),
          label: { show: true, position: 'right', formatter: (p: { value: number }) => p.value.toFixed(3) },
        },
      ],
    };
  }, [result, nameById, labeler, tooltipDecimals]);
  
  // Regression fit chart option (actual + fitted for best feature).
  const fitOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || result.fits.length === 0) return {};
    const bestFit = result.fits[0]; // First is highest R² from sensitivity.
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const pair = (arr: (number | null)[]) =>
      bestFit.timestamps.map((t, i) => [t, arr[i]] as [number, number | null]);
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 48, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: {
        type: 'scroll',
        top: 0,
        data: ['Actual', 'Fitted'],
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          name: 'Actual',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.5, color: HISTORY_COLOR },
          itemStyle: { color: HISTORY_COLOR },
          data: pair(bestFit.targetSeries),
        },
        {
          name: 'Fitted',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.75, color: FITTED_COLOR, type: 'dashed' },
          itemStyle: { color: FITTED_COLOR },
          data: pair(bestFit.fittedSeries),
        },
      ],
    };
  }, [result, tooltipDecimals]);
  
  const correlationChartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    const allTags = [result.targetTagId, ...result.featureTagIds];
    const matrix = buildSymmetricCorrelationMatrix(result.correlations, allTags);
    return {
      columns: ['Feature A', 'Feature B', 'Correlation (r)'],
      rows: allTags.flatMap((rowTag) => {
        const row = matrix.get(rowTag);
        return allTags.map((colTag) => [
          labeler(rowTag, nameById.get(rowTag)),
          labeler(colTag, nameById.get(colTag)),
          row?.get(colTag) ?? 0,
        ]);
      }),
    };
  };

  const sensitivityChartData = (): ChartData => ({
    columns: ['Feature', 'Effect (R²)'],
    rows:
      result?.sensitivity.map((s) => [
        labeler(s.featureTagId, nameById.get(s.featureTagId)),
        s.rsquare,
      ]) ?? [],
  });

  const fitChartData = (): ChartData => {
    const bestFit = result?.fits[0];
    if (!bestFit) return { columns: [], rows: [] };
    return {
      columns: ['Timestamp', 'Observed', 'Predicted'],
      rows: bestFit.timestamps.map((t, i) => [
        new Date(t * 1000).toISOString(),
        bestFit.targetSeries[i] ?? null,
        bestFit.fittedSeries[i] ?? null,
      ]),
    };
  };
  
  const exportCoefficients = () => {
    if (!result) return;
    const rows = result.sensitivity.map((s) => {
      const name = nameById.get(s.featureTagId) ?? s.featureTagId;
      return `${name},${s.rsquare.toFixed(6)},${s.slope.toFixed(6)},${s.intercept.toFixed(6)}`;
    });
    const csv = ['Feature,R²,Slope,Intercept', ...rows].join('\n');
    downloadText(`regression_coefficients_${fileStamp()}.csv`, csv);
  };
  
  return (
    <div className={styles.root}>
      <Subtitle1>Regression & Sensitivity</Subtitle1>

      <PageIntro
        title="Regression"
        overview={EXPLAINERS.regression.overview}
        interpretation={EXPLAINERS.regression.interpretation}
        technical={EXPLAINERS.regression.technical}
      />
      
      <div className={styles.threePanel}>
        {/* Panel A — Setup */}
        <div className={styles.setup}>
          <Subtitle2>Setup</Subtitle2>
          <TagSelect
            label="Target (what to explain)"
            tags={tags}
            selected={targetTag}
            onChange={setTargetTag}
            info={EXPLAINERS.regression.inputs!.target}
          />
          <TagSelect
            label="Features (drivers)"
            tags={tags}
            selected={featureTags}
            onChange={(ids) => setFeatureTags(ids.slice(0, 10))}
            multiselect
            info={EXPLAINERS.regression.inputs!.features}
          />
          <Field label={withInfo('Polynomial degree', EXPLAINERS.regression.inputs!.degree)}>
            <Select value={String(degree)} onChange={(_, d) => setDegree(Number(d.value))}>
              <option value="1">1 (Linear)</option>
              <option value="2">2 (Quadratic)</option>
              <option value="3">3 (Cubic)</option>
              <option value="4">4 (Quartic)</option>
            </Select>
          </Field>
          <AdaptiveBinningPanel
            range={range}
            onRangeChange={setRange}
            signals={[...targetTag, ...featureTags].map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
            rangeInfo={EXPLAINERS.regression.inputs!.range}
            settings={binning.settings}
            onChange={binning.patch}
            onSaveAsDefault={binning.saveAsDefault}
            onReset={binning.resetToDefault}
            isCustom={binning.isCustom}
            disabled={state.loading}
            densityTagIds={[...targetTag, ...featureTags]}
            densityEnabled={!state.loading}
          />
          <div className={styles.actionRow}>
            <Button
              appearance="primary"
              disabled={targetTag.length === 0 || featureTags.length === 0 || state.loading}
              onClick={analyze}
            >
              {state.loading ? <Spinner size="tiny" /> : 'Analyze'}
            </Button>
          </div>
        </div>
        
        {/* Panel B — Results */}
        <div className={styles.results}>
          {state.error && (
            <ErrorMessageBar error={state.error} />
          )}
          <Card className={styles.card}>
            <div className={styles.cardActions}>
              <Subtitle2>Correlation Matrix</Subtitle2>
            </div>
            {result ? (
              <>
                <Caption1>Pairwise Pearson correlation between target and features.</Caption1>
                <OutputDescription label="Correlation matrix">
                  {EXPLAINERS.regression.outputs!.correlationMatrix}
                </OutputDescription>
                <ChartFrame
                  option={corrOption}
                  height={360}
                  fileName="correlation"
                  data={correlationChartData}
                />
              </>
            ) : (
              <Body1>
                {state.loading
                  ? 'Computing correlations\u2026'
                  : 'Select a target, features, and range, then Analyze.'}
              </Body1>
            )}
          </Card>
          
          <Card className={styles.card}>
            <div className={styles.cardActions}>
              <Subtitle2>Feature Importance (R²)</Subtitle2>
            </div>
            {result ? (
              <>
                <Caption1>Univariate R² for each feature (tornado chart, sorted descending).</Caption1>
                <OutputDescription label="Feature importance">
                  {EXPLAINERS.regression.outputs!.featureImportance}
                </OutputDescription>
                <ChartFrame
                  option={rankOption}
                  height={Math.max(200, result.sensitivity.length * 40)}
                  fileName="sensitivity"
                  data={sensitivityChartData}
                />
              </>
            ) : (
              <Body1>{state.loading ? 'Ranking features\u2026' : ''}</Body1>
            )}
          </Card>
          
          <Card className={styles.card}>
            <div className={styles.cardActions}>
              <Subtitle2>Regression Fit</Subtitle2>
              <div className={styles.spacer} />
              {result && (
                <Button appearance="subtle" size="small" onClick={exportCoefficients}>
                  Coefficients CSV
                </Button>
              )}
            </div>
            {result && result.fits.length > 0 ? (
              <>
                <Caption1>
                  Actual vs. fitted for best feature (R² ={' '}
                  {result.fits[0].rsquare.toFixed(4)}).
                </Caption1>
                <OutputDescription label="Regression fit">
                  {EXPLAINERS.regression.outputs!.regressionFit}
                </OutputDescription>
                <ChartFrame option={fitOption} height={420} fileName="fit" data={fitChartData} />
              </>
            ) : (
              <Body1>{state.loading ? 'Fitting regression\u2026' : ''}</Body1>
            )}
          </Card>
        </div>
        
        {/* Panel C — What-if sliders */}
        <div className={styles.whatif}>
          <Subtitle2>What-If Analysis</Subtitle2>
          <OutputDescription label="What-if analysis">
            {EXPLAINERS.regression.outputs!.whatIf}
          </OutputDescription>
          {prediction ? (
            <>
              <div className={styles.prediction}>
                <Label size="small">Predicted Target</Label>
                <div className={styles.predValue}>{prediction.value.toFixed(2)}</div>
                <div
                  className={styles.delta}
                  style={{
                    color: prediction.delta >= 0 ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1,
                  }}
                >
                  Δ = {prediction.delta >= 0 ? '+' : ''}
                  {prediction.delta.toFixed(2)}
                </div>
                <Caption1>(vs. mean {prediction.actualMean.toFixed(2)})</Caption1>
              </div>
              {result?.fits.map((fit) => {
                const stats = computeStats(fit.targetSeries);
                const min = stats.min || 0;
                const max = stats.max || 1;
                const val = sliderValues.get(fit.featureTagId) ?? stats.mean;
                return (
                  <div key={fit.featureTagId} className={styles.sliderGroup}>
                    <Label size="small">{labeler(fit.featureTagId, nameById.get(fit.featureTagId))}</Label>
                    <Slider
                      min={min}
                      max={max}
                      step={(max - min) / 100}
                      value={val}
                      onChange={(_, d) => {
                        const newVals = new Map(sliderValues);
                        newVals.set(fit.featureTagId, d.value);
                        setSliderValues(newVals);
                      }}
                    />
                    <Caption1>
                      {val.toFixed(2)} (range: {min.toFixed(2)} – {max.toFixed(2)})
                    </Caption1>
                  </div>
                );
              })}
            </>
          ) : (
            <Body1>Run an analysis to see what-if predictions.</Body1>
          )}
        </div>
      </div>
    </div>
  );
}
