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
  Card,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
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
import { buildProcessMiningQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseProcessMining, mineSequences, validateBandModel, addBand, removeBand, DEFAULT_BAND_MODEL, type BandModel, type ProcessMining } from '../lib/processMining';
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
import { Add16Regular, Delete16Regular } from '@fluentui/react-icons';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { ProvenanceChip } from '../components/ProvenanceChip';
import { buildProvenance, writeModelOutput, FEATURE_VERSION, type Provenance } from '../lib/provenance';
import type { ChartData } from '../lib/export';
import { formatQueryInstant } from '../lib/timezone';
import { usePageBinning } from '../context/BinningContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { chooseBinFor, formatDuration, type BinningSettings } from '../lib/binningSettings';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Sequence keys can be long chains of state transitions; let the flex cell
  // shrink and wrap rather than overlap the Count column.
  wrapCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
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
  num: { width: '120px' },
  tableWrap: { marginTop: tokens.spacingVerticalM },
  bandEditor: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '360px' },
  bandRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  bandSwatch: { width: '14px', height: '14px', borderRadius: tokens.borderRadiusSmall, flexShrink: 0 },
  bandLabelInput: { flex: 1, minWidth: 0 },
  thresholdGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    width: '108px',
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  thresholdSpacer: { width: '108px', flexShrink: 0 },
  bandThreshold: { width: '90px' },
  bandActions: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: tokens.spacingVerticalXS },
});

const MODEL_NAME = 'scan_process_mining';
const MODEL_VERSION = '1';

// Fixed colors for the classic low / normal / high bands, so the default setup
// keeps its familiar look; any other band label falls back to a diverging
// cool -> warm palette indexed by its position (lowest to highest).
const LEGACY_STATE_COLORS: Record<string, string> = {
  low: '#0f6cbd',
  normal: '#107c10',
  high: '#a4262c',
};
const BAND_PALETTE = ['#0f6cbd', '#2b88d8', '#4f9f57', '#107c10', '#986f0b', '#d83b01', '#a4262c'];
const FALLBACK_COLOR = '#8a8886';

/** Color for a band, keyed by its label and its position among `total` bands (0 = lowest). */
function bandColor(state: string, index: number, total: number): string {
  if (LEGACY_STATE_COLORS[state]) return LEGACY_STATE_COLORS[state];
  if (!Number.isFinite(index) || index < 0) return FALLBACK_COLOR;
  if (total <= 1) return BAND_PALETTE[0];
  const pos = Math.round((index / (total - 1)) * (BAND_PALETTE.length - 1));
  return BAND_PALETTE[Math.min(BAND_PALETTE.length - 1, Math.max(0, pos))];
}

/** Parse a comma/space separated list of numbers (used by the page-controller thresholds field). */
function parseThresholdList(raw: string): number[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)),
    ),
  ).sort((a, b) => a - b);
}

/** Reconcile a band model to a new set of thresholds, padding/truncating labels to match. */
function withThresholds(model: BandModel, thresholds: number[]): BandModel {
  const need = thresholds.length + 1;
  const labels = [...model.labels];
  while (labels.length < need) labels.push(`band ${labels.length + 1}`);
  return { thresholds, labels: labels.slice(0, need) };
}

/** Reconcile a band model to a new set of labels, padding/truncating thresholds to match. */
function withLabels(model: BandModel, labels: string[]): BandModel {
  const need = Math.max(0, labels.length - 1);
  const thresholds = [...model.thresholds];
  while (thresholds.length < need) {
    const last = thresholds.length ? thresholds[thresholds.length - 1] : 0;
    thresholds.push(last + 10);
  }
  return { thresholds: thresholds.slice(0, need), labels };
}

interface ProcessResult {
  pm: ProcessMining;
  binSeconds: number;
}

/**
 * Process mining workspace. Derives discrete operating states (low / normal /
 * high) from a signal's value thresholds, uses the KQL `scan` operator to
 * collapse consecutive bins into episodes, and renders a state timeline plus a
 * table of the recurring operational sequences (with counts and median
 * durations) — e.g. how often a low→normal→high startup ramp occurs.
 */
export function ProcessMiningPage({ tags }: { tags: TagInfo[] }) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [bands, setBands] = useState<BandModel>(DEFAULT_BAND_MODEL);
  const [seqLength, setSeqLength] = useState(3);
  const binning = usePageBinning();
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const bandError = validateBandModel(bands);

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        { title: 'Time range', fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }] },
        {
          title: 'Configuration',
          fields: [
            { label: 'Bands', value: bands.labels.join(' < ') },
            { label: 'Thresholds', value: bands.thresholds.join(', ') },
            { label: 'Sequence length', value: `${seqLength} states` },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [tag, nameById, range, bands, seqLength, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      model: BandModel,
      seq: number,
      s: BinningSettings,
    ): Promise<ProcessResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const table = await executeKql(
        buildProcessMiningQuery({
          tagId,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
          thresholds: model.thresholds,
          bandLabels: model.labels,
        }),
      );
      const pm = parseProcessMining(table, (bin.millis / 1000), seq, model.labels);
      if (pm.episodes.length === 0) return null;
      return { pm, binSeconds: (bin.millis / 1000) };
    },
  );

  const analyze = () => {
    if (tag.length === 0 || bandError) return;
    run(tag[0], range, bands, seqLength, binning.settings).catch(() => {});
  };

  const result = state.data;

  // Re-mine sequences client-side when the length changes (no re-query needed).
  const sequences = useMemo(
    () => (result ? mineSequences(result.pm.episodes, seqLength) : []),
    [result, seqLength],
  );

  useControlledPage({
    pageKey: 'processmining',
    title: 'Process mining',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.string('thresholds', 'Thresholds', bands.thresholds.join(', '), {
          description:
            'Ascending value cut points, comma-separated. N thresholds define N+1 operating bands.',
        }),
        apply: (v) => setBands((b) => withThresholds(b, parseThresholdList(coerce.string(v)))),
      },
      {
        field: pf.string('bandLabels', 'Band labels', bands.labels.join(', '), {
          description:
            'Band names from lowest to highest, comma-separated. Should be one more than the thresholds.',
        }),
        apply: (v) =>
          setBands((b) =>
            withLabels(
              b,
              coerce
                .string(v)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ),
      },
      {
        field: pf.integer('seqLength', 'Sequence length', seqLength, {
          min: 2,
          max: 6,
          description: 'Number of consecutive states per mined sequence.',
        }),
        apply: (v) => setSeqLength(coerce.integer(v, { min: 2, max: 6 })),
      },
    ],
    canRun: tag.length > 0 && !bandError && !state.loading,
    run: analyze,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  useEffect(() => {
    if (!result) return;
    const pm = result.pm;
    const top = sequences[0];
    const p = buildProvenance({
      outputType: 'signal_validation',
      tagId: tag[0],
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        episodes: pm.episodes.length,
        states: pm.states.length,
        topSequence: top?.key,
        topSequenceCount: top?.count,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const pm = result.pm;
    const lanes = pm.states;
    const laneIndex = new Map(lanes.map((s, i) => [s, i]));
    const colorByState = new Map(lanes.map((s, i) => [s, bandColor(s, i, lanes.length)]));
    const data = pm.episodes.map((e) => ({
      value: [laneIndex.get(e.state) ?? 0, e.start, e.start + e.durationSeconds * 1000, e.state],
      itemStyle: { color: colorByState.get(e.state) ?? FALLBACK_COLOR },
    }));
    return {
      animation: false,
      tooltip: {
        formatter: (params: unknown) => {
          const p = params as { value: [number, number, number, string] };
          const v = p.value;
          const dur = (v[2] - v[1]) / 1000;
          return `State <b>${v[3]}</b><br/>${formatQueryInstant(v[1])}<br/>Duration ${formatDuration(dur)}`;
        },
      },
      grid: { left: 72, right: 24, top: 24, bottom: 56 },
      xAxis: { type: 'time', name: 'Time', nameLocation: 'middle', nameGap: 34 },
      yAxis: { type: 'category', data: lanes },
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', bottom: 8, height: 18 },
      ],
      series: [
        {
          type: 'custom',
          renderItem: (
            _params: unknown,
            api: {
              value: (i: number) => number;
              coord: (p: [number, number]) => [number, number];
              size: (p: [number, number]) => [number, number];
              style: () => Record<string, unknown>;
            },
          ) => {
            const categoryIndex = api.value(0);
            const startCoord = api.coord([api.value(1), categoryIndex]);
            const endCoord = api.coord([api.value(2), categoryIndex]);
            const bandHeight = api.size([0, 1])[1] * 0.6;
            const width = Math.max(1, endCoord[0] - startCoord[0]);
            return {
              type: 'rect',
              shape: {
                x: startCoord[0],
                y: startCoord[1] - bandHeight / 2,
                width,
                height: bandHeight,
              },
              style: api.style(),
            };
          },
          encode: { x: [1, 2], y: 0 },
          data,
        },
      ],
    };
  }, [result]);

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['State', 'Start', 'End', 'DurationSeconds'],
      rows: result.pm.episodes.map((e) => [
        e.state,
        new Date(e.start).toISOString(),
        new Date(e.start + e.durationSeconds * 1000).toISOString(),
        e.durationSeconds,
      ]),
    };
  };

  const pm = result?.pm ?? null;

  return (
    <div className={styles.root}>
      <Subtitle1>Process mining</Subtitle1>

      <PageIntro
        title="Process mining"
        overview={EXPLAINERS.processmining.overview}
        interpretation={EXPLAINERS.processmining.interpretation}
        technical={EXPLAINERS.processmining.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.processmining.inputs!.tag} />
        </div>
        <Field label={withInfo('Operating bands', EXPLAINERS.processmining.inputs!.bands)}>
          <div className={styles.bandEditor}>
            {[...bands.labels.keys()].reverse().map((bi) => (
              <div key={bi} className={styles.bandRow}>
                <span
                  className={styles.bandSwatch}
                  style={{ backgroundColor: bandColor(bands.labels[bi], bi, bands.labels.length) }}
                />
                <Input
                  className={styles.bandLabelInput}
                  aria-label={`Band ${bi + 1} name`}
                  value={bands.labels[bi]}
                  onChange={(_, d) =>
                    setBands((b) => ({ ...b, labels: b.labels.map((l, i) => (i === bi ? d.value : l)) }))
                  }
                />
                {bi > 0 ? (
                  <div className={styles.thresholdGroup}>
                    <Caption1>&#8805;</Caption1>
                    <Input
                      className={styles.bandThreshold}
                      type="number"
                      step="any"
                      aria-label={`Threshold between ${bands.labels[bi - 1]} and ${bands.labels[bi]}`}
                      value={String(bands.thresholds[bi - 1])}
                      onChange={(_, d) => {
                        const n = Number(d.value);
                        if (Number.isFinite(n)) {
                          setBands((b) => ({
                            ...b,
                            thresholds: b.thresholds.map((t, i) => (i === bi - 1 ? n : t)),
                          }));
                        }
                      }}
                    />
                  </div>
                ) : (
                  <span className={styles.thresholdSpacer} />
                )}
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<Delete16Regular />}
                  aria-label={`Remove ${bands.labels[bi]} band`}
                  disabled={bands.labels.length <= 2}
                  onClick={() => setBands((b) => removeBand(b, bi))}
                />
              </div>
            ))}
            <div className={styles.bandActions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<Add16Regular />}
                onClick={() => setBands((b) => addBand(b))}
              >
                Add band
              </Button>
            </div>
          </div>
        </Field>
        <Field label={withInfo('Sequence length', EXPLAINERS.processmining.inputs!.seqLength)} className={styles.num}>
          <Input
            type="number"
            min={2}
            max={6}
            value={String(seqLength)}
            onChange={(_, d) => {
              const n = Number(d.value);
              if (Number.isFinite(n) && n >= 2 && n <= 6) setSeqLength(Math.round(n));
            }}
          />
        </Field>
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

      {bandError && (
        <MessageBar intent="warning">
          <MessageBarBody>{bandError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.actionRow}>
        <Button
          appearance="primary"
          disabled={tag.length === 0 || !!bandError || state.loading}
          onClick={analyze}
        >
          {state.loading ? <Spinner size="tiny" /> : 'Mine process'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && pm ? (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Body1>{labeler(tag[0], nameById.get(tag[0]))}</Body1>
            <div className={styles.spacer} />
            {provenance && <ProvenanceChip provenance={provenance} />}
          </div>
          <OutputDescription label="State timeline">
            {EXPLAINERS.processmining.outputs!.timeline}
          </OutputDescription>
          <ChartFrame option={option} height={280} fileName="process_mining" data={chartData} />
          <Caption1>
            {pm.episodes.length} episodes across {pm.states.length} states.{' '}
            {pm.stateStats
              .map((s) => `${s.state}: ${s.episodes}× (${formatDuration(s.totalDurationSeconds)})`)
              .join(' · ')}
          </Caption1>

          <div className={styles.tableWrap}>
            <Subtitle2>Discovered sequences</Subtitle2>
            <OutputDescription label="Discovered sequences">
              {EXPLAINERS.processmining.outputs!.sequences}
            </OutputDescription>
            {sequences.length === 0 ? (
              <Caption1>
                No sequences of {seqLength} consecutive states were found. Try a shorter sequence
                length or a wider window.
              </Caption1>
            ) : (
              <div className={styles.tableScroll}>
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Sequence</TableHeaderCell>
                    <TableHeaderCell>Count</TableHeaderCell>
                    <TableHeaderCell>Median duration</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sequences.map((s) => (
                    <TableRow key={s.key}>
                      <TableCell className={styles.wrapCell}>{s.key}</TableCell>
                      <TableCell>{s.count}</TableCell>
                      <TableCell>{formatDuration(s.medianDurationSeconds)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </div>
        </Card>
      ) : (
        <Card className={styles.card}>
          <Body1>
            {state.loading
              ? 'Mining process states\u2026'
              : 'Choose a signal, define the operating bands and the window, then Mine process.'}
          </Body1>
        </Card>
      )}
    </div>
  );
}
