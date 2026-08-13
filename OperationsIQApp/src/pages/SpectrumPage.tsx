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
  Dropdown,
  Label,
  Option,
  Spinner,
  Subtitle1,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { buildSpectrumQuery, buildSpectrogramQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import {
  parseSpectrum,
  parseSpectrogram,
  chooseSpectrogramWindow,
  hopFromOverlap,
  largestPow2AtMost,
  type Spectrum,
  type Spectrogram,
} from '../lib/spectrum';
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
  tableWrap: { marginTop: tokens.spacingVerticalM },
  control: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '160px' },
  subSection: { marginTop: tokens.spacingVerticalXL },
});

const MODEL_NAME = 'series_fft';
const MODEL_VERSION = '1';

/** Spectrogram window-length choices (samples per STFT frame). */
type WindowChoice = 'auto' | '32' | '64' | '128' | '256';
const WINDOW_OPTIONS: { value: WindowChoice; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '32', label: '32 samples' },
  { value: '64', label: '64 samples' },
  { value: '128', label: '128 samples' },
  { value: '256', label: '256 samples' },
];

/** Spectrogram frame-overlap choices (percent). */
type OverlapChoice = '0' | '25' | '50' | '75';
const OVERLAP_OPTIONS: { value: OverlapChoice; label: string }[] = [
  { value: '0', label: '0%' },
  { value: '25', label: '25%' },
  { value: '50', label: '50%' },
  { value: '75', label: '75%' },
];

const windowLabel = (v: WindowChoice) => WINDOW_OPTIONS.find((o) => o.value === v)!.label;

/**
 * Resolve the concrete STFT window length (in samples) for a series of `n`
 * samples given the user's choice. Falls back to the auto size when an explicit
 * window is larger than the series can support; returns 0 when the series is too
 * short for any spectrogram.
 */
function resolveWindowBins(choice: WindowChoice, n: number): number {
  if (choice === 'auto') return chooseSpectrogramWindow(n);
  const sel = Number(choice);
  if (!Number.isFinite(sel) || sel < 32 || n < sel) return chooseSpectrogramWindow(n);
  return Math.min(sel, largestPow2AtMost(n));
}

interface SpectrumResult {
  spectrum: Spectrum;
  spectrogram: Spectrogram | null;
  binSeconds: number;
}

/**
 * Spectrum workspace. Runs `series_fft` on one signal and plots the frequency
 * spectrum (magnitude vs frequency) plus a table of the dominant peaks with
 * their equivalent period — useful for identifying the rotating / vibration
 * frequency of equipment. Below the spectrum it also renders a spectrogram
 * (Short-Time Fourier Transform) heatmap showing how that frequency
 * distribution evolves over time, which a single whole-window spectrum cannot.
 */
export function SpectrumPage({ tags }: { tags: TagInfo[] }) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [windowChoice, setWindowChoice] = useState<WindowChoice>('auto');
  const [overlapPct, setOverlapPct] = useState<OverlapChoice>('50');
  const [logFreq, setLogFreq] = useState(false);
  const [logMag, setLogMag] = useState(false);
  const binning = usePageBinning();
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Signal', value: tagNames(tag, nameById) }] },
        { title: 'Time range', fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }] },
        {
          title: 'Configuration',
          fields: [
            ...binningFields(binning.settings),
            { label: 'Spectrogram window', value: windowLabel(windowChoice) },
            { label: 'Spectrogram overlap', value: `${overlapPct}%` },
          ],
        },
      ],
    };
  }, [tag, nameById, range, binning.settings, windowChoice, overlapPct]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      s: BinningSettings,
      win: WindowChoice,
      overlap: OverlapChoice,
    ): Promise<SpectrumResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const table = await executeKql(
        buildSpectrumQuery({
          tagId,
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );
      const spectrum = parseSpectrum(table, (bin.millis / 1000));
      if (!spectrum) return null;

      // Spectrogram (STFT): frame the same series and FFT each frame. The window
      // length is decided client-side (an FFT-frame constant), sized from the
      // expected number of make-series samples across the range.
      const durationSec = (r.end.getTime() - r.start.getTime()) / 1000;
      const expectedN = (bin.millis / 1000) > 0 ? Math.floor(durationSec / (bin.millis / 1000)) + 1 : 0;
      const windowBins = resolveWindowBins(win, expectedN);
      let spectrogram: Spectrogram | null = null;
      if (windowBins >= 32) {
        const hopBins = hopFromOverlap(windowBins, Number(overlap));
        const sgTable = await executeKql(
          buildSpectrogramQuery({
            tagId,
            start: r.start,
            end: r.end,
            binKql: bin.kql,
            windowBins,
            hopBins,
            aggregation: s.aggregation,
          }),
        );
        spectrogram = parseSpectrogram(sgTable, (bin.millis / 1000), r.start);
      }

      return { spectrum, spectrogram, binSeconds: (bin.millis / 1000) };
    },
  );

  const analyze = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings, windowChoice, overlapPct).catch(() => {});
  };

  const result = state.data;

  useControlledPage({
    pageKey: 'spectrum',
    title: 'Spectrum',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf(
          'windowLength',
          'Spectrogram window',
          windowChoice,
          WINDOW_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: EXPLAINERS.spectrum.inputs!.windowLength },
        ),
        apply: (value) =>
          setWindowChoice(
            coerce.enumValue(
              value,
              WINDOW_OPTIONS.map((o) => o.value),
            ) as WindowChoice,
          ),
      },
      {
        field: pf.enumOf(
          'overlap',
          'Spectrogram overlap (%)',
          overlapPct,
          OVERLAP_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          { description: EXPLAINERS.spectrum.inputs!.overlap },
        ),
        apply: (value) =>
          setOverlapPct(
            coerce.enumValue(
              value,
              OVERLAP_OPTIONS.map((o) => o.value),
            ) as OverlapChoice,
          ),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: analyze,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  useEffect(() => {
    if (!result) return;
    const sp = result.spectrum;
    const top = sp.peaks[0];
    const p = buildProvenance({
      outputType: 'signal_validation',
      tagId: sp.tagId,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      featureVersion: FEATURE_VERSION,
      sourceWindowStart: range.start,
      sourceWindowEnd: range.end,
      eventTime: range.end,
      summary: {
        samples: sp.n,
        binSeconds: sp.binSeconds,
        dominantPeriodSeconds: top ? top.periodSeconds : null,
        peakCount: sp.peaks.length,
      },
    });
    setProvenance(p);
    void writeModelOutput(p).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const sp = result.spectrum;
    const points = sp.bins.map((b) => [b.freqHz, b.magnitude]);
    const peakPoints = sp.peaks.map((b) => [b.freqHz, b.magnitude]);
    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: unknown) => {
          const arr = params as { data: [number, number] }[];
          const d = arr[0]?.data;
          if (!d) return '';
          const period = d[0] > 0 ? formatDuration(1 / d[0]) : '∞';
          return `Frequency ${d[0].toExponential(3)} Hz<br/>Period ${period}<br/>Magnitude ${d[1].toFixed(2)}`;
        },
      },
      grid: { left: 64, right: 24, top: 24, bottom: 56 },
      xAxis: { type: 'value', name: 'Frequency (Hz)', nameLocation: 'middle', nameGap: 32, scale: true },
      yAxis: { type: 'value', name: 'Magnitude', scale: true },
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', bottom: 8, height: 18 },
      ],
      series: [
        {
          name: 'Magnitude',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 1.4, color: '#0f6cbd' },
          itemStyle: { color: '#0f6cbd' },
          areaStyle: { color: 'rgba(15,108,189,0.12)' },
          data: points,
        },
        {
          name: 'Peaks',
          type: 'scatter',
          symbolSize: 9,
          itemStyle: { color: '#a4262c' },
          data: peakPoints,
        },
      ],
    };
  }, [result]);

  const chartData = (): ChartData => {
    if (!result) return { columns: [], rows: [] };
    return {
      columns: ['FrequencyHz', 'Magnitude', 'PeriodSeconds'],
      rows: result.spectrum.bins.map((b) => [b.freqHz, b.magnitude, b.periodSeconds]),
    };
  };

  const spectrogramOption = useMemo<echarts.EChartsCoreOption>(() => {
    const sg = result?.spectrogram;
    if (!sg || sg.frames.length === 0) return {};
    const spanMs =
      sg.frames.length > 1 ? sg.frames[sg.frames.length - 1].centerMs - sg.frames[0].centerMs : 0;
    const withDate = spanMs >= 86_400_000; // include date when the range spans > 1 day
    const timeLabels = sg.frames.map((f) =>
      formatQueryInstant(f.centerMs, {
        ...(withDate ? { month: 'short', day: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    // Per-bin frequency band edges (midpoints between neighbouring bins). Every
    // edge stays strictly positive so the Y axis can also render on a log scale.
    const nf = sg.freqHz.length;
    const loEdge: number[] = [];
    const hiEdge: number[] = [];
    for (let y = 0; y < nf; y++) {
      const f = sg.freqHz[y];
      const step = nf > 1 ? sg.freqHz[1] - sg.freqHz[0] : f;
      const prev = y > 0 ? sg.freqHz[y - 1] : f - step;
      const next = y < nf - 1 ? sg.freqHz[y + 1] : f + step;
      const lo = (prev + f) / 2;
      loEdge.push(lo > 0 ? lo : f / 2);
      hiEdge.push((f + next) / 2);
    }

    // Colour scale: linear on magnitude, or log10(magnitude) when the magnitude
    // toggle is on. Non-positive magnitudes floor to the smallest positive one.
    let maxMag = 0;
    let minPos = Infinity;
    sg.frames.forEach((f) =>
      f.magnitudes.forEach((m) => {
        if (m > maxMag) maxMag = m;
        if (m > 0 && m < minPos) minPos = m;
      }),
    );
    if (!Number.isFinite(minPos)) minPos = 1e-9;
    const magFloor = Math.log10(minPos);
    const colorOf = (m: number) => (logMag ? (m > 0 ? Math.log10(m) : magFloor) : m);

    // data item: [xIndex, freqCenter, colorValue, freqLow, freqHigh, magnitude]
    const data: [number, number, number, number, number, number][] = [];
    sg.frames.forEach((f, x) => {
      f.magnitudes.forEach((m, y) => {
        data.push([x, sg.freqHz[y], colorOf(m), loEdge[y], hiEdge[y], m]);
      });
    });

    const xEvery = Math.max(0, Math.ceil(timeLabels.length / 12) - 1);
    const vmMin = logMag ? magFloor : 0;
    const vmMax = logMag ? Math.log10(Math.max(minPos, maxMag)) : Math.max(1e-9, maxMag);
    return {
      animation: false,
      grid: { left: 88, right: 24, top: 24, bottom: 92 },
      tooltip: {
        position: 'top',
        formatter: (params: unknown) => {
          const d = (params as { value: [number, number, number, number, number, number] }).value;
          if (!d) return '';
          const hz = d[1];
          const period = hz > 0 ? formatDuration(1 / hz) : '∞';
          return `${timeLabels[d[0]]}<br/>Frequency ${hz.toExponential(3)} Hz<br/>Period ${period}<br/>Magnitude ${Number(d[5]).toFixed(2)}`;
        },
      },
      xAxis: {
        type: 'category',
        data: timeLabels,
        name: 'Time',
        nameLocation: 'middle',
        nameGap: 64,
        axisLabel: { rotate: 45, interval: xEvery, hideOverlap: true },
      },
      yAxis: {
        type: logFreq ? 'log' : 'value',
        name: 'Frequency (Hz)',
        min: loEdge[0],
        max: hiEdge[nf - 1],
        axisLabel: { formatter: (v: number) => v.toExponential(1) },
      },
      visualMap: {
        min: vmMin,
        max: vmMax,
        dimension: 2,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        inRange: { color: ['#f3f2f1', '#5b9bd5', '#a4262c'] },
        ...(logMag ? { formatter: (v: number) => Math.pow(10, Number(v)).toExponential(1) } : {}),
      },
      series: [
        {
          name: 'Magnitude',
          type: 'custom',
          progressive: 4000,
          renderItem: (
            _params: unknown,
            api: {
              value: (i: number) => number;
              coord: (p: [number, number]) => [number, number];
              size: (p: [number, number]) => [number, number];
              visual: (k: string) => string;
            },
          ) => {
            const xIdx = api.value(0);
            const lo = api.coord([xIdx, api.value(3)]);
            const hi = api.coord([xIdx, api.value(4)]);
            const bandW = api.size([1, 0])[0];
            return {
              type: 'rect',
              shape: {
                x: hi[0] - bandW / 2,
                y: hi[1],
                width: bandW,
                height: Math.max(1, lo[1] - hi[1]),
              },
              style: { fill: api.visual('color') },
            };
          },
          data,
        },
      ],
    };
  }, [result, logFreq, logMag]);

  const spectrogramChartData = (): ChartData => {
    const sg = result?.spectrogram;
    if (!sg) return { columns: [], rows: [] };
    const rows: (string | number)[][] = [];
    for (const f of sg.frames) {
      const iso = new Date(f.centerMs).toISOString();
      f.magnitudes.forEach((m, y) => rows.push([iso, sg.freqHz[y], m]));
    }
    return { columns: ['FrameTime', 'FrequencyHz', 'Magnitude'], rows };
  };

  const sp = result?.spectrum ?? null;
  const spectrogram = result?.spectrogram ?? null;

  return (
    <div className={styles.root}>
      <Subtitle1>Spectrum</Subtitle1>

      <PageIntro
        title="Spectrum"
        overview={EXPLAINERS.spectrum.overview}
        interpretation={EXPLAINERS.spectrum.interpretation}
        technical={EXPLAINERS.spectrum.technical}
      />

      <div className={styles.controls}>
        <div style={{ minWidth: 260 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={EXPLAINERS.spectrum.inputs!.tag} />
        </div>
        <div className={styles.control}>
          <Label size="small">Spectrogram window</Label>
          <Dropdown
            size="small"
            value={windowLabel(windowChoice)}
            selectedOptions={[windowChoice]}
            disabled={state.loading}
            onOptionSelect={(_, d) => setWindowChoice((d.optionValue as WindowChoice) ?? 'auto')}
          >
            {WINDOW_OPTIONS.map((o) => (
              <Option key={o.value} value={o.value}>
                {o.label}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.control}>
          <Label size="small">Spectrogram overlap</Label>
          <Dropdown
            size="small"
            value={`${overlapPct}%`}
            selectedOptions={[overlapPct]}
            disabled={state.loading}
            onOptionSelect={(_, d) => setOverlapPct((d.optionValue as OverlapChoice) ?? '50')}
          >
            {OVERLAP_OPTIONS.map((o) => (
              <Option key={o.value} value={o.value}>
                {o.label}
              </Option>
            ))}
          </Dropdown>
        </div>
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
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={analyze}>
          {state.loading ? <Spinner size="tiny" /> : 'Compute spectrum'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && sp && (
        <Card className={styles.card}>
          <div className={styles.cardHead}>
            <Body1>{labeler(sp.tagId, nameById.get(sp.tagId))}</Body1>
            <div className={styles.spacer} />
            {provenance && <ProvenanceChip provenance={provenance} />}
          </div>
          <OutputDescription label="Magnitude spectrum">
            {EXPLAINERS.spectrum.outputs!.chart}
          </OutputDescription>
          <ChartFrame option={option} height={400} fileName="spectrum" data={chartData} />
          <Caption1>
            {sp.n} samples ·{' '}
            {sp.binSeconds >= 3600
              ? `${(sp.binSeconds / 3600).toFixed(1)}h`
              : sp.binSeconds >= 60
                ? `${(sp.binSeconds / 60).toFixed(1)}m`
                : `${sp.binSeconds}s`}{' '}
            sample interval
          </Caption1>

          <div className={styles.tableWrap}>
            <OutputDescription label="Dominant peaks">
              {EXPLAINERS.spectrum.outputs!.peaks}
            </OutputDescription>
            {sp.peaks.length === 0 ? (
              <Caption1>No dominant peaks found in the spectrum.</Caption1>
            ) : (
              <Table size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>#</TableHeaderCell>
                    <TableHeaderCell>Frequency (Hz)</TableHeaderCell>
                    <TableHeaderCell>Equivalent period</TableHeaderCell>
                    <TableHeaderCell>Magnitude</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sp.peaks.map((b, i) => (
                    <TableRow key={b.index}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell>{b.freqHz.toExponential(3)}</TableCell>
                      <TableCell>{formatDuration(b.periodSeconds)}</TableCell>
                      <TableCell>{b.magnitude.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <div className={styles.subSection}>
            <OutputDescription label="Spectrogram (frequency over time)">
              {EXPLAINERS.spectrum.outputs!.spectrogram}
            </OutputDescription>
            {spectrogram && spectrogram.frames.length > 0 ? (
              <>
                <ChartFrame
                  option={spectrogramOption}
                  height={420}
                  fileName="spectrogram"
                  data={spectrogramChartData}
                  allowScaleToggle={false}
                  actions={
                    <>
                      <Tooltip content="Toggle logarithmic frequency (Y) axis" relationship="label">
                        <ToggleButton
                          appearance="subtle"
                          size="small"
                          checked={logFreq}
                          onClick={() => setLogFreq((v) => !v)}
                        >
                          {logFreq ? 'Freq: Log' : 'Freq: Linear'}
                        </ToggleButton>
                      </Tooltip>
                      <Tooltip
                        content="Toggle logarithmic magnitude (colour) scale"
                        relationship="label"
                      >
                        <ToggleButton
                          appearance="subtle"
                          size="small"
                          checked={logMag}
                          onClick={() => setLogMag((v) => !v)}
                        >
                          {logMag ? 'Mag: Log' : 'Mag: Linear'}
                        </ToggleButton>
                      </Tooltip>
                    </>
                  }
                />
                <Caption1>
                  {spectrogram.frames.length} frames · {spectrogram.windowBins}-sample window ·{' '}
                  {Math.round((1 - spectrogram.hopBins / spectrogram.windowBins) * 100)}% overlap
                </Caption1>
              </>
            ) : (
              <Caption1>
                Not enough samples in this window for a spectrogram — widen the time range or
                choose a finer resolution (a shorter bin width) so at least ~32 samples are
                available.
              </Caption1>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
