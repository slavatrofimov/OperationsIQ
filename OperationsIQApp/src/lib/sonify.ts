/**
 * Time-series sonification core — turn a numeric series into a sequence of
 * musical notes ("Sonify"). This is the pure, framework-agnostic transformation
 * layer: it takes samples in and produces {@link NoteEvent}s out, with no audio
 * or DOM dependencies, so it is fully unit-testable. The Web Audio scheduling
 * lives separately in `audio/WebAudioPlayer.ts`.
 *
 * Conceptually this extends SAX (Symbolic Aggregate approXimation) from letters
 * into music: where SAX bins a value's amplitude into an alphabet symbol, here we
 * bin it into a musical scale degree. The mapping is:
 *   - value      -> pitch   (normalized, centered on middle C, snapped to a scale)
 *   - a feature  -> loudness (default: deviation from baseline, so anomalies pop)
 *   - time       -> note onset (a fixed notes-per-second tempo)
 * Consecutive samples that map to the same note are merged into one *sustained*
 * note (no re-attack); a change starts a new, distinct note.
 *
 * The core plays a single series, but the shape (`sonify(series) -> NoteEvent[]`)
 * is intentionally per-series so multiple series can later be rendered as
 * separate voices on a shared transport.
 */

/** Pitch-quantization scale. `none` keeps continuous (un-snapped) pitch. */
export type SonifyScale = 'pentatonic' | 'major' | 'chromatic' | 'none';

/** What drives per-note loudness (pitch already encodes the value). */
export type LoudnessSource = 'deviation' | 'change' | 'magnitude' | 'fixed';

/** Oscillator timbre used by the player (carried here for convenience). */
export type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** Semitone offsets (relative to the scale root / center pitch class) per scale. */
export const SCALE_SEMITONES: Record<Exclude<SonifyScale, 'none'>, number[]> = {
  // Major pentatonic — no semitone clashes, hardest to make dissonant.
  pentatonic: [0, 2, 4, 7, 9],
  // Major (Ionian) diatonic.
  major: [0, 2, 4, 5, 7, 9, 11],
  // All twelve — most faithful to the data, can sound dissonant.
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export interface SonifyParams {
  /** Pitch-quantization scale (default 'pentatonic'). */
  scale: SonifyScale;
  /** Total pitch span in octaves, centered on {@link centerMidi}. */
  octaves: number;
  /** Center MIDI note (60 = middle C / C4). */
  centerMidi: number;
  /** Playback tempo as notes (samples) per second. */
  notesPerSecond: number;
  /** Cap on the number of played samples; longer series are PAA-downsampled. */
  maxNotes: number;
  /** What the loudness of each note encodes. */
  loudnessSource: LoudnessSource;
  /** Quietest gain (0..1) a played note can have. */
  minGain: number;
  /** Loudest gain (0..1) a played note can have. */
  maxGain: number;
  /**
   * Fraction clipped from each tail of the value distribution before scaling,
   * so a few outliers don't compress the whole melody into one pitch (e.g. 0.02
   * clips the 2nd and 98th percentiles).
   */
  clipPercentile: number;
}

/** Sensible defaults matching the page's initial control values. */
export const DEFAULT_SONIFY_PARAMS: SonifyParams = {
  scale: 'pentatonic',
  octaves: 2,
  centerMidi: 60,
  notesPerSecond: 8,
  maxNotes: 400,
  loudnessSource: 'deviation',
  minGain: 0.12,
  maxGain: 1,
  clipPercentile: 0.02,
};

/** One scheduled note (or, transitively, a sustained run of equal notes). */
export interface NoteEvent {
  /** Onset time in seconds from playback start. */
  startSec: number;
  /** Duration in seconds (a sustained run is longer than one sample interval). */
  durSec: number;
  /** MIDI note number (may be fractional when scale is 'none'). */
  midi: number;
  /** Oscillator frequency in Hz. */
  freq: number;
  /** Linear gain in [0, 1]. */
  gain: number;
  /** Index into the (downsampled) grid where this note starts. */
  sampleIndex: number;
  /** Unix seconds of the sample at note start (for playhead sync). */
  xSec: number;
}

/** Raw input for {@link sonify}; decoupled from any specific series type. */
export interface SonifyInput {
  /** X positions as unix seconds (monotonic). */
  x: number[];
  /** Sample values; null marks a gap (rendered as a rest/silence). */
  values: (number | null)[];
  /** Optional per-sample baseline (e.g. a trend/seasonal fit) for deviation loudness. */
  baseline?: (number | null)[];
}

export interface SonifyResult {
  notes: NoteEvent[];
  /** Total playback length in seconds (includes trailing rests). */
  totalDurationSec: number;
  /** Downsampled x grid (unix seconds) aligned to the note grid. */
  gridX: number[];
  /** Downsampled values aligned to the grid (null = rest). */
  gridValues: (number | null)[];
  /** Number of audible notes produced. */
  noteCount: number;
  /** Number of grid samples that were rests (gaps). */
  restCount: number;
}

/** Convert a MIDI note number to frequency in Hz (A4 = 69 = 440 Hz). */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C\u266f', 'D', 'D\u266f', 'E', 'F', 'F\u266f', 'G', 'G\u266f', 'A', 'A\u266f', 'B'];

/**
 * Human-readable note name for a MIDI number using scientific pitch notation
 * (e.g. 60 -> "C4", 69 -> "A4"). Fractional inputs (scale 'none') are rounded.
 */
export function midiToNoteName(midi: number): string {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

/** Linear quantile of an already-sorted ascending array (fraction in [0,1]). */
function sortedQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Robust [low, high] value bounds via symmetric percentile clipping. Returns the
 * min/max when there aren't enough points, and a degenerate equal pair when the
 * series is flat (callers map that to the center pitch).
 */
export function percentileClip(
  values: (number | null)[],
  clip: number,
): [number, number] {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) return [0, 0];
  const sorted = [...finite].sort((a, b) => a - b);
  const c = Math.min(Math.max(clip, 0), 0.49);
  return [sortedQuantile(sorted, c), sortedQuantile(sorted, 1 - c)];
}

/** Map a value into [0,1] against [lo, hi], clamped; flat range -> 0.5. */
export function robustNormalize(v: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 0.5;
  return Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
}

/**
 * Map a normalized value (0..1) to a MIDI note across an `octaves`-wide span
 * centered on `centerMidi` (0.5 -> center, 0 -> center - octaves*6, 1 -> center +
 * octaves*6). Not yet snapped to a scale.
 */
export function normalizedToMidi(norm: number, octaves: number, centerMidi: number): number {
  return centerMidi + (norm - 0.5) * (octaves * 12);
}

/**
 * Snap a MIDI note to the nearest note belonging to `scale`, anchored so that
 * `centerMidi`'s pitch class is the scale root. `none` returns the input pitch
 * unchanged (continuous). Chromatic rounds to the nearest semitone.
 */
export function quantizeToScale(midi: number, scale: SonifyScale, centerMidi: number): number {
  if (scale === 'none') return midi;
  const degrees = SCALE_SEMITONES[scale];
  const rootPc = ((centerMidi % 12) + 12) % 12;
  // Search a small neighborhood of candidate notes around `midi` and pick the
  // closest whose pitch class is an allowed scale degree.
  const base = Math.round(midi);
  let best = base;
  let bestDist = Infinity;
  for (let n = base - 12; n <= base + 12; n++) {
    const pc = ((n - rootPc) % 12 + 12) % 12;
    if (!degrees.includes(pc)) continue;
    const dist = Math.abs(n - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  return best;
}

/**
 * Piecewise Aggregate Approximation: reduce parallel x/value/baseline arrays to
 * at most `targetLen` buckets by averaging (nulls ignored; an all-null bucket
 * stays null). This is the SAX "PAA" step, reused to keep playback listenable for
 * long series. Returns the input unchanged when it already fits.
 */
export function paaDownsample(
  x: number[],
  values: (number | null)[],
  baseline: (number | null)[] | undefined,
  targetLen: number,
): { x: number[]; values: (number | null)[]; baseline?: (number | null)[] } {
  const n = values.length;
  if (targetLen <= 0 || n <= targetLen) {
    return { x, values, baseline };
  }
  const outX: number[] = [];
  const outV: (number | null)[] = [];
  const outB: (number | null)[] = [];
  const hasBaseline = Array.isArray(baseline);
  for (let i = 0; i < targetLen; i++) {
    const lo = Math.floor((i * n) / targetLen);
    const hi = Math.floor(((i + 1) * n) / targetLen);
    const end = Math.max(hi, lo + 1);
    outX.push(bucketMeanX(x, lo, end));
    outV.push(bucketMean(values, lo, end));
    if (hasBaseline) outB.push(bucketMean(baseline as (number | null)[], lo, end));
  }
  return hasBaseline ? { x: outX, values: outV, baseline: outB } : { x: outX, values: outV };
}

function bucketMean(arr: (number | null)[], lo: number, hi: number): number | null {
  let sum = 0;
  let count = 0;
  for (let i = lo; i < hi && i < arr.length; i++) {
    const v = arr[i];
    if (v != null && Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return count === 0 ? null : sum / count;
}

function bucketMeanX(arr: number[], lo: number, hi: number): number {
  let sum = 0;
  let count = 0;
  for (let i = lo; i < hi && i < arr.length; i++) {
    if (Number.isFinite(arr[i])) {
      sum += arr[i];
      count++;
    }
  }
  return count === 0 ? arr[Math.min(lo, arr.length - 1)] ?? 0 : sum / count;
}

/** Mean of the finite entries (0 when none). */
function finiteMean(values: (number | null)[]): number {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

/**
 * Per-sample raw loudness feature (not yet normalized). null where the sample is
 * a rest. `deviation` uses the baseline when present, else the series mean.
 */
export function loudnessFeature(
  values: (number | null)[],
  baseline: (number | null)[] | undefined,
  source: LoudnessSource,
): (number | null)[] {
  const mean = finiteMean(values);
  return values.map((v, i) => {
    if (v == null || !Number.isFinite(v)) return null;
    switch (source) {
      case 'fixed':
        return 1;
      case 'magnitude':
        return v;
      case 'change': {
        const prev = i > 0 ? values[i - 1] : null;
        return prev != null && Number.isFinite(prev) ? Math.abs(v - prev) : 0;
      }
      case 'deviation':
      default: {
        const b = baseline?.[i];
        const ref = b != null && Number.isFinite(b) ? b : mean;
        return Math.abs(v - ref);
      }
    }
  });
}

/** Map a raw loudness-feature array to per-sample gains in [minGain, maxGain]. */
export function featureToGains(
  feature: (number | null)[],
  minGain: number,
  maxGain: number,
): (number | null)[] {
  const finite = feature.filter((v): v is number => v != null && Number.isFinite(v));
  const lo = finite.length ? Math.min(...finite) : 0;
  const hi = finite.length ? Math.max(...finite) : 0;
  return feature.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const norm = hi > lo ? (v - lo) / (hi - lo) : 1;
    return minGain + norm * (maxGain - minGain);
  });
}

/**
 * Transform a series into a list of scheduled notes. Steps: PAA downsample ->
 * robust value scaling -> pitch mapping + scale quantization -> loudness mapping
 * -> run-length "sustain" merge (equal consecutive notes become one note; a
 * change re-articulates); gaps become rests that still consume time.
 */
export function sonify(input: SonifyInput, params: SonifyParams): SonifyResult {
  const p = params;
  const interval = 1 / Math.max(p.notesPerSecond, 0.0001);

  const grid = paaDownsample(input.x, input.values, input.baseline, p.maxNotes);
  const n = grid.values.length;
  const totalDurationSec = n * interval;

  const [lo, hi] = percentileClip(grid.values, p.clipPercentile);

  // Per-sample MIDI (null = rest) and gains.
  const midis: (number | null)[] = grid.values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const norm = robustNormalize(v, lo, hi);
    const raw = normalizedToMidi(norm, p.octaves, p.centerMidi);
    return quantizeToScale(raw, p.scale, p.centerMidi);
  });
  const feature = loudnessFeature(grid.values, grid.baseline, p.loudnessSource);
  const gains = featureToGains(feature, p.minGain, p.maxGain);

  const notes: NoteEvent[] = [];
  let restCount = 0;
  let i = 0;
  while (i < n) {
    const midi = midis[i];
    if (midi == null) {
      restCount++;
      i++;
      continue;
    }
    // Extend the run while the (quantized) note is identical.
    let j = i + 1;
    let maxGain = gains[i] ?? p.minGain;
    while (j < n && midis[j] === midi) {
      const g = gains[j];
      if (g != null && g > maxGain) maxGain = g;
      j++;
    }
    const runLen = j - i;
    notes.push({
      startSec: i * interval,
      durSec: runLen * interval,
      midi,
      freq: midiToFreq(midi),
      gain: maxGain,
      sampleIndex: i,
      xSec: grid.x[i],
    });
    i = j;
  }

  return {
    notes,
    totalDurationSec,
    gridX: grid.x,
    gridValues: grid.values,
    noteCount: notes.length,
    restCount,
  };
}

/** Human label for a scale (for UI dropdowns / captions). */
export const SCALE_LABELS: Record<SonifyScale, string> = {
  pentatonic: 'Pentatonic',
  major: 'Major',
  chromatic: 'Chromatic',
  none: 'Continuous (no scale)',
};

/** Human label for a loudness source. */
export const LOUDNESS_LABELS: Record<LoudnessSource, string> = {
  deviation: 'Deviation from baseline',
  change: 'Rate of change',
  magnitude: 'Value magnitude',
  fixed: 'Fixed',
};
