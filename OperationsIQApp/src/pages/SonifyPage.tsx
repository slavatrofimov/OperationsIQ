import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Slider,
  SpinButton,
  Subtitle1,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Pause24Regular,
  Play24Regular,
  Stop24Regular,
} from '@fluentui/react-icons';
import * as echarts from 'echarts';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import type { TagInfo } from '../lib/tags';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { buildExploreQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, type ExploreSeries } from '../lib/series';
import { useAsyncAction } from '../hooks/useAsync';
import { withInfo } from '../components/fieldInfo';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { EChart } from '../components/EChart';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { usePageBinning } from '../context/BinningContext';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import {
  DEFAULT_SONIFY_PARAMS,
  LOUDNESS_LABELS,
  SCALE_LABELS,
  midiToNoteName,
  sonify,
  type LoudnessSource,
  type SonifyParams,
  type SonifyResult,
  type SonifyScale,
  type Waveform,
} from '../lib/sonify';
import { WebAudioPlayer, isAudioSupported } from '../lib/audio/WebAudioPlayer';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  controls: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    alignItems: 'flex-end',
    columnGap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  control: { minWidth: 0 },
  fullWidth: { width: '100%' },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  card: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  transport: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  transportSpacer: { flex: 1 },
});

const SCALE_OPTIONS: SonifyScale[] = ['pentatonic', 'major', 'chromatic', 'none'];
const LOUDNESS_OPTIONS: LoudnessSource[] = ['deviation', 'change', 'magnitude', 'fixed'];
const WAVEFORM_OPTIONS: { value: Waveform; label: string }[] = [
  { value: 'sine', label: 'Sine (smooth)' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Sawtooth (bright)' },
];

interface SeriesResult {
  tagId: string;
  series: ExploreSeries | null;
}

/** Fetch one tag's binned series over the window at the chosen resolution. */
async function loadSeries(
  tagId: string,
  r: TimeRange,
  s: BinningSettings,
): Promise<SeriesResult> {
  const bin = chooseBinFor({ start: r.start, end: r.end }, s);
  const table = await executeKql(
    buildExploreQuery({
      tagIds: [tagId],
      start: r.start,
      end: r.end,
      binKql: bin.kql,
      aggregation: s.aggregation,
    }),
  );
  const parsed = parseExploreRows(table);
  return { tagId, series: parsed[0] ?? null };
}

export interface SonifyPageProps {
  tags: TagInfo[];
}

/**
 * Sonify page: turn a single signal into an audible melody. The pure transform
 * (`sonify`) maps value -> pitch, a feature -> loudness, and time -> onset; the
 * {@link WebAudioPlayer} schedules the resulting notes with a synced playhead.
 */
export function SonifyPage({ tags }: SonifyPageProps) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const binning = usePageBinning();
  const labeler = useTagLabeler();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);

  const [params, setParams] = useState<SonifyParams>(DEFAULT_SONIFY_PARAMS);
  const patchParams = (p: Partial<SonifyParams>) => setParams((prev) => ({ ...prev, ...p }));
  const [waveform, setWaveform] = useState<Waveform>('sine');

  const audioSupported = useMemo(() => isAudioSupported(), []);

  const [state, run] = useAsyncAction(
    async (tagId: string, r: TimeRange, s: BinningSettings): Promise<SeriesResult> =>
      loadSeries(tagId, r, s),
  );

  const load = () => {
    if (tag.length === 0) return;
    run(tag[0], range, binning.settings).catch(() => {});
  };

  const series = state.data?.series ?? null;
  const resultTag = state.data?.tagId ?? null;

  const sonifyResult = useMemo<SonifyResult | null>(() => {
    if (!series || series.x.length === 0) return null;
    return sonify(
      { x: series.x, values: series.values, baseline: series.baseline },
      params,
    );
  }, [series, params]);

  // Web Audio player + transport state.
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const playerRef = useRef<WebAudioPlayer | null>(null);

  if (playerRef.current === null && audioSupported) {
    playerRef.current = new WebAudioPlayer({
      onTick: (sec) => setCurrentSec(sec),
      onStateChange: (p) => setPlaying(p),
      onEnded: () => setCurrentSec(0),
    });
  }

  // Reload the score whenever the notes change; this stops any current playback.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (sonifyResult) {
      player.load(sonifyResult.notes, sonifyResult.totalDurationSec, waveform);
    } else {
      player.stop();
    }
    setCurrentSec(0);
    // waveform is applied via load; other param changes recompute sonifyResult.
  }, [sonifyResult, waveform]);

  // Dispose the AudioContext on unmount.
  useEffect(() => {
    return () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    };
  }, []);

  const handlePlay = () => {
    void playerRef.current?.play();
  };
  const handlePause = () => playerRef.current?.pause();
  const handleStop = () => {
    playerRef.current?.stop();
    setCurrentSec(0);
  };

  // Find the note currently sounding (its onset..end brackets currentSec) so we
  // can mark it on the curve and show its pitch. Falls back to the nearest grid
  // sample by time when between notes.
  const currentNote = useMemo(() => {
    if (!sonifyResult || sonifyResult.gridX.length === 0) return null;
    const { notes, gridX, gridValues, totalDurationSec } = sonifyResult;
    const n = gridX.length;
    const interval = totalDurationSec / n;
    const idx = interval > 0 ? Math.min(n - 1, Math.max(0, Math.floor(currentSec / interval))) : 0;
    const active = notes.find(
      (note) => currentSec >= note.startSec && currentSec < note.startSec + note.durSec,
    );
    const midi = active ? active.midi : null;
    const value = gridValues[idx];
    return {
      xMs: gridX[idx] * 1000,
      value: value == null ? null : value,
      midi,
    };
  }, [sonifyResult, currentSec]);

  // Static line data — depends only on the loaded score, so it isn't rebuilt on
  // every playback tick (only the playhead/marker below move each frame).
  const chartData = useMemo(() => {
    if (!sonifyResult) return null;
    return sonifyResult.gridX.map((x, i) => {
      const v = sonifyResult.gridValues[i];
      return [x * 1000, v == null ? null : v] as [number, number | null];
    });
  }, [sonifyResult]);

  const chartOption = useMemo<echarts.EChartsCoreOption | null>(() => {
    if (!sonifyResult || !chartData) return null;
    const playheadMs = currentNote?.xMs ?? null;
    const markLine =
      playheadMs == null
        ? undefined
        : {
            silent: true,
            symbol: 'none' as const,
            animation: false,
            lineStyle: { color: tokens.colorPaletteRedForeground1, width: 2.5, type: 'solid' as const },
            label: {
              show: currentNote?.midi != null,
              formatter: currentNote?.midi != null ? midiToNoteName(currentNote.midi) : '',
              position: 'start' as const,
              color: tokens.colorNeutralForegroundOnBrand,
              backgroundColor: tokens.colorPaletteRedForeground1,
              padding: [2, 4, 2, 4],
              borderRadius: 3,
              fontWeight: 'bold' as const,
            },
            data: [{ xAxis: playheadMs }],
          };
    // A single dot that rides along the curve at the current note. A contrasting
    // perimeter keeps it visible against both the line and the page background.
    const marker =
      playheadMs == null || currentNote?.value == null ? [] : [[playheadMs, currentNote.value]];
    return {
      // Disable animation: with per-frame option updates during playback, the
      // default transition never settles, so the playhead only appeared once
      // ticks stopped. Snapping each frame keeps it continuously visible.
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 56 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'time' },
      yAxis: { type: 'value', scale: true },
      dataZoom: [
        { type: 'slider', height: 18, bottom: 12 },
        { type: 'inside' },
      ],
      series: [
        {
          type: 'line',
          name: resultTag ? labeler(resultTag, nameById.get(resultTag)) : 'Signal',
          showSymbol: false,
          connectNulls: false,
          lineStyle: { width: 1.5 },
          areaStyle: { opacity: 0.06 },
          data: chartData,
          markLine,
        },
        {
          type: 'scatter',
          name: 'Now playing',
          symbolSize: 14,
          itemStyle: {
            color: tokens.colorPaletteRedForeground1,
            borderColor: tokens.colorNeutralBackground1,
            borderWidth: 2.5,
            shadowBlur: 6,
            shadowColor: tokens.colorPaletteRedBorderActive,
          },
          z: 10,
          silent: true,
          data: marker,
        },
      ],
    };
  }, [sonifyResult, chartData, currentNote, resultTag, labeler, nameById]);

  const inputs = EXPLAINERS.sonify.inputs;

  return (
    <div className={styles.root}>
      <Subtitle1>Sonify</Subtitle1>

      <PageIntro
        title="Sonify"
        overview={EXPLAINERS.sonify.overview}
        interpretation={EXPLAINERS.sonify.interpretation}
        technical={EXPLAINERS.sonify.technical}
      />

      {!audioSupported && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Your browser does not expose the Web Audio API, so playback is unavailable. The chart and
            note preview still work.
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.controls}>
        <div className={styles.control} style={{ minWidth: 240 }}>
          <TagSelect tags={tags} selected={tag} onChange={setTag} info={inputs?.tag} />
        </div>

        <Field label={withInfo('Scale', inputs?.scale ?? '')} className={styles.control}>
          <Select
            value={params.scale}
            onChange={(_, d) => patchParams({ scale: d.value as SonifyScale })}
          >
            {SCALE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {SCALE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={withInfo('Octave span', inputs?.octaves ?? '')} className={styles.control}>
          <SpinButton
            value={params.octaves}
            min={1}
            max={5}
            step={1}
            onChange={(_, d) =>
              patchParams({ octaves: Math.round(Number(d.value ?? d.displayValue ?? 2)) || 2 })
            }
          />
        </Field>

        <Field
          label={withInfo(`Tempo — ${params.notesPerSecond} notes/sec`, inputs?.tempo ?? '')}
          className={styles.control}
        >
          <Slider
            min={1}
            max={20}
            step={1}
            value={params.notesPerSecond}
            onChange={(_, d) => patchParams({ notesPerSecond: d.value })}
          />
        </Field>

        <Field label={withInfo('Timbre', inputs?.waveform ?? '')} className={styles.control}>
          <Select
            value={waveform}
            onChange={(_, d) => setWaveform(d.value as Waveform)}
          >
            {WAVEFORM_OPTIONS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={withInfo('Loudness', inputs?.loudness ?? '')} className={styles.control}>
          <Select
            value={params.loudnessSource}
            onChange={(_, d) => patchParams({ loudnessSource: d.value as LoudnessSource })}
          >
            {LOUDNESS_OPTIONS.map((l) => (
              <option key={l} value={l}>
                {LOUDNESS_LABELS[l]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={withInfo('Max notes', inputs?.maxNotes ?? '')} className={styles.control}>
          <SpinButton
            value={params.maxNotes}
            min={20}
            max={2000}
            step={20}
            onChange={(_, d) =>
              patchParams({ maxNotes: Math.round(Number(d.value ?? d.displayValue ?? 400)) || 400 })
            }
          />
        </Field>
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
        rangeInfo={inputs?.range}
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
        <Button
          appearance="primary"
          disabled={tag.length === 0 || state.loading}
          onClick={load}
        >
          {state.loading ? 'Loading\u2026' : 'Load'}
        </Button>
      </div>

      {state.error && <ErrorMessageBar error={state.error} />}

      {!resultTag ? (
        <Body1>
          {state.loading ? 'Loading\u2026' : 'Pick a signal and a range, then choose Load to hear it.'}
        </Body1>
      ) : !sonifyResult ? (
        <MessageBar intent="info">
          <MessageBarBody>
            No data was returned for this signal and window. Try a wider range or a different signal.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Card className={styles.card}>
          <Subtitle2>{labeler(resultTag, nameById.get(resultTag))}</Subtitle2>

          <OutputDescription label="Player">{EXPLAINERS.sonify.outputs!.player}</OutputDescription>

          <div className={styles.transport}>
            {playing ? (
              <Button
                appearance="primary"
                icon={<Pause24Regular />}
                onClick={handlePause}
                disabled={!audioSupported}
              >
                Pause
              </Button>
            ) : (
              <Button
                appearance="primary"
                icon={<Play24Regular />}
                onClick={handlePlay}
                disabled={!audioSupported || sonifyResult.noteCount === 0}
              >
                Play
              </Button>
            )}
            <Button icon={<Stop24Regular />} onClick={handleStop} disabled={!audioSupported}>
              Stop
            </Button>
            {playing && currentNote?.midi != null && (
              <Badge appearance="tint" color="danger" size="large">
                {'\u266a '}
                {midiToNoteName(currentNote.midi)}
              </Badge>
            )}
            <span className={styles.transportSpacer} />
            <Caption1>
              {sonifyResult.noteCount} notes
              {sonifyResult.restCount > 0 ? ` · ${sonifyResult.restCount} rests` : ''} ·{' '}
              {sonifyResult.totalDurationSec.toFixed(1)}s · {currentSec.toFixed(1)}s
            </Caption1>
          </div>

          <OutputDescription label="Signal & playhead">
            {EXPLAINERS.sonify.outputs!.chart}
          </OutputDescription>
          {chartOption && <EChart option={chartOption} height={320} notMerge={false} />}
        </Card>
      )}
    </div>
  );
}
