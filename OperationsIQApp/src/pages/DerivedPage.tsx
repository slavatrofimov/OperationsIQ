import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useTerminology } from '../hooks/useTerminology';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildBinnedMultiSeriesQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, PALETTE, type ExploreSeries } from '../lib/series';
import { computeStats } from '../lib/stats';
import {
  compileExpression,
  evaluateSeries,
  rateOfChange,
  rollingMean,
} from '../lib/expression';
import {
  deleteDerivedMetric,
  listDerivedMetrics,
  saveDerivedMetric,
  type SavedDerivedMetricSummary,
} from '../lib/savedDerivedMetrics';
import { getFabricAccountId } from '../lib/rayfinClient';
import { useProfile } from '../context/ProfileContext';
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
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
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
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  row: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  formula: { minWidth: '360px', flex: 1 },
  legend: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  card: { padding: tokens.spacingVerticalL },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  num: { width: '120px' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  saveRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  saveName: { minWidth: '260px' },
  savedList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  savedItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  savedMeta: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  savedActions: { display: 'flex', gap: tokens.spacingHorizontalXS },
});

type Transform = 'none' | 'roc' | 'rollmean';

/** Alias labels assigned to selected tags in order: A, B, C, … */
function aliasFor(i: number): string {
  return String.fromCharCode(65 + i);
}

interface DerivedResult {
  x: number[];
  base: ExploreSeries[];
  aliases: string[];
  names: string[];
  derived: (number | null)[];
  label: string;
}

export interface DerivedPageProps {
  tags: TagInfo[];
}

/** Derived-metric calculator: compute a formula over aligned tag series. */
export function DerivedPage({ tags }: DerivedPageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const [selected, setSelected] = useSharedTags();
  const [range, setRange] = useSharedRange();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: selected, range, showMarkers: showOnChart });
  const [formula, setFormula] = useState('A - B');
  const [transform, setTransform] = useState<Transform>('none');
  const [window, setWindow] = useState(5);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (selected.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signals', value: tagNames(selected, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        {
          title: 'Derived metric',
          fields: [
            { label: 'Formula', value: formula },
            { label: 'Transform', value: transform },
            { label: 'Window', value: `${window} bins` },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [selected, nameById, range, formula, transform, window, binning.settings]);
  useRegisterCaptureContext(captureSummary);
  const tooltipDecimals = useTooltipDecimals();

  // Alias → tag mapping for the current selection.
  const aliasMap = useMemo(
    () => selected.map((id, i) => ({ alias: aliasFor(i), tagId: id, name: labeler(id, nameById.get(id)) })),
    [selected, nameById, labeler],
  );
  const allowedVars = useMemo(() => aliasMap.map((a) => a.alias), [aliasMap]);

  // Live compile so the user sees formula errors before running.
  const compiled = useMemo(() => compileExpression(formula, allowedVars), [formula, allowedVars]);

  const [state, run] = useAsyncAction(
    async (
      tagIds: string[],
      r: TimeRange,
      formulaSrc: string,
      tf: Transform,
      win: number,
      s: BinningSettings,
    ): Promise<DerivedResult | null> => {
      const compileRes = compileExpression(formulaSrc, tagIds.map((_, i) => aliasFor(i)));
      if (!compileRes.ok) throw new Error(compileRes.error);
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      // One query for all (distinct) operands instead of one per tag. The result
      // has one row per SignalId in arbitrary order, so key it back by tag id;
      // this also lets a formula reference the same tag under multiple aliases.
      const distinctIds = [...new Set(tagIds)];
      const table = await executeKql(
        buildBinnedMultiSeriesQuery({
          tagIds: distinctIds,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );
      const byId = new Map(parseExploreRows(table).map((row) => [row.tagId, row]));
      if (distinctIds.some((id) => !byId.has(id))) {
        throw new Error('One or more tags returned no data.');
      }
      const base = tagIds.map((id) => byId.get(id)!) as ExploreSeries[];
      const x = base[0].x;
      const length = x.length;
      const scope: Record<string, (number | null)[]> = {};
      tagIds.forEach((_, i) => {
        scope[aliasFor(i)] = base[i].values;
      });
      let derived = evaluateSeries(compileRes.expr, scope, length);
      let label = formulaSrc;
      if (tf === 'roc') {
        derived = rateOfChange(derived);
        label = `Δ(${formulaSrc})`;
      } else if (tf === 'rollmean') {
        derived = rollingMean(derived, win);
        label = `mean_${win}(${formulaSrc})`;
      }
      return {
        x,
        base,
        aliases: tagIds.map((_, i) => aliasFor(i)),
        names: tagIds.map((id) => labeler(id, nameById.get(id))),
        derived,
        label,
      };
    },
  );

  const compute = () => {
    if (selected.length === 0 || !compiled.ok) return;
    run(selected, range, formula, transform, window, binning.settings).catch(() => {});
  };

  // --- saved derived metrics (scoped to the active connection profile) ---
  const { activeProfile } = useProfile();
  const profileId = activeProfile?.id ?? '';
  const signedIn = !!getFabricAccountId();
  const [metricName, setMetricName] = useState('');
  const [savedMetrics, setSavedMetrics] = useState<SavedDerivedMetricSummary[]>([]);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const refreshMetrics = useCallback(() => {
    if (!signedIn || !profileId) {
      setSavedMetrics([]);
      return;
    }
    setMetricsBusy(true);
    setMetricsError(null);
    listDerivedMetrics(profileId)
      .then(setSavedMetrics)
      .catch((e) => setMetricsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetricsBusy(false));
  }, [signedIn, profileId]);

  useEffect(() => {
    refreshMetrics();
  }, [refreshMetrics]);

  const handleSaveMetric = () => {
    if (!compiled.ok || selected.length === 0 || !metricName.trim()) return;
    setMetricsBusy(true);
    setMetricsError(null);
    saveDerivedMetric(profileId, metricName, {
      tagIds: selected,
      formula,
      transform,
      window,
      maxBins: binning.settings.maxBins,
    })
      .then(() => {
        setMetricName('');
        refreshMetrics();
      })
      .catch((e) => {
        setMetricsError(e instanceof Error ? e.message : String(e));
        setMetricsBusy(false);
      });
  };

  const handleLoadMetric = (id: string) => {
    const m = savedMetrics.find((x) => x.id === id);
    if (!m) return;
    setSelected(m.definition.tagIds);
    setFormula(m.definition.formula);
    setTransform(m.definition.transform);
    setWindow(m.definition.window);
    binning.patch({ maxBins: m.definition.maxBins });
  };

  const handleDeleteMetric = (id: string) => {
    setMetricsBusy(true);
    setMetricsError(null);
    deleteDerivedMetric(id)
      .then(() => refreshMetrics())
      .catch((e) => {
        setMetricsError(e instanceof Error ? e.message : String(e));
        setMetricsBusy(false);
      });
  };

  const missingTagCount = (m: SavedDerivedMetricSummary): number =>
    m.definition.tagIds.filter((id) => !nameById.has(id)).length;

  const result = state.data;
  const derivedStats = useMemo(() => (result ? computeStats(result.derived) : null), [result]);

  useControlledPage({
    pageKey: 'derived',
    title: 'Derived',
    fields: [
      tagField({
        tags,
        current: selected,
        set: setSelected,
        multi: true,
        label: `Base ${term.metricIdLabelPlural.toLowerCase()}`,
        description: 'Signals referenced by aliases A, B, C, etc. in the formula.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.string('formula', 'Formula', formula, {
          description: 'Expression over selected signal aliases, e.g. A - B or (A / B) * 100.',
          required: true,
        }),
        apply: (v) => setFormula(coerce.string(v)),
      },
      {
        field: pf.enumOf('transform', 'Transform', transform, [
          { value: 'none', label: 'None' },
          { value: 'roc', label: 'Rate of change' },
          { value: 'rollmean', label: 'Rolling mean' },
        ]),
        apply: (v) => setTransform(coerce.enumValue(v, ['none', 'roc', 'rollmean']) as Transform),
      },
      {
        field: pf.integer('window', 'Window (bins)', window, {
          min: 1,
          max: 500,
          description: 'Rolling-mean window size in bins.',
        }),
        apply: (v) => setWindow(coerce.integer(v, { min: 1, max: 500 })),
      },
      {
        field: pf.string('metricName', 'Saved metric name', metricName, {
          description: 'Optional name used when saving this derived metric.',
        }),
        apply: (v) => setMetricName(coerce.string(v)),
      },
    ],
    canRun: selected.length > 0 && compiled.ok && !state.loading,
    run: compute,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['Timestamp', ...result.names, result.label],
      rows: result.x.map((sec, i) => [
        new Date(sec * 1000).toISOString(),
        ...result.base.map((s) => s.values[i] ?? null),
        result.derived[i] ?? null,
      ]),
    };
  };

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const pair = (arr: (number | null)[]) =>
      result.x.map((sec, i) => [sec * 1000, arr[i]] as [number, number | null]);
    const baseSeries = result.base.map((s, i) => ({
      name: result.names[i],
      type: 'line' as const,
      showSymbol: false,
      lineStyle: { width: 1, color: PALETTE[i % PALETTE.length], opacity: 0.5 },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: pair(s.values),
    }));
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 40, bottom: 56 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      legend: { type: 'scroll', top: 0, data: [...result.names, result.label] },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        ...baseSeries,
        {
          name: result.label,
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 2, color: '#a4262c' },
          itemStyle: { color: '#a4262c' },
          data: pair(result.derived),
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
      <Subtitle1>Derived metrics</Subtitle1>

      <PageIntro
        title="Derived"
        overview={EXPLAINERS.derived.overview}
        interpretation={EXPLAINERS.derived.interpretation}
        technical={EXPLAINERS.derived.technical}
      />

      <div className={styles.controls}>
        <div className={styles.row}>
          <div style={{ minWidth: 320 }}>
            <TagSelect
              label={`Base ${term.metricIdLabelPlural.toLowerCase()}`}
              tags={tags}
              selected={selected}
              onChange={setSelected}
              multiselect
              info={EXPLAINERS.derived.inputs!.baseTags}
            />
          </div>
        </div>

        {aliasMap.length > 0 && (
          <div className={styles.legend}>
            <Caption1>Reference tags in the formula by alias:</Caption1>
            {aliasMap.map((a) => (
              <Caption1 key={a.tagId} className={styles.mono}>
                {`${a.alias} = ${a.name}`}
              </Caption1>
            ))}
          </div>
        )}

        <div className={styles.row}>
          <Field
            label={withInfo('Formula', EXPLAINERS.derived.inputs!.formula)}
            className={styles.formula}
            validationState={compiled.ok ? 'none' : 'error'}
            validationMessage={compiled.ok ? undefined : compiled.error}
          >
            <Input
              className={styles.mono}
              value={formula}
              placeholder="e.g. A - B, (A / B) * 100, abs(A - B)"
              onChange={(_, d) => setFormula(d.value)}
            />
          </Field>
          <Field label={withInfo('Transform', EXPLAINERS.derived.inputs!.transform)}>
            <Select value={transform} onChange={(_, d) => setTransform(d.value as Transform)}>
              <option value="none">None</option>
              <option value="roc">Rate of change</option>
              <option value="rollmean">Rolling mean</option>
            </Select>
          </Field>
          {transform === 'rollmean' && (
            <Field label={withInfo('Window (bins)', EXPLAINERS.derived.inputs!.window)} className={styles.num}>
              <Input
                type="number"
                min={1}
                max={500}
                value={String(window)}
                onChange={(_, d) => {
                  const n = Number(d.value);
                  if (Number.isFinite(n) && n >= 1) setWindow(Math.floor(n));
                }}
              />
            </Field>
          )}
        </div>
        <Caption1>
          Supported: + - * / % ^, parentheses, and abs, sqrt, exp, ln, log10, min, max, pow, floor, ceil,
          round, sign, plus constants pi and e.
        </Caption1>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={selected.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.derived.inputs!.range}
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
        <Button
          appearance="primary"
          disabled={selected.length === 0 || !compiled.ok || state.loading}
          onClick={compute}
        >
          {state.loading ? <Spinner size="tiny" /> : 'Compute'}
        </Button>
      </div>

      <Card className={styles.card}>
        <Subtitle2>Saved metrics</Subtitle2>
        <OutputDescription label="Saved metrics">
          {EXPLAINERS.derived.outputs!.savedMetrics}
        </OutputDescription>
        {!signedIn ? (
          <Caption1>Sign in with Fabric to save and reuse derived metrics.</Caption1>
        ) : !profileId ? (
          <Caption1>Select a connection profile to save and reuse derived metrics.</Caption1>
        ) : (
          <>
            <Caption1>
              {`Saved metrics are specific to the "${activeProfile?.name ?? 'active'}" connection.`}
            </Caption1>
            <div className={styles.saveRow}>
              <Field label={withInfo('Name', EXPLAINERS.derived.inputs!.metricName)} className={styles.saveName}>
                <Input
                  value={metricName}
                  placeholder="e.g. Temp differential (A − B)"
                  onChange={(_, d) => setMetricName(d.value)}
                />
              </Field>
              <Button
                appearance="primary"
                disabled={!compiled.ok || selected.length === 0 || !metricName.trim() || metricsBusy}
                onClick={handleSaveMetric}
              >
                Save
              </Button>
            </div>

            {metricsError && (
              <ErrorMessageBar error={metricsError} />
            )}

            {metricsBusy && savedMetrics.length === 0 ? (
              <Spinner size="tiny" label={'Loading saved metrics\u2026'} />
            ) : savedMetrics.length === 0 ? (
              <Caption1>No saved metrics for this connection yet.</Caption1>
            ) : (
              <div className={styles.savedList}>
                {savedMetrics.map((m) => {
                  const missing = missingTagCount(m);
                  return (
                    <div key={m.id} className={styles.savedItem}>
                      <div className={styles.savedMeta}>
                        <Body1>{m.name}</Body1>
                        <Caption1 className={styles.mono}>
                          {m.definition.transform === 'roc'
                            ? `\u0394(${m.definition.formula})`
                            : m.definition.transform === 'rollmean'
                              ? `mean_${m.definition.window}(${m.definition.formula})`
                              : m.definition.formula}
                          {`  \u00b7  ${m.definition.tagIds.length} tag(s)`}
                          {missing > 0 ? `  \u00b7  ${missing} missing in this connection` : ''}
                        </Caption1>
                      </div>
                      <div className={styles.savedActions}>
                        <Button size="small" onClick={() => handleLoadMetric(m.id)} disabled={metricsBusy}>
                          Load
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          onClick={() => handleDeleteMetric(m.id)}
                          disabled={metricsBusy}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Card>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      <Card className={styles.card}>
        <div className={styles.cardActions}>
          <Subtitle2>{result ? result.label : 'Derived series'}</Subtitle2>
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
            <OutputDescription label="Derived chart">
              {EXPLAINERS.derived.outputs!.chart}
            </OutputDescription>
            <ChartFrame
              option={annotatedOption}
              height={420}
              fileName="derived"
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
            {state.loading
              ? 'Computing\u2026'
              : 'Select base tags, enter a formula, then choose Compute.'}
          </Body1>
        )}
      </Card>

      {result && derivedStats && (
        <Card className={styles.card}>
          <Subtitle2>Derived-series statistics</Subtitle2>
          <OutputDescription label="Derived-series statistics">
            {EXPLAINERS.derived.outputs!.stats}
          </OutputDescription>
          <Table size="small" aria-label="Derived series statistics">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Count</TableHeaderCell>
                <TableHeaderCell>Min</TableHeaderCell>
                <TableHeaderCell>Max</TableHeaderCell>
                <TableHeaderCell>Mean</TableHeaderCell>
                <TableHeaderCell>Median</TableHeaderCell>
                <TableHeaderCell>Std dev</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>{derivedStats.count}</TableCell>
                <TableCell>{fmt(derivedStats.min)}</TableCell>
                <TableCell>{fmt(derivedStats.max)}</TableCell>
                <TableCell>{fmt(derivedStats.mean)}</TableCell>
                <TableCell>{fmt(derivedStats.median)}</TableCell>
                <TableCell>{fmt(derivedStats.stdev)}</TableCell>
              </TableRow>
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
