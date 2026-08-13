import { useEffect, useMemo, useState } from 'react';
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
  Input,
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
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { useTerminology } from '../hooks/useTerminology';
import { usePageBinning } from '../context/BinningContext';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildAlignedSeriesQuery, buildAnomalyDiagnosisQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import {
  parseAlignedSeries,
  rankCauses,
  buildCauseEdges,
  propagationOrder,
  type CauseRanking,
  type AlignedSeries,
} from '../lib/rootCause';
import { parseAnomalyDiagnosis, type AnomalyDiagnosis } from '../lib/anomalyDiagnosis';
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

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Driver-pattern and signal columns hold long (concatenated) signal names;
  // let the flex cell shrink and wrap rather than overlap the next column.
  wrapCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
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
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalL, minWidth: 0 },
  lead: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold },
  lag: { color: tokens.colorNeutralForeground3 },
});

const RCA_MODEL_NAME = 'lagged_cross_correlation';
const RCA_MODEL_VERSION = '1';
const DIAG_MODEL_NAME = 'anomaly_diffpatterns';
const DIAG_MODEL_VERSION = '1';

/** Analysis mode: rank lagged drivers, or explain anomalous bins. */
type RcaMode = 'relationships' | 'diagnose';

const MODE_OPTIONS: { value: RcaMode; label: string }[] = [
  { value: 'relationships', label: 'Rank drivers (lagged correlation)' },
  { value: 'diagnose', label: 'Diagnose anomalies (diffpatterns)' },
];

/** series_decompose_anomalies sensitivity presets (lower = flags more bins). */
const DIAG_SENSITIVITY_OPTIONS: { value: number; label: string }[] = [
  { value: 3.0, label: 'Low (fewer anomalies)' },
  { value: 1.5, label: 'Medium (default)' },
  { value: 0.5, label: 'High (more anomalies)' },
];

interface RcaResult {
  targetTagId: string;
  causes: CauseRanking[];
  binSeconds: number;
  aligned: AlignedSeries[];
}

function fmtSeconds(s: number): string {
  const a = Math.abs(s);
  if (a < 60) return `${s.toFixed(0)}s`;
  if (a < 3600) return `${(s / 60).toFixed(1)}m`;
  if (a < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

export interface RootCausePageProps {
  tags: TagInfo[];
}

/**
 * Root Cause workspace (functional spec §Root-cause). Given a target signal and
 * candidate drivers over an incident window, ranks likely contributors by
 * lagged cross-correlation, shows the propagation order (which signal moved
 * first), and renders a directed cause→effect graph. Explicitly frames results
 * as hypotheses (correlation ≠ causation).
 */
export function RootCausePage({ tags }: RootCausePageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const tooltipDecimals = useTooltipDecimals();
  const [target, setTarget] = useSharedPrimaryTag();
  const [candidates, setCandidates] = useState<string[]>([]);
  const [range, setRange] = useSharedRange();
  const [maxLagBins, setMaxLagBins] = useState(30);
  const [mode, setMode] = useState<RcaMode>('relationships');
  const [sensitivity, setSensitivity] = useState(1.5);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (target.length === 0 && candidates.length === 0) return null;
    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Target', value: tagNames(target, nameById) },
            { label: 'Candidate drivers', value: tagNames(candidates, nameById) },
          ],
        },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Settings',
          fields: [
            { label: 'Mode', value: MODE_OPTIONS.find((m) => m.value === mode)?.label ?? mode },
            ...(mode === 'relationships'
              ? [{ label: 'Max lag', value: `${maxLagBins} bins` }]
              : [
                  {
                    label: 'Anomaly sensitivity',
                    value:
                      DIAG_SENSITIVITY_OPTIONS.find((s) => s.value === sensitivity)?.label ??
                      String(sensitivity),
                  },
                ]),
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [target, candidates, nameById, range, mode, maxLagBins, sensitivity, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      targetId: string,
      candidateIds: string[],
      r: TimeRange,
      lag: number,
      settings: BinningSettings,
    ): Promise<RcaResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, settings);
      const allTags = [targetId, ...candidateIds.filter((c) => c !== targetId)];
      const table = await executeKql(
        buildAlignedSeriesQuery({ tagIds: allTags, start: r.start, end: r.end, binKql: bin.kql, aggregation: settings.aggregation }),
      );
      const aligned = parseAlignedSeries(table);
      const targetSeries = aligned.find((a) => a.tagId === targetId);
      if (!targetSeries) return null;
      const candSeries = aligned.filter((a) => a.tagId !== targetId);
      const causes = rankCauses(targetSeries.v, candSeries, lag, (bin.millis / 1000));
      return { targetTagId: targetId, causes, binSeconds: (bin.millis / 1000), aligned };
    },
  );

  const [dstate, drun] = useAsyncAction(
    async (
      targetId: string,
      candidateIds: string[],
      r: TimeRange,
      sens: number,
      settings: BinningSettings,
    ): Promise<AnomalyDiagnosis | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, settings);
      const drivers = candidateIds.filter((c) => c !== targetId);
      if (drivers.length === 0) return null;
      const table = await executeKql(
        buildAnomalyDiagnosisQuery({
          targetTagId: targetId,
          candidateTagIds: drivers,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: settings.aggregation,
          sensitivity: sens,
        }),
      );
      return parseAnomalyDiagnosis(table, targetId, drivers);
    },
  );

  const analyze = () => {
    if (target.length === 0 || candidates.length === 0) return;
    if (mode === 'diagnose') {
      drun(target[0], candidates, range, sensitivity, binning.settings).catch(() => {});
    } else {
      run(target[0], candidates, range, maxLagBins, binning.settings).catch(() => {});
    }
  };

  const result = state.data;
  const diagnosis = dstate.data;
  const loading = state.loading || dstate.loading;
  const activeError = (mode === 'diagnose' ? dstate.error : state.error) ?? null;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'rootcause',
    title: 'Root cause',
    fields: [
      tagField({
        name: 'target',
        label: 'Target',
        tags,
        current: target,
        set: setTarget,
        description: 'The target signal to explain.',
      }),
      tagField({
        name: 'candidates',
        label: 'Candidate drivers',
        tags,
        current: candidates,
        set: setCandidates,
        multi: true,
        description: 'One or more candidate driver signals.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf(
          'mode',
          'Analysis mode',
          mode,
          MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          {
            description:
              'Rank drivers ranks candidates by lagged cross-correlation; Diagnose anomalies ' +
              'flags anomalous target bins and uses diffpatterns to find which driver regimes ' +
              'differentiate them.',
          },
        ),
        apply: (v) => setMode(coerce.enumValue(v, ['relationships', 'diagnose']) as RcaMode),
      },
      {
        field: pf.integer('maxLagBins', 'Max lag (bins)', maxLagBins, {
          min: 1,
          max: 200,
          description: 'Rank-drivers mode: maximum lead/lag distance to test, in bins.',
        }),
        apply: (v) => setMaxLagBins(coerce.integer(v, { min: 1, max: 200 })),
      },
      {
        field: pf.enumOf(
          'sensitivity',
          'Anomaly sensitivity',
          sensitivity,
          DIAG_SENSITIVITY_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: 'Diagnose-anomalies mode: series_decompose_anomalies sensitivity.' },
        ),
        apply: (v) =>
          setSensitivity(
            coerce.enumValue(v, DIAG_SENSITIVITY_OPTIONS.map((o) => o.value)) as number,
          ),
      },
    ],
    canRun: target.length > 0 && candidates.length > 0 && !state.loading && !dstate.loading,
    run: analyze,
    loading: state.loading || dstate.loading,
    error: (mode === 'diagnose' ? dstate.error : state.error) ?? undefined,
    hasResult: mode === 'diagnose' ? !!diagnosis : !!result,
  });

  useEffect(() => {
    if (!result) return;
    const p = buildProvenance({
      outputType: 'root_cause',
      tagId: result.targetTagId,
      modelName: RCA_MODEL_NAME,
      modelVersion: RCA_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        maxLagBins,
        topCause: result.causes[0]?.tagId,
        topCorrelation: result.causes[0]?.correlation,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  useEffect(() => {
    if (!diagnosis) return;
    const top = diagnosis.factors[0];
    const p = buildProvenance({
      outputType: 'root_cause',
      tagId: diagnosis.targetTagId,
      modelName: DIAG_MODEL_NAME,
      modelVersion: DIAG_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        anomalousBins: diagnosis.anomalousBins,
        normalBins: diagnosis.normalBins,
        topFactor: top ? top.pattern.map((t) => `${t.tagId}=${t.regime}`).join(' & ') : undefined,
        topContribution: top?.contribution,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosis]);

  const propagation = useMemo(() => (result ? propagationOrder(result.causes) : []), [result]);
  const edges = useMemo(
    () => (result ? buildCauseEdges(result.targetTagId, result.causes) : []),
    [result],
  );

  const graphOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || edges.length === 0) return {};
    const nodeIds = new Set<string>([result.targetTagId]);
    edges.forEach((e) => nodeIds.add(e.source));
    const nodes = Array.from(nodeIds).map((id) => ({
      name: labeler(id, nameById.get(id)),
      symbolSize: id === result.targetTagId ? 46 : 30,
      itemStyle: { color: id === result.targetTagId ? '#a4262c' : '#0f6cbd' },
    }));
    const links = edges.map((e) => ({
      source: labeler(e.source, nameById.get(e.source)),
      target: labeler(e.target, nameById.get(e.target)),
      value: e.correlation,
      label: {
        show: true,
        formatter: `${e.correlation >= 0 ? '+' : ''}${e.correlation.toFixed(2)} @ ${fmtSeconds(e.lagSeconds)}`,
        fontSize: 10,
      },
      lineStyle: {
        width: 1 + Math.abs(e.correlation) * 4,
        color: e.correlation >= 0 ? '#107c10' : '#a4262c',
        curveness: 0.15,
      },
    }));
    return {
      tooltip: {
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          label: { show: true, position: 'right' },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 10,
          force: { repulsion: 320, edgeLength: 160 },
          data: nodes,
          links,
        },
      ],
    };
  }, [result, edges, nameById, labeler, tooltipDecimals]);

  const graphData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['Source', 'Target', 'Score', 'Lag (s)'],
      rows: edges.map((e) => [
        labeler(e.source, nameById.get(e.source)),
        labeler(e.target, nameById.get(e.target)),
        e.correlation,
        e.lagSeconds,
      ]),
    };
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Root cause</Subtitle1>

      <PageIntro
        title="Root cause"
        overview={EXPLAINERS.rootcause.overview}
        interpretation={EXPLAINERS.rootcause.interpretation}
        technical={EXPLAINERS.rootcause.technical}
      />

      <div className={styles.controls}>
        <Field label={withInfo('Analysis mode', EXPLAINERS.rootcause.inputs!.mode)} style={{ minWidth: 260 }}>
          <Select value={mode} onChange={(_, d) => setMode(d.value as RcaMode)}>
            {MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <div style={{ minWidth: 240 }}>
          <TagSelect label={`Target ${term.metricIdLabel.toLowerCase()}`} tags={tags} selected={target} onChange={setTarget} info={EXPLAINERS.rootcause.inputs!.targetSignal} />
        </div>
        <div style={{ minWidth: 260 }}>
          <TagSelect label="Candidate drivers" tags={tags} selected={candidates} onChange={setCandidates} multiselect info={EXPLAINERS.rootcause.inputs!.candidateDrivers} />
        </div>
        {mode === 'relationships' ? (
          <Field label={withInfo('Max lag (bins)', EXPLAINERS.rootcause.inputs!.maxLagBins)} className={styles.num}>
            <Input
              type="number"
              min={1}
              max={200}
              value={String(maxLagBins)}
              onChange={(_, d) => {
                const n = Number(d.value);
                if (Number.isFinite(n) && n >= 1) setMaxLagBins(Math.floor(n));
              }}
            />
          </Field>
        ) : (
          <Field label={withInfo('Anomaly sensitivity', EXPLAINERS.rootcause.inputs!.sensitivity)} style={{ minWidth: 200 }}>
            <Select value={String(sensitivity)} onChange={(_, d) => setSensitivity(Number(d.value))}>
              {DIAG_SENSITIVITY_OPTIONS.map((o) => (
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
        signals={[...target, ...candidates].map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.rootcause.inputs!.range}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        disabled={loading}
        densityTagIds={[...target, ...candidates]}
        densityEnabled={!loading}
      />

      <div className={styles.actionRow}>
        <Button
          appearance="primary"
          disabled={target.length === 0 || candidates.length === 0 || loading}
          onClick={analyze}
        >
          {loading ? <Spinner size="tiny" /> : 'Analyze'}
        </Button>
      </div>

      {activeError && (
        <ErrorMessageBar error={activeError} />
      )}

      {mode === 'diagnose' ? (
        diagnosis ? (
          <Card className={styles.card}>
            <div className={styles.cardHead}>
              <Subtitle2>Contributing factors</Subtitle2>
              <div className={styles.spacer} />
              {provenance && <ProvenanceChip provenance={provenance} />}
            </div>
            <Caption1>
              Target: {labeler(diagnosis.targetTagId, nameById.get(diagnosis.targetTagId))}.{' '}
              {diagnosis.anomalousBins} anomalous vs {diagnosis.normalBins} normal bins. Driver
              regimes are per-bin: high / low = beyond ½·σ from that driver's mean.
            </Caption1>
            <OutputDescription label="Contributing factors">
              {EXPLAINERS.rootcause.outputs!.contributingFactors}
            </OutputDescription>
            {diagnosis.factors.length > 0 ? (
              <div className={styles.tableScroll}>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Driver regime pattern</TableHeaderCell>
                    <TableHeaderCell>Anomalous %</TableHeaderCell>
                    <TableHeaderCell>Normal %</TableHeaderCell>
                    <TableHeaderCell>Contribution</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diagnosis.factors.map((f) => (
                    <TableRow key={f.segmentId}>
                      <TableCell className={styles.wrapCell}>
                        {f.pattern
                          .map((t) => `${labeler(t.tagId, nameById.get(t.tagId))} = ${t.regime}`)
                          .join('  &  ')}
                      </TableCell>
                      <TableCell>{f.pctAnomalous.toFixed(1)}%</TableCell>
                      <TableCell>{f.pctNormal.toFixed(1)}%</TableCell>
                      <TableCell className={f.contribution >= 0 ? styles.lead : styles.lag}>
                        {f.contribution >= 0 ? '+' : ''}
                        {f.contribution.toFixed(1)} pts
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            ) : (
              <Body1>
                No driver regime pattern meaningfully differentiates anomalous from normal bins.
              </Body1>
            )}
          </Card>
        ) : (
          <Card className={styles.card}>
            <Body1>
              {loading
                ? 'Diagnosing anomalies\u2026'
                : 'Choose a target signal, candidate drivers, and the incident window, then Analyze.'}
            </Body1>
          </Card>
        )
      ) : result ? (
        <div className={styles.grid}>
          <Card className={styles.card}>
            <div className={styles.cardHead}>
              <Subtitle2>Ranked candidate causes</Subtitle2>
              <div className={styles.spacer} />
              {provenance && <ProvenanceChip provenance={provenance} />}
            </div>
            <Caption1>
              Target: {labeler(result.targetTagId, nameById.get(result.targetTagId))}. Lead = candidate
              moved first.
            </Caption1>
            <OutputDescription label="Ranked candidate causes">
              {EXPLAINERS.rootcause.outputs!.rankedCauses}
            </OutputDescription>
            <div className={styles.tableScroll}>
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Signal</TableHeaderCell>
                  <TableHeaderCell>Correlation</TableHeaderCell>
                  <TableHeaderCell>Lead / lag</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.causes.map((c) => (
                  <TableRow key={c.tagId}>
                    <TableCell className={styles.wrapCell}>{labeler(c.tagId, nameById.get(c.tagId))}</TableCell>
                    <TableCell>
                      {c.correlation >= 0 ? '+' : ''}
                      {c.correlation.toFixed(3)}
                    </TableCell>
                    <TableCell className={c.leads ? styles.lead : styles.lag}>
                      {c.leads ? `leads by ${fmtSeconds(c.lagSeconds)}` : `lags ${fmtSeconds(Math.abs(c.lagSeconds))}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </Card>

          <Card className={styles.card}>
            <div className={styles.cardHead}>
              <Subtitle2>Propagation & cause graph</Subtitle2>
            </div>
            {propagation.length > 0 ? (
              <Caption1>
                Propagation order:{' '}
                {propagation.map((c, i) => (
                  <span key={c.tagId}>
                    {i > 0 ? ' → ' : ''}
                    {labeler(c.tagId, nameById.get(c.tagId))}
                  </span>
                ))}{' '}
                → {labeler(result.targetTagId, nameById.get(result.targetTagId))}
              </Caption1>
            ) : (
              <Caption1>No leading drivers passed the correlation threshold.</Caption1>
            )}
            {edges.length > 0 ? (
              <>
                <OutputDescription label="Propagation graph">
                  {EXPLAINERS.rootcause.outputs!.graph}
                </OutputDescription>
                <ChartFrame option={graphOption} height={360} fileName="root_cause" data={graphData} />
              </>
            ) : (
              <Body1>No strong directed relationships to graph.</Body1>
            )}
          </Card>
        </div>
      ) : (
        <Card className={styles.card}>
          <Body1>
            {loading
              ? 'Analyzing signal relationships\u2026'
              : 'Choose a target signal, candidate drivers, and the incident window, then Analyze.'}
          </Body1>
        </Card>
      )}
    </div>
  );
}
