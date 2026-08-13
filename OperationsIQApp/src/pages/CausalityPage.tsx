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
  Spinner,
  Subtitle1,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { useTerminology } from '../hooks/useTerminology';
import { usePageBinning } from '../context/BinningContext';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { buildAlignedSeriesQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseAlignedSeries } from '../lib/rootCause';
import { buildCausalityMatrix, causalEdges, type CausalityMatrix, type CausalEdge } from '../lib/causality';
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
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import { ProvenanceChip } from '../components/ProvenanceChip';
import { buildProvenance, writeModelOutput, FEATURE_VERSION, type Provenance } from '../lib/provenance';
import type { ChartData } from '../lib/export';

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
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.spacingHorizontalL, minWidth: 0 },
});

const CAUSALITY_MODEL_NAME = 'linear_granger_causality';
const CAUSALITY_MODEL_VERSION = '1';

interface CausalityResult {
  matrix: CausalityMatrix;
  edges: CausalEdge[];
  lag: number;
}

export interface CausalityPageProps {
  tags: TagInfo[];
}

/**
 * Causality matrix workspace (functional spec §Causality). Computes pairwise
 * linear Granger causality across the selected signals and shows both a
 * source→target heatmap and a directed graph of the strongest influences. These
 * are predictive screening results — hypotheses to confirm, not proof.
 */
export function CausalityPage({ tags }: CausalityPageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const tooltipDecimals = useTooltipDecimals();
  const [selected, setSelected] = useSharedTags();
  const [range, setRange] = useSharedRange();
  const [lag, setLag] = useState(5);
  const [threshold, setThreshold] = useState(0.1);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (selected.length === 0) return null;
    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Signals', value: tagNames(selected, nameById) },
            { label: 'Signals selected', value: String(selected.length) },
          ],
        },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Settings',
          fields: [
            { label: 'Max lag', value: `${lag} bins` },
            { label: 'Edge threshold', value: String(threshold) },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [selected, nameById, range, lag, threshold, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (tagIds: string[], r: TimeRange, p: number, thr: number, settings: BinningSettings): Promise<CausalityResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, settings);
      const table = await executeKql(
        buildAlignedSeriesQuery({ tagIds, start: r.start, end: r.end, binKql: bin.kql, aggregation: settings.aggregation }),
      );
      const aligned = parseAlignedSeries(table);
      if (aligned.length < 2) return null;
      const matrix = buildCausalityMatrix(aligned, p);
      return { matrix, edges: causalEdges(matrix, thr), lag: p };
    },
  );

  const analyze = () => {
    if (selected.length < 2) return;
    run(selected, range, lag, threshold, binning.settings).catch(() => {});
  };

  const result = state.data;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'causality',
    title: 'Influence map',
    fields: [
      tagField({
        name: 'signals',
        label: 'Signals',
        tags,
        current: selected,
        set: setSelected,
        multi: true,
        description: 'Two or more signals to test for predictive influence.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.integer('lag', 'Lag (bins)', lag, {
          min: 1,
          max: 50,
          description: 'Maximum lag distance to test, in bins.',
        }),
        apply: (v) => setLag(coerce.integer(v, { min: 1, max: 50 })),
      },
      {
        field: pf.number('threshold', 'Edge threshold', threshold, {
          min: 0,
          max: 0.9,
          description: 'Minimum causality score shown as an edge.',
        }),
        apply: (v) => setThreshold(coerce.number(v, { min: 0, max: 0.9 })),
      },
    ],
    canRun: selected.length >= 2 && !state.loading,
    run: analyze,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  useEffect(() => {
    if (!result) return;
    const p = buildProvenance({
      outputType: 'causality',
      modelName: CAUSALITY_MODEL_NAME,
      modelVersion: CAUSALITY_MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        lag: result.lag,
        signals: result.matrix.tagIds.length,
        topEdge: result.edges[0]
          ? { source: result.edges[0].source, target: result.edges[0].target, score: result.edges[0].score }
          : null,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const heatmapOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const labels = result.matrix.tagIds.map((id) => labeler(id, nameById.get(id)));
    const data: [number, number, number][] = [];
    for (let i = 0; i < labels.length; i++) {
      for (let j = 0; j < labels.length; j++) {
        data.push([j, i, result.matrix.matrix[i][j]]);
      }
    }
    return {
      animation: false,
      grid: { left: 120, right: 24, top: 40, bottom: 100 },
      tooltip: {
        position: 'top',
        formatter: (pr: any) =>
          `${labels[pr.data[1]]} → ${labels[pr.data[0]]}<br/>score ${Number(pr.data[2]).toFixed(tooltipDecimals)}`,
      },
      xAxis: { type: 'category', data: labels, name: 'target', axisLabel: { rotate: 45, interval: 0 } },
      yAxis: { type: 'category', data: labels, name: 'source' },
      visualMap: {
        min: 0,
        max: Math.max(0.2, ...data.map((d) => d[2])),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        inRange: { color: ['#f3f2f1', '#5b9bd5', '#a4262c'] },
      },
      series: [
        {
          name: 'Granger score',
          type: 'heatmap',
          data,
          label: { show: labels.length <= 8, formatter: (pr: any) => (pr.data[2] > 0 ? Number(pr.data[2]).toFixed(3) : '') },
        },
      ],
    };
  }, [result, nameById, labeler, tooltipDecimals]);

  const graphOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || result.edges.length === 0) return {};
    const ids = new Set<string>();
    result.edges.forEach((e) => {
      ids.add(e.source);
      ids.add(e.target);
    });
    const nodes = Array.from(ids).map((id) => ({ name: labeler(id, nameById.get(id)), symbolSize: 34 }));
    const links = result.edges.map((e) => ({
      source: labeler(e.source, nameById.get(e.source)),
      target: labeler(e.target, nameById.get(e.target)),
      value: e.score,
      label: { show: true, formatter: e.score.toFixed(2), fontSize: 10 },
      lineStyle: { width: 1 + e.score * 6, color: '#0f6cbd', curveness: 0.15 },
    }));
    return {
      tooltip: {
        valueFormatter: (v: unknown) =>
          typeof v === 'number' ? v.toFixed(tooltipDecimals) : String(v ?? ''),
      },
      series: [
        {
          type: 'graph',
          layout: 'force',
          roam: true,
          label: { show: true, position: 'right' },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 10,
          force: { repulsion: 300, edgeLength: 150 },
          data: nodes,
          links,
        },
      ],
    };
  }, [result, nameById, labeler, tooltipDecimals]);

  const heatmapData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['Cause', 'Effect', 'Score'],
      rows: result.matrix.tagIds.flatMap((sourceId, i) =>
        result.matrix.tagIds.map((targetId, j) => [
          labeler(sourceId, nameById.get(sourceId)),
          labeler(targetId, nameById.get(targetId)),
          Number(result.matrix.matrix[i][j].toFixed(3)),
        ]),
      ),
    };
  };

  const graphData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['Source', 'Target', 'Strength', 'Lag (bins)'],
      rows: result.edges.map((e) => [
        labeler(e.source, nameById.get(e.source)),
        labeler(e.target, nameById.get(e.target)),
        e.score,
        result.lag,
      ]),
    };
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Influence map</Subtitle1>

      <PageIntro
        title="Influence map"
        overview={EXPLAINERS.causality.overview}
        interpretation={EXPLAINERS.causality.interpretation}
        technical={EXPLAINERS.causality.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 300 }}>
          <TagSelect label={`${term.metricIdLabelPlural} (2+)`} tags={tags} selected={selected} onChange={setSelected} multiselect info={EXPLAINERS.causality.inputs!.signals} />
        </div>
        <Field label={withInfo('Lag (bins)', EXPLAINERS.causality.inputs!.lag)} className={styles.num}>
          <Input
            type="number"
            min={1}
            max={50}
            value={String(lag)}
            onChange={(_, d) => setLag(Math.min(50, Math.max(1, Number(d.value) || 5)))}
          />
        </Field>
        <Field label={withInfo('Edge threshold', EXPLAINERS.causality.inputs!.edgeThreshold)} className={styles.num}>
          <Input
            type="number"
            min={0}
            max={0.9}
            step={0.05}
            value={String(threshold)}
            onChange={(_, d) => setThreshold(Math.min(0.9, Math.max(0, Number(d.value) || 0.1)))}
          />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={selected.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.causality.inputs!.range}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        disabled={state.loading}
        densityTagIds={selected}
        densityEnabled={!state.loading}
      />

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={selected.length < 2 || state.loading} onClick={analyze}>
          {state.loading ? <Spinner size="tiny" /> : 'Compute'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result ? (
        <div className={styles.grid}>
          <Card className={styles.card}>
            <div className={styles.cardHead}>
              <Subtitle2>Influence matrix</Subtitle2>
              <div className={styles.spacer} />
              {provenance && <ProvenanceChip provenance={provenance} />}
            </div>
            <Caption1>Row → column: how much the row signal's past helps predict the column signal.</Caption1>
            <OutputDescription label="Influence matrix">
              {EXPLAINERS.causality.outputs!.matrix}
            </OutputDescription>
            <ChartFrame option={heatmapOption} height={420} fileName="causality_matrix" data={heatmapData} />
          </Card>
          <Card className={styles.card}>
            <Subtitle2>Influence graph</Subtitle2>
            {result.edges.length > 0 ? (
              <>
                <OutputDescription label="Influence graph">
                  {EXPLAINERS.causality.outputs!.graph}
                </OutputDescription>
                <ChartFrame option={graphOption} height={420} fileName="causality_graph" data={graphData} />
              </>
            ) : (
              <Body1>No edges above the threshold. Lower the edge threshold to see weaker links.</Body1>
            )}
          </Card>
        </div>
      ) : (
        <Body1>
          {state.loading ? 'Computing causality\u2026' : 'Select two or more signals and a window, then Compute.'}
        </Body1>
      )}
    </div>
  );
}
