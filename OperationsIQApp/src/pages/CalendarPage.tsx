import { useMemo, useState, type ReactNode } from 'react';
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
  DATE_ATTRIBUTES,
  buildAttributeHeatmap,
  type AttrHeatmap,
  type DateAttribute,
  type RowAttribute,
} from '../lib/heatmapAttributes';
import { buildBinnedMultiSeriesQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, type ExploreSeries } from '../lib/series';
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
import { EXPLAINERS } from '../lib/explainers';
import { usePageBinning } from '../context/BinningContext';
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { TIME_AXIS_LABEL, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';

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
  smallMultiples: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: tokens.spacingHorizontalL,
    marginTop: tokens.spacingVerticalM,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  panelTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  viewControls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
  },
  horizonControls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
  },
});

/** Blue sequential ramp for the heatmap / horizon bands (light → dark). */
const RAMP = ['#deebf7', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];

interface CalendarData {
  tagId: string;
  /** [dateString 'YYYY-MM-DD', dailyValue] for days that have data. */
  daily: [string, number][];
  /** [unixMs, value] for the adaptive-resolution horizon series. */
  detail: [number, number | null][];
  startStr: string;
  endStr: string;
  min: number;
  max: number;
}

function toDateStr(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().slice(0, 10);
}

/** Build the calendar-heatmap ECharts option for a single tag's data. */
function buildCalOption(
  result: CalendarData,
  decimals: number,
): echarts.EChartsCoreOption {
  const fmtVal = tooltipValueFormatter(decimals);
  return {
    animation: false,
    tooltip: {
      formatter: (p: { value: [string, number] }) => `${p.value[0]}<br/>${fmtVal(p.value[1])}`,
    },
    visualMap: {
      min: result.min,
      max: result.max,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      top: 0,
      inRange: { color: RAMP },
    },
    calendar: {
      top: 70,
      left: 60,
      right: 20,
      cellSize: ['auto', 16],
      range: [result.startStr, result.endStr],
      itemStyle: { borderWidth: 0.5, borderColor: '#fff' },
      splitLine: { lineStyle: { color: tokens.colorNeutralStroke2 } },
      dayLabel: { firstDay: 1 },
      yearLabel: { show: true, margin: 34 },
    },
    series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: result.daily }],
  };
}

/** Build a 1-D / 2-D "by date attribute" heatmap option for one tag. */
function buildAttrOption(
  hm: AttrHeatmap,
  decimals: number,
): echarts.EChartsCoreOption {
  const fmtVal = tooltipValueFormatter(decimals);
  const single = hm.yDef === null;
  return {
    animation: false,
    tooltip: {
      position: 'top',
      formatter: (p: { value: [number, number, number] }) => {
        const [xi, yi, val] = p.value;
        const xLine = `${hm.xDef.label}: ${hm.xDef.categories[xi]}`;
        const yLine = single ? '' : `${hm.yDef!.label}: ${hm.yDef!.categories[yi]}<br/>`;
        return `${yLine}${xLine}<br/>${fmtVal(val)}`;
      },
    },
    visualMap: {
      min: hm.min,
      max: hm.max,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      top: 0,
      inRange: { color: RAMP },
    },
    grid: { left: 8, right: 16, top: 44, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: hm.xDef.categories,
      name: hm.xDef.label,
      nameLocation: 'middle',
      nameGap: 28,
      splitArea: { show: true },
      axisLabel: { interval: 'auto' as const },
    },
    yAxis: {
      type: 'category',
      data: hm.yCategories,
      name: single ? '' : hm.yDef!.label,
      nameLocation: 'middle',
      nameGap: 44,
      splitArea: { show: true },
      axisLabel: { show: !single },
    },
    series: [
      {
        type: 'heatmap',
        data: hm.cells,
        itemStyle: { borderWidth: 0.5, borderColor: '#fff' },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.25)' } },
      },
    ],
  };
}

/**
 * Layout of the stacked horizon chart, in pixels. `bandHeight` is the guaranteed
 * height of each per-signal band and `rowGap` the vertical space between bands;
 * both are user-configurable so the chart can be made denser or more readable.
 */
export interface HorizonLayout {
  bandHeight: number;
  rowGap: number;
  topMargin: number;
  bottomMargin: number;
}

export const HORIZON_LAYOUT_DEFAULTS: HorizonLayout = {
  bandHeight: 60,
  rowGap: 4,
  topMargin: 8,
  bottomMargin: 44,
};

export const HORIZON_BAND_MIN = 32;
export const HORIZON_BAND_MAX = 140;
export const HORIZON_GAP_MIN = 0;
export const HORIZON_GAP_MAX = 24;

const HORIZON_STORAGE_KEY = 'timeiq.horizon.layout';

const clampHorizonBand = (v: number): number =>
  Number.isFinite(v)
    ? Math.min(HORIZON_BAND_MAX, Math.max(HORIZON_BAND_MIN, Math.round(v)))
    : HORIZON_LAYOUT_DEFAULTS.bandHeight;
const clampHorizonGap = (v: number): number =>
  Number.isFinite(v)
    ? Math.min(HORIZON_GAP_MAX, Math.max(HORIZON_GAP_MIN, Math.round(v)))
    : HORIZON_LAYOUT_DEFAULTS.rowGap;

/** Read the persisted band-height / row-gap preference (defaults when absent). */
function readHorizonPrefs(): { bandHeight: number; rowGap: number } {
  try {
    const raw = localStorage.getItem(HORIZON_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { bandHeight?: unknown; rowGap?: unknown };
      return {
        bandHeight: clampHorizonBand(Number(p.bandHeight)),
        rowGap: clampHorizonGap(Number(p.rowGap)),
      };
    }
  } catch {
    /* ignore malformed storage */
  }
  return {
    bandHeight: HORIZON_LAYOUT_DEFAULTS.bandHeight,
    rowGap: HORIZON_LAYOUT_DEFAULTS.rowGap,
  };
}

/** Total pixel height the stacked horizon chart needs for `rows` bands. */
export function horizonChartHeight(rows: number, layout: HorizonLayout): number {
  if (rows <= 0) return layout.topMargin + layout.bottomMargin;
  return (
    layout.topMargin +
    rows * layout.bandHeight +
    (rows - 1) * layout.rowGap +
    layout.bottomMargin
  );
}

/**
 * Build a single compact horizon chart that stacks every selected tag as its own
 * narrow value-banded band (one row per series), sharing the time axis. Bands are
 * laid out in absolute pixels (not percentages) so each signal keeps a guaranteed
 * minimum height and the inter-band spacing stays constant regardless of count.
 */
function buildHorizonMatrixOption(
  results: CalendarData[],
  decimals: number,
  labelFor: (r: CalendarData) => string,
  layout: HorizonLayout,
): echarts.EChartsCoreOption {
  const fmtVal = tooltipValueFormatter(decimals);
  const rows = results.length;
  const { bandHeight, rowGap, topMargin } = layout;
  const rowTop = (i: number) => topMargin + i * (bandHeight + rowGap);

  const grids = results.map((_, i) => ({
    left: 150,
    right: 24,
    top: rowTop(i),
    height: bandHeight,
  }));
  const xAxes = results.map((_, i) => ({
    type: 'time' as const,
    gridIndex: i,
    axisLabel: { ...TIME_AXIS_LABEL, show: i === rows - 1 },
    axisTick: { show: i === rows - 1 },
    axisLine: { show: i === rows - 1 },
  }));
  const yAxes = results.map((_, i) => ({
    type: 'value' as const,
    gridIndex: i,
    scale: true,
    axisLabel: { show: false },
    axisTick: { show: false },
    splitLine: { show: false },
  }));
  const series = results.map((r, i) => ({
    type: 'line' as const,
    name: labelFor(r),
    xAxisIndex: i,
    yAxisIndex: i,
    showSymbol: false,
    areaStyle: {},
    lineStyle: { width: 0.8 },
    data: r.detail,
  }));
  const visualMap = results.map((r, i) => {
    const span = r.max - r.min || 1;
    const pieces = RAMP.map((color, k) => ({
      gte: r.min + (span * k) / RAMP.length,
      lt: r.min + (span * (k + 1)) / RAMP.length,
      color,
    }));
    return {
      type: 'piecewise' as const,
      show: false,
      dimension: 1,
      seriesIndex: i,
      pieces,
      outOfRange: { color: RAMP[RAMP.length - 1] },
    };
  });
  const title = results.map((r, i) => ({
    text: labelFor(r),
    left: 8,
    top: rowTop(i) + bandHeight / 2,
    textVerticalAlign: 'middle' as const,
    textStyle: { fontSize: 11, fontWeight: 400, width: 130, overflow: 'truncate' as const },
  }));

  return {
    animation: false,
    title,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: grids,
    xAxis: xAxes,
    yAxis: yAxes,
    visualMap,
    series,
  };
}

/** Assemble one tag's CalendarData from its (optional) daily + detail series. */
function buildCalendarDatum(
  tagId: string,
  dailySeries: ExploreSeries | undefined,
  detailSeries: ExploreSeries | undefined,
  r: TimeRange,
): CalendarData {
  const daily: [string, number][] = [];
  let min = Infinity;
  let max = -Infinity;
  if (dailySeries) {
    dailySeries.x.forEach((sec, i) => {
      const v = dailySeries.values[i];
      if (v != null && Number.isFinite(v)) {
        daily.push([toDateStr(sec), v]);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
  }
  const detail: [number, number | null][] = detailSeries
    ? detailSeries.x.map((sec, i) => [sec * 1000, detailSeries.values[i]] as [number, number | null])
    : [];
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  return {
    tagId,
    daily,
    detail,
    startStr: r.start.toISOString().slice(0, 10),
    endStr: r.end.toISOString().slice(0, 10),
    min,
    max,
  };
}

/**
 * Load calendar + horizon data for every selected tag using just two queries
 * (one daily-bin, one adaptive detail-bin) that cover all tags via
 * `SignalId in (...)`, instead of two queries per tag. This keeps the concurrent
 * query count constant regardless of how many tags are selected, avoiding
 * concurrent-query throttling on smaller Eventhouses. Results are keyed back to
 * the requested tags in their original order; a tag with no data in the range
 * still yields an (empty) entry so its grid renders.
 */
async function loadCalendarData(
  tagIds: string[],
  r: TimeRange,
  s: BinningSettings,
): Promise<CalendarData[]> {
  const bin = chooseBinFor({ start: r.start, end: r.end }, s);
  const [dailyTable, detailTable] = await Promise.all([
    executeKql(
      buildBinnedMultiSeriesQuery({
        tagIds,
        start: r.start,
        end: r.end,
        binKql: '1d',
        aggregation: s.aggregation,
        fill: false,
      }),
    ),
    executeKql(
      buildBinnedMultiSeriesQuery({
        tagIds,
        start: r.start,
        end: r.end,
        binKql: bin.kql,
        aggregation: s.aggregation,
      }),
    ),
  ]);
  const dailyById = new Map(parseExploreRows(dailyTable).map((row) => [row.tagId, row]));
  const detailById = new Map(parseExploreRows(detailTable).map((row) => [row.tagId, row]));
  return tagIds.map((id) => buildCalendarDatum(id, dailyById.get(id), detailById.get(id), r));
}

export interface CalendarPageProps {
  tags: TagInfo[];
}

/** Heatmaps page: calendar / date-attribute heatmaps plus a combined horizon. */
export function CalendarPage({ tags }: CalendarPageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedTags();
  const [range, setRange] = useSharedRange();
  const [heatmapMode, setHeatmapMode] = useState<'calendar' | 'attribute'>('calendar');
  const [xAttr, setXAttr] = useState<DateAttribute>('hour');
  const [yAttr, setYAttr] = useState<RowAttribute>('dayOfWeek');
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        { title: 'Configuration', fields: binningFields(binning.settings) },
      ],
    };
  }, [tag, nameById, range, binning.settings]);
  useRegisterCaptureContext(captureSummary);
  const tooltipDecimals = useTooltipDecimals();
  const labeler = useTagLabeler();

  const [horizonPrefs, setHorizonPrefs] = useState(readHorizonPrefs);
  const horizonLayout = useMemo<HorizonLayout>(
    () => ({ ...HORIZON_LAYOUT_DEFAULTS, ...horizonPrefs }),
    [horizonPrefs],
  );
  const patchHorizonPrefs = (patch: Partial<{ bandHeight: number; rowGap: number }>) => {
    setHorizonPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(HORIZON_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore storage failures */
      }
      return next;
    });
  };

  const [state, run] = useAsyncAction(
    async (tagIds: string[], r: TimeRange, s: BinningSettings): Promise<CalendarData[]> =>
      loadCalendarData(tagIds, r, s),
  );

  const load = () => {
    if (tag.length === 0) return;
    run(tag, range, binning.settings).catch(() => {});
  };

  const results = state.data ?? [];
  const aggregation = binning.settings.aggregation;
  const attrMode = heatmapMode === 'attribute';
  const withDetail = results.filter((r) => r.detail.length > 0);
  const labelFor = (r: CalendarData) => labeler(r.tagId, nameById.get(r.tagId));

  const heatmapCaption = attrMode
    ? 'Values grouped by date attributes and combined with the selected aggregation (light = low, dark = high).'
    : 'One cell per day, colored by the daily aggregate.';

  useControlledPage({
    pageKey: 'calendar',
    title: 'Heatmaps',
    fields: [
      tagField({ tags, current: tag, set: setTag, multi: true }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf('heatmapMode', 'Heatmap type', heatmapMode, [
          { value: 'calendar', label: 'Calendar (daily)' },
          { value: 'attribute', label: 'By date attribute' },
        ]),
        apply: (v) =>
          setHeatmapMode(coerce.enumValue(v, ['calendar', 'attribute']) as 'calendar' | 'attribute'),
      },
      {
        field: pf.enumOf(
          'xAttr',
          'Columns (X)',
          xAttr,
          DATE_ATTRIBUTES.map((a) => ({ value: a.value, label: a.label })),
        ),
        apply: (v) =>
          setXAttr(
            coerce.enumValue(
              v,
              DATE_ATTRIBUTES.map((a) => a.value),
            ) as DateAttribute,
          ),
      },
      {
        field: pf.enumOf('yAttr', 'Rows (Y)', yAttr, [
          { value: 'none', label: 'None (single strip)' },
          ...DATE_ATTRIBUTES.map((a) => ({ value: a.value, label: a.label })),
        ]),
        apply: (v) =>
          setYAttr(
            coerce.enumValue(v, [
              'none',
              ...DATE_ATTRIBUTES.map((a) => a.value),
            ]) as RowAttribute,
          ),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: load,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: results.length > 0,
  });

  return (
    <div className={styles.root}>
      <Subtitle1>Heatmaps</Subtitle1>

      <PageIntro
        title="Heatmaps"
        overview={EXPLAINERS.calendar.overview}
        interpretation={EXPLAINERS.calendar.interpretation}
        technical={EXPLAINERS.calendar.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect
            tags={tags}
            selected={tag}
            onChange={setTag}
            multiselect
            info={EXPLAINERS.calendar.inputs!.tag}
          />
        </div>

        <div className={styles.viewControls}>
          <Field label="Heatmap type">
            <Select
              value={heatmapMode}
              onChange={(_, d) => setHeatmapMode(d.value as 'calendar' | 'attribute')}
            >
              <option value="calendar">Calendar (daily)</option>
              <option value="attribute">By date attribute</option>
            </Select>
          </Field>

          {attrMode && (
            <>
              <Field label="Columns (X)">
                <Select
                  value={xAttr}
                  onChange={(_, d) => setXAttr(d.value as DateAttribute)}
                >
                  {DATE_ATTRIBUTES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rows (Y)">
                <Select
                  value={yAttr}
                  onChange={(_, d) => setYAttr(d.value as RowAttribute)}
                >
                  <option value="none">None (single strip)</option>
                  {DATE_ATTRIBUTES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={EXPLAINERS.calendar.inputs!.range}
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={load}>
          {state.loading ? <Spinner size="tiny" /> : 'Load'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {results.length === 0 ? (
        <Body1>
          {state.loading
            ? 'Loading\u2026'
            : 'Pick one or more tags and a range, then choose Load.'}
        </Body1>
      ) : (
        <>
          <Card className={styles.card}>
            <div className={styles.cardActions}>
              <Subtitle2>{attrMode ? 'Attribute heatmaps' : 'Calendar heatmaps'}</Subtitle2>
              <div className={styles.spacer} />
            </div>
            <Caption1>{heatmapCaption}</Caption1>
            <div className={styles.smallMultiples}>
              {results.map((result) => (
                <HeatmapPanel
                  key={result.tagId}
                  className={styles.panel}
                  titleClassName={styles.panelTitle}
                  title={labelFor(result)}
                  result={result}
                  attrMode={attrMode}
                  xAttr={xAttr}
                  yAttr={yAttr}
                  aggregation={aggregation}
                  decimals={tooltipDecimals}
                />
              ))}
            </div>
          </Card>

          {withDetail.length > 0 && (
            <Card className={styles.card}>
              <div className={styles.cardActions}>
                <Subtitle2>Horizon</Subtitle2>
                <div className={styles.spacer} />
                <div className={styles.horizonControls}>
                  <Field label={`Band height: ${horizonLayout.bandHeight}px`}>
                    <Slider
                      min={HORIZON_BAND_MIN}
                      max={HORIZON_BAND_MAX}
                      step={4}
                      value={horizonLayout.bandHeight}
                      onChange={(_, d) => patchHorizonPrefs({ bandHeight: d.value })}
                      style={{ minWidth: 140 }}
                    />
                  </Field>
                  <Field label={`Row spacing: ${horizonLayout.rowGap}px`}>
                    <Slider
                      min={HORIZON_GAP_MIN}
                      max={HORIZON_GAP_MAX}
                      step={1}
                      value={horizonLayout.rowGap}
                      onChange={(_, d) => patchHorizonPrefs({ rowGap: d.value })}
                      style={{ minWidth: 120 }}
                    />
                  </Field>
                </div>
              </div>
              <Caption1>
                One narrow band per signal, area filled with value bands (light = low, dark =
                high). Bands share the time axis; color scales are per signal. Use the sliders to
                adjust band height and spacing.
              </Caption1>
              <ChartFrame
                option={buildHorizonMatrixOption(
                  withDetail,
                  tooltipDecimals,
                  labelFor,
                  horizonLayout,
                )}
                height={horizonChartHeight(withDetail.length, horizonLayout)}
                fileName="horizon_bands"
                allowScaleToggle={false}
                data={(): ChartData => {
                  const cols = ['Timestamp', ...withDetail.map((r) => labelFor(r))];
                  const len = Math.max(...withDetail.map((r) => r.detail.length));
                  const base = withDetail.reduce((a, b) =>
                    b.detail.length > a.detail.length ? b : a,
                  );
                  const rows = Array.from({ length: len }, (_, i) => {
                    const ts = base.detail[i]?.[0];
                    const cell: (string | number | null)[] = [
                      ts != null ? new Date(ts).toISOString() : '',
                    ];
                    for (const r of withDetail) cell.push(r.detail[i]?.[1] ?? null);
                    return cell;
                  });
                  return { columns: cols, rows };
                }}
              />
            </Card>
          )}
        </>
      )}

      {results.length > 0 && (
        <OutputDescription label="Heatmaps & horizon">
          {attrMode
            ? EXPLAINERS.calendar.outputs!.attributeHeatmap
            : EXPLAINERS.calendar.outputs!.calendarHeatmap}{' '}
          {EXPLAINERS.calendar.outputs!.horizonGraph}
        </OutputDescription>
      )}
    </div>
  );
}

interface HeatmapPanelProps {
  className: string;
  titleClassName: string;
  title: string;
  result: CalendarData;
  attrMode: boolean;
  xAttr: DateAttribute;
  yAttr: RowAttribute;
  aggregation: BinningSettings['aggregation'];
  decimals: number;
}

/** One small-multiple cell rendering either a calendar or an attribute heatmap. */
function HeatmapPanel({
  className,
  titleClassName,
  title,
  result,
  attrMode,
  xAttr,
  yAttr,
  aggregation,
  decimals,
}: HeatmapPanelProps) {
  const hm = useMemo<AttrHeatmap | null>(
    () => (attrMode ? buildAttributeHeatmap(result.detail, xAttr, yAttr, aggregation) : null),
    [attrMode, result.detail, xAttr, yAttr, aggregation],
  );

  let body: ReactNode;
  if (attrMode) {
    if (!hm || hm.cells.length === 0) {
      body = <Body1>No data in this range.</Body1>;
    } else {
      const attrData = (): ChartData => {
        const single = hm.yDef === null;
        const columns = single
          ? [hm.xDef.label, 'Value']
          : [hm.xDef.label, hm.yDef!.label, 'Value'];
        const rows = hm.cells.map(([xi, yi, value]) =>
          single
            ? [hm.xDef.categories[xi], value]
            : [hm.xDef.categories[xi], hm.yDef!.categories[yi], value],
        );
        return { columns, rows };
      };
      body = (
        <ChartFrame
          option={buildAttrOption(hm, decimals)}
          height={hm.yDef === null ? 170 : 280}
          fileName={`heatmap_${result.tagId}`}
          allowScaleToggle={false}
          data={attrData}
        />
      );
    }
  } else if (result.daily.length > 0) {
    const calData = (): ChartData => ({
      columns: ['Date', 'Value'],
      rows: result.daily.map(([date, value]) => [date, value]),
    });
    body = (
      <ChartFrame
        option={buildCalOption(result, decimals)}
        height={200}
        fileName={`calendar_${result.tagId}`}
        allowScaleToggle={false}
        data={calData}
      />
    );
  } else {
    body = <Body1>No daily data in this range.</Body1>;
  }

  return (
    <div className={className}>
      <div className={titleClassName}>
        <Subtitle2>{title}</Subtitle2>
      </div>
      {body}
    </div>
  );
}
