import { useEffect, useMemo, useRef, useState } from 'react';
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
  Switch,
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
import { scenarioLimitDefaults } from '../lib/metadataDefaults';
import { useTerminology } from '../hooks/useTerminology';
import { usePageBinning } from '../context/BinningContext';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildAlignedSeriesQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseAlignedSeries } from '../lib/rootCause';
import {
  applyAdjustments,
  compareKpis,
  riskFlags,
  saveScenarioRun,
  type Adjustment,
  type KpiComparison,
  type RiskFlag,
} from '../lib/scenario';
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
  adjRow: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS },
  num: { width: '110px' },
  flags: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  delta: { fontWeight: tokens.fontWeightSemibold },
});

const SCENARIO_MODEL_NAME = 'whatif_scenario';
const SCENARIO_MODEL_VERSION = '1';

interface Baseline {
  tagId: string;
  t: number[];
  v: (number | null)[];
  binSeconds: number;
}

function defaultAdjustments(): Adjustment[] {
  return [
    { kind: 'scale', value: 1, enabled: false },
    { kind: 'offset', value: 0, enabled: false },
    { kind: 'ramp', rampTo: 0, enabled: false },
    { kind: 'clamp', min: undefined, max: undefined, enabled: false },
  ];
}

function fmtInt(seconds: number): string {
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)}d`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 60).toFixed(0)}m`;
}

export interface ScenarioPageProps {
  tags: TagInfo[];
}

/**
 * Simulation / what-if workspace (functional spec §Simulation). Clone a
 * baseline signal over a window, apply adjustments (scale, offset, ramp,
 * clamp), and compare KPIs (mean, peak, integral, time-above-limit) with risk
 * flags. Deterministic client-side projection — transparent and reproducible.
 */
export function ScenarioPage({ tags }: ScenarioPageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const tooltipDecimals = useTooltipDecimals();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });
  const [adjustments, setAdjustments] = useState<Adjustment[]>(defaultAdjustments);
  const [upperLimit, setUpperLimit] = useState('');
  const [lowerLimit, setLowerLimit] = useState('');
  const [name, setName] = useState('Scenario 1');
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  // Prefill the risk limits from the selected tag's governed metadata (operating
  // envelope, falling back to spec limits) once per selection, without clobbering
  // values the user has already entered. Fully overridable.
  const prefilledTagRef = useRef<string | null>(null);
  useEffect(() => {
    if (tag.length !== 1) {
      prefilledTagRef.current = null;
      return;
    }
    const id = tag[0];
    if (prefilledTagRef.current === id) return;
    prefilledTagRef.current = id;
    const d = scenarioLimitDefaults(tags.find((t) => t.tagId === id));
    if (upperLimit.trim() === '' && d.upperLimit != null) setUpperLimit(String(d.upperLimit));
    if (lowerLimit.trim() === '' && d.lowerLimit != null) setLowerLimit(String(d.lowerLimit));
  }, [tag, tags, upperLimit, lowerLimit]);

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    const enabledAdj = adjustments.filter((a) => a.enabled).map((a) => a.kind);
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Scenario',
          fields: [
            { label: 'Name', value: name },
            { label: 'Adjustments', value: enabledAdj.length ? enabledAdj.join(', ') : 'None' },
            { label: 'Upper limit', value: upperLimit.trim() || 'None' },
            { label: 'Lower limit', value: lowerLimit.trim() || 'None' },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [tag, nameById, range, adjustments, upperLimit, lowerLimit, name, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(async (tagId: string, r: TimeRange, settings: BinningSettings): Promise<Baseline | null> => {
    const bin = chooseBinFor({ start: r.start, end: r.end }, settings);
    const table = await executeKql(
      buildAlignedSeriesQuery({ tagIds: [tagId], start: r.start, end: r.end, binKql: bin.kql, aggregation: settings.aggregation }),
    );
    const aligned = parseAlignedSeries(table);
    const s = aligned.find((a) => a.tagId === tagId) ?? aligned[0];
    if (!s) return null;
    return { tagId, t: s.t, v: s.v, binSeconds: (bin.millis / 1000) };
  });

  const loadBaseline = () => {
    if (tag.length === 0) return;
    setSaveMsg(null);
    run(tag[0], range, binning.settings).catch(() => {});
  };

  const baseline = state.data;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'scenario',
    title: 'What-if scenario',
    fields: [
      tagField({
        tags,
        current: tag,
        set: setTag,
        label: 'Baseline signal',
        description: 'The baseline signal to load and adjust.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.string('upperLimit', 'Upper limit', upperLimit, {
          description: 'Optional upper risk limit; empty to disable.',
        }),
        apply: (v) => setUpperLimit(coerce.string(v)),
      },
      {
        field: pf.string('lowerLimit', 'Lower limit', lowerLimit, {
          description: 'Optional lower risk limit; empty to disable.',
        }),
        apply: (v) => setLowerLimit(coerce.string(v)),
      },
      {
        field: pf.string('name', 'Scenario name', name, {
          description: 'Name to use when saving the scenario.',
        }),
        apply: (v) => setName(coerce.string(v)),
      },
      {
        field: pf.boolean(
          'scaleEnabled',
          'Enable scale adjustment',
          adjustments.find((a) => a.kind === 'scale')?.enabled ?? false,
        ),
        apply: (v) => {
          const enabled = coerce.boolean(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'scale' ? { ...a, enabled } : a)),
          );
        },
      },
      {
        field: pf.number(
          'scaleFactor',
          'Scale factor',
          adjustments.find((a) => a.kind === 'scale')?.value ?? 1,
          { description: 'Multiplier applied when scale adjustment is enabled.' },
        ),
        apply: (v) => {
          const value = coerce.number(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'scale' ? { ...a, value } : a)),
          );
        },
      },
      {
        field: pf.boolean(
          'offsetEnabled',
          'Enable offset adjustment',
          adjustments.find((a) => a.kind === 'offset')?.enabled ?? false,
        ),
        apply: (v) => {
          const enabled = coerce.boolean(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'offset' ? { ...a, enabled } : a)),
          );
        },
      },
      {
        field: pf.number(
          'offset',
          'Offset',
          adjustments.find((a) => a.kind === 'offset')?.value ?? 0,
          { description: 'Additive constant applied when offset adjustment is enabled.' },
        ),
        apply: (v) => {
          const value = coerce.number(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'offset' ? { ...a, value } : a)),
          );
        },
      },
      {
        field: pf.boolean(
          'rampEnabled',
          'Enable ramp adjustment',
          adjustments.find((a) => a.kind === 'ramp')?.enabled ?? false,
        ),
        apply: (v) => {
          const enabled = coerce.boolean(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'ramp' ? { ...a, enabled } : a)),
          );
        },
      },
      {
        field: pf.number(
          'rampTo',
          'Ramp to',
          adjustments.find((a) => a.kind === 'ramp')?.rampTo ?? 0,
          { description: 'Total additive ramp amount at the end of the window.' },
        ),
        apply: (v) => {
          const rampTo = coerce.number(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'ramp' ? { ...a, rampTo } : a)),
          );
        },
      },
      {
        field: pf.boolean(
          'clampEnabled',
          'Enable clamp adjustment',
          adjustments.find((a) => a.kind === 'clamp')?.enabled ?? false,
        ),
        apply: (v) => {
          const enabled = coerce.boolean(v);
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'clamp' ? { ...a, enabled } : a)),
          );
        },
      },
      {
        field: pf.string(
          'clampMin',
          'Clamp minimum',
          String(adjustments.find((a) => a.kind === 'clamp')?.min ?? ''),
          { description: 'Optional lower clamp bound; empty to disable.' },
        ),
        apply: (v) => {
          const text = coerce.string(v);
          if (text.trim() === '') {
            setAdjustments((prev) =>
              prev.map((a) => (a.kind === 'clamp' ? { ...a, min: undefined } : a)),
            );
            return;
          }
          const n = Number(text);
          if (!Number.isFinite(n)) return 'clampMin: expected a number or blank';
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'clamp' ? { ...a, min: n } : a)),
          );
        },
      },
      {
        field: pf.string(
          'clampMax',
          'Clamp maximum',
          String(adjustments.find((a) => a.kind === 'clamp')?.max ?? ''),
          { description: 'Optional upper clamp bound; empty to disable.' },
        ),
        apply: (v) => {
          const text = coerce.string(v);
          if (text.trim() === '') {
            setAdjustments((prev) =>
              prev.map((a) => (a.kind === 'clamp' ? { ...a, max: undefined } : a)),
            );
            return;
          }
          const n = Number(text);
          if (!Number.isFinite(n)) return 'clampMax: expected a number or blank';
          setAdjustments((prev) =>
            prev.map((a) => (a.kind === 'clamp' ? { ...a, max: n } : a)),
          );
        },
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: loadBaseline,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!baseline,
  });

  const upper = useMemo(() => {
    const n = Number(upperLimit);
    return upperLimit.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }, [upperLimit]);
  const lower = useMemo(() => {
    const n = Number(lowerLimit);
    return lowerLimit.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }, [lowerLimit]);

  const scenarioValues = useMemo(
    () => (baseline ? applyAdjustments(baseline.v, adjustments) : []),
    [baseline, adjustments],
  );

  const kpis = useMemo<KpiComparison | null>(
    () => (baseline ? compareKpis(baseline.v, scenarioValues, baseline.binSeconds, upper) : null),
    [baseline, scenarioValues, upper],
  );

  const flags = useMemo<RiskFlag[]>(
    () => (kpis ? riskFlags(kpis, scenarioValues, { upperLimit: upper, lowerLimit: lower }) : []),
    [kpis, scenarioValues, upper, lower],
  );

  useEffect(() => {
    if (!baseline) return;
    const p = buildProvenance({
      outputType: 'scenario',
      tagId: baseline.tagId,
      modelName: SCENARIO_MODEL_NAME,
      modelVersion: SCENARIO_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: { adjustments: adjustments.filter((a) => a.enabled).map((a) => a.kind) },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline]);

  const updateAdj = (i: number, patch: Partial<Adjustment>) => {
    setAdjustments((prev) => prev.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  };

  const save = async () => {
    if (!baseline || !kpis) return;
    setSaveMsg(null);
    try {
      const id = await saveScenarioRun({
        name: name.trim() || 'Scenario',
        baseTagId: baseline.tagId,
        windowStart: range.start,
        windowEnd: range.end,
        adjustments,
        kpis,
        flags,
        featureVersion: FEATURE_VERSION,
      });
      setSaveMsg(id ? 'Scenario saved.' : 'Sign in with Fabric to save scenarios.');
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!baseline) return {};
    const basePairs = baseline.t.map((t, i) => [t, baseline.v[i] ?? null]);
    const scenPairs = baseline.t.map((t, i) => [t, scenarioValues[i] ?? null]);
    const series: echarts.SeriesOption[] = [
      {
        name: 'Baseline',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#605e5c' },
        itemStyle: { color: '#605e5c' },
        data: basePairs,
      },
      {
        name: 'Scenario',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.75, color: '#0f6cbd' },
        itemStyle: { color: '#0f6cbd' },
        data: scenPairs,
      },
    ];
    if (upper != null || lower != null) {
      series.push({
        name: 'Limits',
        type: 'line',
        data: [],
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#a4262c', type: 'dashed' },
          data: [
            ...(upper != null ? [{ yAxis: upper, label: { formatter: `Upper ${upper}` } }] : []),
            ...(lower != null ? [{ yAxis: lower, label: { formatter: `Lower ${lower}` } }] : []),
          ],
        },
      });
    }
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 36, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      legend: { top: 0, data: ['Baseline', 'Scenario'] },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', scale: true },
      series,
    };
  }, [baseline, scenarioValues, upper, lower, tooltipDecimals]);

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
    if (!baseline) return { columns: [], rows: [] };
    return {
      columns: ['Timestamp', 'Baseline', 'Scenario'],
      rows: baseline.t.map((t, i) => [
        new Date(t).toISOString(),
        baseline.v[i] ?? null,
        scenarioValues[i] ?? null,
      ]),
    };
  };

  const deltaCell = (base: number, scen: number, unit = '') => {
    const d = scen - base;
    const sign = d > 0 ? '+' : '';
    const color = Math.abs(d) < 1e-9 ? tokens.colorNeutralForeground3 : d > 0 ? tokens.colorPaletteRedForeground1 : tokens.colorPaletteGreenForeground1;
    return (
      <span className={styles.delta} style={{ color }}>
        {sign}
        {d.toFixed(2)}
        {unit}
      </span>
    );
  };

  return (
    <div className={styles.root}>
      <Subtitle1>What-if scenario</Subtitle1>

      <PageIntro
        title="What-if"
        overview={EXPLAINERS.scenario.overview}
        interpretation={EXPLAINERS.scenario.interpretation}
        technical={EXPLAINERS.scenario.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect
            label={`Baseline ${term.metricIdLabel.toLowerCase()}`}
            tags={tags}
            selected={tag}
            onChange={setTag}
            info={EXPLAINERS.scenario.inputs!.tag}
          />
        </div>
        <Field label={withInfo('Upper limit', EXPLAINERS.scenario.inputs!.upperLimit)} className={styles.num}>
          <Input type="number" placeholder="none" value={upperLimit} onChange={(_, d) => setUpperLimit(d.value)} />
        </Field>
        <Field label={withInfo('Lower limit', EXPLAINERS.scenario.inputs!.lowerLimit)} className={styles.num}>
          <Input type="number" placeholder="none" value={lowerLimit} onChange={(_, d) => setLowerLimit(d.value)} />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
        rangeInfo={EXPLAINERS.scenario.inputs!.range}
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={loadBaseline}>
          {state.loading ? <Spinner size="tiny" /> : 'Load baseline'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {baseline && (
        <Card className={styles.card}>
          <Subtitle2>Adjustments</Subtitle2>
          <div style={{ marginTop: tokens.spacingVerticalS }}>
            {adjustments.map((adj, i) => (
              <div key={adj.kind} className={styles.adjRow}>
                <Switch
                  label={adj.kind}
                  checked={adj.enabled}
                  onChange={(_, d) => updateAdj(i, { enabled: d.checked })}
                />
                {adj.kind === 'scale' && (
                  <Field label={withInfo('× factor', EXPLAINERS.scenario.inputs!.scale)} className={styles.num}>
                    <Input type="number" value={String(adj.value ?? 1)} onChange={(_, d) => updateAdj(i, { value: Number(d.value) })} />
                  </Field>
                )}
                {adj.kind === 'offset' && (
                  <Field label={withInfo('+ constant', EXPLAINERS.scenario.inputs!.offset)} className={styles.num}>
                    <Input type="number" value={String(adj.value ?? 0)} onChange={(_, d) => updateAdj(i, { value: Number(d.value) })} />
                  </Field>
                )}
                {adj.kind === 'ramp' && (
                  <Field label={withInfo('ramp to +', EXPLAINERS.scenario.inputs!.ramp)} className={styles.num}>
                    <Input type="number" value={String(adj.rampTo ?? 0)} onChange={(_, d) => updateAdj(i, { rampTo: Number(d.value) })} />
                  </Field>
                )}
                {adj.kind === 'clamp' && (
                  <>
                    <Field label={withInfo('min', EXPLAINERS.scenario.inputs!.min)} className={styles.num}>
                      <Input type="number" placeholder="none" value={adj.min == null ? '' : String(adj.min)} onChange={(_, d) => updateAdj(i, { min: d.value === '' ? undefined : Number(d.value) })} />
                    </Field>
                    <Field label={withInfo('max', EXPLAINERS.scenario.inputs!.max)} className={styles.num}>
                      <Input type="number" placeholder="none" value={adj.max == null ? '' : String(adj.max)} onChange={(_, d) => updateAdj(i, { max: d.value === '' ? undefined : Number(d.value) })} />
                    </Field>
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {baseline && (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Subtitle2>{labeler(baseline.tagId, nameById.get(baseline.tagId))}</Subtitle2>
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
          <OutputDescription label="Scenario chart">
            {EXPLAINERS.scenario.outputs!.chart}
          </OutputDescription>
          <ChartFrame
            option={annotatedOption}
            height={360}
            fileName="scenario"
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
                  disabled={!annot.currentUserId || !baseline}
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

      {kpis && (
        <Card className={styles.card}>
          <Subtitle2>KPI comparison</Subtitle2>
          <OutputDescription label="KPI comparison">
            {EXPLAINERS.scenario.outputs!.kpis}
          </OutputDescription>
          <Table size="small">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>KPI</TableHeaderCell>
                <TableHeaderCell>Baseline</TableHeaderCell>
                <TableHeaderCell>Scenario</TableHeaderCell>
                <TableHeaderCell>Delta</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Mean</TableCell>
                <TableCell>{kpis.baseline.mean.toFixed(2)}</TableCell>
                <TableCell>{kpis.scenario.mean.toFixed(2)}</TableCell>
                <TableCell>{deltaCell(kpis.baseline.mean, kpis.scenario.mean)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Peak</TableCell>
                <TableCell>{kpis.baseline.max.toFixed(2)}</TableCell>
                <TableCell>{kpis.scenario.max.toFixed(2)}</TableCell>
                <TableCell>{deltaCell(kpis.baseline.max, kpis.scenario.max)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Minimum</TableCell>
                <TableCell>{kpis.baseline.min.toFixed(2)}</TableCell>
                <TableCell>{kpis.scenario.min.toFixed(2)}</TableCell>
                <TableCell>{deltaCell(kpis.baseline.min, kpis.scenario.min)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Integral (value·s)</TableCell>
                <TableCell>{kpis.baseline.integral.toFixed(0)}</TableCell>
                <TableCell>{kpis.scenario.integral.toFixed(0)}</TableCell>
                <TableCell>{deltaCell(kpis.baseline.integral, kpis.scenario.integral)}</TableCell>
              </TableRow>
              {upper != null && (
                <TableRow>
                  <TableCell>Time above limit</TableCell>
                  <TableCell>{fmtInt(kpis.baseline.timeAboveLimit)}</TableCell>
                  <TableCell>{fmtInt(kpis.scenario.timeAboveLimit)}</TableCell>
                  <TableCell>{deltaCell(kpis.baseline.timeAboveLimit / 3600, kpis.scenario.timeAboveLimit / 3600, 'h')}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {flags.length > 0 && (
            <OutputDescription label="Risk flags">
              {EXPLAINERS.scenario.outputs!.flags}
            </OutputDescription>
          )}
          <div className={styles.flags}>
            {flags.map((f, i) => (
              <Badge
                key={i}
                appearance="tint"
                color={f.severity === 'critical' ? 'danger' : f.severity === 'warning' ? 'warning' : 'informative'}
              >
                {f.message}
              </Badge>
            ))}
          </div>

          <div className={styles.adjRow} style={{ marginTop: tokens.spacingVerticalM }}>
            <Field label={withInfo('Scenario name', EXPLAINERS.scenario.inputs!.name)} style={{ minWidth: 220 }}>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Button appearance="primary" onClick={() => void save()}>
              Save scenario
            </Button>
            {saveMsg && <Caption1>{saveMsg}</Caption1>}
          </div>
        </Card>
      )}

      {!baseline && !state.loading && (
        <Body1>Pick a baseline signal and range, then load the baseline to build a scenario.</Body1>
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
