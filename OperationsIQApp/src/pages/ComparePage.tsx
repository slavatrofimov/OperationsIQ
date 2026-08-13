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
import { Add24Regular, Delete24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildExploreQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows } from '../lib/series';
import { PALETTE } from '../lib/series';
import { computeStats, type SeriesStats } from '../lib/stats';
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
import { defaultRange } from '../lib/appTypes';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { tooltipValueFormatter } from '../lib/exploreSettings';
import { usePageBinning } from '../context/BinningContext';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  spacer: { flex: 1 },
  controls: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  topRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  periodPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  periodRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  swatch: { width: '12px', height: '12px', borderRadius: '2px', flexShrink: 0 },
  periodLabel: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: '90px' },
  card: { padding: tokens.spacingVerticalL },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  num: { width: '120px' },
});

interface Period {
  id: number;
  range: TimeRange;
}

interface PeriodSeries {
  label: string;
  color: string;
  /** Elapsed seconds since the period start. */
  elapsed: number[];
  values: (number | null)[];
  stats: SeriesStats;
}

/** Format an elapsed duration (seconds) as a compact human string. */
function formatElapsed(sec: number): string {
  if (!Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem}s`;
  return `${rem}s`;
}

let nextPeriodId = 1;
function makePeriod(range: TimeRange): Period {
  return { id: nextPeriodId++, range };
}

export interface ComparePageProps {
  tags: TagInfo[];
}

/**
 * Period comparison: overlay one tag across several time windows aligned by
 * elapsed time from each window's start, with per-period summary statistics.
 */
export function ComparePage({ tags }: ComparePageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [sharedRange] = useSharedRange();
  const [periods, setPeriods] = useState<Period[]>(() => [
    makePeriod({ ...sharedRange }),
    makePeriod({ ...sharedRange }),
  ]);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Compared tag', value: tagNames(tag, nameById) }] },
        {
          title: 'Periods',
          fields: periods.map((p, i) => ({
            label: `Period ${i + 1}`,
            value: fmtWindow(p.range.start, p.range.end),
          })),
        },
        { title: 'Configuration', fields: binningFields(binning.settings) },
      ],
    };
  }, [tag, nameById, periods, binning.settings]);
  useRegisterCaptureContext(captureSummary);
  const tooltipDecimals = useTooltipDecimals();

  const [state, run] = useAsyncAction(
    async (tagId: string, ps: Period[], settings: BinningSettings): Promise<PeriodSeries[]> => {
      const results = await Promise.all(
        ps.map(async (p, i) => {
          const bin = chooseBinFor({ start: p.range.start, end: p.range.end }, settings);
          const table = await executeKql(
            buildExploreQuery({
              tagIds: [tagId],
              start: p.range.start,
              end: p.range.end,
              binKql: bin.kql,
              aggregation: settings.aggregation,
            }),
          );
          const parsed = parseExploreRows(table);
          const s = parsed[0];
          const startSec = p.range.start.getTime() / 1000;
          const elapsed = s ? s.x.map((t) => t - startSec) : [];
          const values = s ? s.values : [];
          return {
            label: `Period ${i + 1}`,
            color: PALETTE[i % PALETTE.length],
            elapsed,
            values,
            stats: computeStats(values),
          } as PeriodSeries;
        }),
      );
      return results;
    },
  );

  const compare = () => {
    if (tag.length === 0) return;
    run(tag[0], periods, binning.settings).catch(() => {});
  };

  const addPeriod = () => setPeriods((ps) => [...ps, makePeriod(defaultRange())]);
  const removePeriod = (id: number) => setPeriods((ps) => (ps.length > 1 ? ps.filter((p) => p.id !== id) : ps));
  const updatePeriod = (id: number, range: TimeRange) =>
    setPeriods((ps) => ps.map((p) => (p.id === id ? { ...p, range } : p)));

  const result = state.data;

  useControlledPage({
    pageKey: 'compare',
    title: 'Compare',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      ...periods.map((p, i) =>
        rangeField({
          current: p.range,
          set: (r) => updatePeriod(p.id, r),
          name: `period${i + 1}`,
          label: `Period ${i + 1}`,
          description: `Comparison window for period ${i + 1}.`,
        }),
      ),
      ...controllerBinningFields(binning),
    ],
    canRun: tag.length > 0 && !state.loading,
    run: compare,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result || result.length === 0) return {};
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 40, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { formatter: (p: { value: number }) => formatElapsed(p.value) } },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: result.map((r) => r.label) },
      xAxis: {
        type: 'value',
        name: 'Elapsed',
        nameLocation: 'middle',
        nameGap: 30,
        axisLabel: { formatter: (v: number) => formatElapsed(v) },
      },
      yAxis: { type: 'value', scale: true },
      series: result.map((r) => ({
        name: r.label,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.5, color: r.color },
        itemStyle: { color: r.color },
        data: r.elapsed.map((e, i) => [e, r.values[i]] as [number, number | null]),
      })),
    };
  }, [result, tooltipDecimals]);

  const fmt = (n: number) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '\u2014';
  const baseMean = result && result.length > 0 ? result[0].stats.mean : NaN;

  const chartData = (): ChartData => {
    if (!result || result.length === 0) return { columns: [], rows: [] };
    const base = result.reduce((a, b) => (b.elapsed.length > a.elapsed.length ? b : a), result[0]);
    return {
      columns: ['Elapsed (s)', ...result.map((r) => r.label)],
      rows: base.elapsed.map((e, i) => [Math.round(e), ...result.map((r) => r.values[i] ?? null)]),
    };
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Period comparison</Subtitle1>

      <PageIntro
        title="Compare"
        overview={EXPLAINERS.compare.overview}
        interpretation={EXPLAINERS.compare.interpretation}
        technical={EXPLAINERS.compare.technical}
      />

      <div className={styles.controls}>
        <div className={styles.topRow}>
          <div style={{ minWidth: 260 }}>
            <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.compare.inputs!.tag} />
          </div>
          <Button icon={<Add24Regular />} onClick={addPeriod}>
            Add period
          </Button>
        </div>
      </div>

      {periods.map((p, i) => (
        <div key={p.id} className={styles.periodPanel}>
          <div className={styles.periodRow}>
            <div className={styles.periodLabel}>
              <span className={styles.swatch} style={{ backgroundColor: PALETTE[i % PALETTE.length] }} />
              <Caption1>{`Period ${i + 1}`}</Caption1>
            </div>
            <Button
              appearance="subtle"
              icon={<Delete24Regular />}
              disabled={periods.length <= 1}
              onClick={() => removePeriod(p.id)}
              aria-label={`Remove period ${i + 1}`}
            />
          </div>
          <AdaptiveBinningPanel
            range={p.range}
            onRangeChange={(r) => updatePeriod(p.id, r)}
            signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
            rangeInfo={EXPLAINERS.compare.inputs!.period}
            settings={binning.settings}
            onChange={binning.patch}
            onSaveAsDefault={binning.saveAsDefault}
            onReset={binning.resetToDefault}
            isCustom={binning.isCustom}
            disabled={state.loading}
            densityTagIds={tag}
            densityEnabled={!state.loading}
          />
        </div>
      ))}

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={compare}>
          {state.loading ? <Spinner size="tiny" /> : 'Compare'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      <Card className={styles.card}>
        <div className={styles.cardActions}>
          <Subtitle2>{tag.length > 0 ? labeler(tag[0], nameById.get(tag[0])) : 'Overlay'}</Subtitle2>
        </div>
        {result && result.length > 0 ? (
          <>
            <Caption1>Periods aligned by elapsed time from each window&apos;s start.</Caption1>
            <OutputDescription label="Period overlay chart">
              {EXPLAINERS.compare.outputs!.overlayChart}
            </OutputDescription>
            <ChartFrame option={option} height={420} fileName="compare" data={chartData} />
          </>
        ) : (
          <Body1>
            {state.loading ? 'Loading periods\u2026' : 'Pick a tag and two or more periods, then choose Compare.'}
          </Body1>
        )}
      </Card>

      {result && result.length > 0 && (
        <Card className={styles.card}>
          <Subtitle2>Per-period statistics</Subtitle2>
          <OutputDescription label="Per-period statistics table">
            {EXPLAINERS.compare.outputs!.statisticsTable}
          </OutputDescription>
          <Table size="small" aria-label="Per-period statistics">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Period</TableHeaderCell>
                <TableHeaderCell>Count</TableHeaderCell>
                <TableHeaderCell>Mean</TableHeaderCell>
                <TableHeaderCell>Δ mean vs P1</TableHeaderCell>
                <TableHeaderCell>Min</TableHeaderCell>
                <TableHeaderCell>Max</TableHeaderCell>
                <TableHeaderCell>Std dev</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.map((r, i) => (
                <TableRow key={r.label}>
                  <TableCell>
                    <div className={styles.periodLabel}>
                      <span className={styles.swatch} style={{ backgroundColor: r.color }} />
                      {r.label}
                    </div>
                  </TableCell>
                  <TableCell>{r.stats.count}</TableCell>
                  <TableCell>{fmt(r.stats.mean)}</TableCell>
                  <TableCell>{i === 0 ? '\u2014' : fmt(r.stats.mean - baseMean)}</TableCell>
                  <TableCell>{fmt(r.stats.min)}</TableCell>
                  <TableCell>{fmt(r.stats.max)}</TableCell>
                  <TableCell>{fmt(r.stats.stdev)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
