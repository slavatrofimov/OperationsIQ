/**
 * Frequency-spectrum analysis backed by KQL `series_fft`.
 *
 * `series_fft` transforms a uniformly sampled signal into the frequency domain,
 * returning the real and imaginary components of the complex spectrum. For a
 * series of length N sampled every `binSeconds`:
 *
 *  - the magnitude of bin k is sqrt(re[k]² + im[k]²),
 *  - bin k corresponds to a frequency of k / N cycles per sample
 *    (= (k / N) / binSeconds cycles per second), and
 *  - only bins 1 .. floor(N/2) are physically meaningful (the spectrum is
 *    symmetric about the Nyquist frequency), and bin 0 is the DC/mean term.
 *
 * We drop bin 0 (the mean) and the mirror half, then expose each remaining bin
 * as a magnitude with its equivalent period so the page can plot a
 * magnitude-vs-frequency spectrum and list dominant peaks. Peaks are local
 * maxima ranked by magnitude — useful for spotting the rotating/vibration
 * frequency of equipment.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

export interface SpectrumBin {
  /** FFT bin index (1-based here; bin 0 = DC is dropped). */
  index: number;
  /** Frequency in cycles per sample (bin). */
  freqPerBin: number;
  /** Frequency in cycles per second (Hz), using the sample interval. */
  freqHz: number;
  /** Equivalent period in samples (bins): N / index. */
  periodBins: number;
  /** Equivalent period in seconds: periodBins · binSeconds. */
  periodSeconds: number;
  /** Spectral magnitude sqrt(re² + im²). */
  magnitude: number;
}

export interface Spectrum {
  tagId: string;
  /** Number of samples fed to the FFT. */
  n: number;
  binSeconds: number;
  /** Meaningful half-spectrum bins (index 1 .. floor(n/2)). */
  bins: SpectrumBin[];
  /** Dominant peaks (local maxima), ranked by magnitude (strongest first). */
  peaks: SpectrumBin[];
}

interface SpectrumRow {
  SignalId: string;
  Timestamp: string[];
  Value: (number | null)[];
  FreqReal: (number | null)[];
  FreqImag: (number | null)[];
}

/**
 * Parse the single-row {@link buildSpectrumQuery} result into a half-spectrum.
 * `binSeconds` is the uniform sample interval used by the make-series step and
 * sets the physical frequency/period axis.
 */
export function parseSpectrum(table: KustoTable, binSeconds: number, maxPeaks = 8): Spectrum | null {
  const r = rowsToObjects<SpectrumRow>(table)[0];
  if (!r) return null;
  const re = (r.FreqReal ?? []).map((x) => (x == null ? 0 : Number(x)));
  const im = (r.FreqImag ?? []).map((x) => (x == null ? 0 : Number(x)));
  const n = re.length;
  if (n === 0) return null;

  const half = Math.floor(n / 2);
  const bins: SpectrumBin[] = [];
  // Skip bin 0 (DC / mean); keep the meaningful lower half of the spectrum.
  for (let k = 1; k <= half; k++) {
    const magnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    const freqPerBin = k / n;
    const periodBins = n / k;
    bins.push({
      index: k,
      freqPerBin,
      freqHz: binSeconds > 0 ? freqPerBin / binSeconds : 0,
      periodBins,
      periodSeconds: periodBins * binSeconds,
      magnitude,
    });
  }

  return {
    tagId: r.SignalId,
    n,
    binSeconds,
    bins,
    peaks: findPeaks(bins, maxPeaks),
  };
}

/**
 * Rank dominant spectral peaks. A bin is a peak if its magnitude is a strict
 * local maximum (greater than both neighbors); the endpoints qualify against
 * their single neighbor. Peaks are returned strongest-first, capped at `max`.
 */
export function findPeaks(bins: SpectrumBin[], max = 8): SpectrumBin[] {
  const peaks: SpectrumBin[] = [];
  for (let i = 0; i < bins.length; i++) {
    const m = bins[i].magnitude;
    const prev = i > 0 ? bins[i - 1].magnitude : -Infinity;
    const next = i < bins.length - 1 ? bins[i + 1].magnitude : -Infinity;
    if (m > prev && m >= next && m > 0) peaks.push(bins[i]);
  }
  peaks.sort((a, b) => b.magnitude - a.magnitude);
  return peaks.slice(0, max);
}

// --- spectrogram (Short-Time Fourier Transform) -----------------------------

/** One STFT frame: a half-spectrum of magnitudes anchored at a point in time. */
export interface SpectrogramFrame {
  /** 0-based frame index (time order). */
  frameIndex: number;
  /** Start offset of the frame in samples/bins from the series start. */
  startIdx: number;
  /** Epoch milliseconds of the frame center (for the heatmap time axis). */
  centerMs: number;
  /** Half-spectrum magnitudes; `magnitudes[i]` is FFT bin `i + 1` (DC dropped). */
  magnitudes: number[];
}

export interface Spectrogram {
  tagId: string;
  /** Frame (window) length in samples/bins fed to each FFT. */
  windowBins: number;
  /** Hop (advance) between successive frames, in samples/bins. */
  hopBins: number;
  binSeconds: number;
  /** Number of meaningful frequency bins per frame (floor(windowBins / 2)). */
  half: number;
  /** Frequency (Hz) of each bin, aligned with {@link SpectrogramFrame.magnitudes}. */
  freqHz: number[];
  frames: SpectrogramFrame[];
}

interface SpectrogramRow {
  SignalId: string;
  FrameIndex: number;
  FrameStartIdx: number;
  FreqReal: (number | null)[];
  FreqImag: (number | null)[];
}

/**
 * Parse the per-frame {@link buildSpectrogramQuery} result into a
 * {@link Spectrogram}. Each row is one frame; for every frame we drop the DC
 * term and the mirror half (as {@link parseSpectrum} does) and compute the
 * magnitude of the meaningful lower-half bins. `start` and `binSeconds` place
 * each frame on the wall-clock time axis (the frame center).
 */
export function parseSpectrogram(
  table: KustoTable,
  binSeconds: number,
  start: Date,
): Spectrogram | null {
  const rows = rowsToObjects<SpectrogramRow>(table);
  if (rows.length === 0) return null;

  const startMs = start.getTime();
  const stepMs = binSeconds * 1000;
  const frames: SpectrogramFrame[] = [];
  let windowBins = 0;

  for (const r of rows) {
    const re = (r.FreqReal ?? []).map((x) => (x == null ? 0 : Number(x)));
    const im = (r.FreqImag ?? []).map((x) => (x == null ? 0 : Number(x)));
    const w = re.length;
    if (w === 0) continue;
    windowBins = w;
    const half = Math.floor(w / 2);
    const magnitudes: number[] = [];
    for (let k = 1; k <= half; k++) {
      magnitudes.push(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    }
    const startIdx = Number(r.FrameStartIdx);
    frames.push({
      frameIndex: Number(r.FrameIndex),
      startIdx,
      centerMs: startMs + (startIdx + w / 2) * stepMs,
      magnitudes,
    });
  }

  if (frames.length === 0 || windowBins === 0) return null;

  frames.sort((a, b) => a.frameIndex - b.frameIndex);
  const half = Math.floor(windowBins / 2);
  const freqHz: number[] = [];
  for (let k = 1; k <= half; k++) {
    freqHz.push(binSeconds > 0 ? k / windowBins / binSeconds : 0);
  }

  // Recover the hop from the first two frames' start offsets (constant stride).
  const hopBins = frames.length > 1 ? frames[1].startIdx - frames[0].startIdx : windowBins;

  return {
    tagId: rows[0].SignalId,
    windowBins,
    hopBins: hopBins > 0 ? hopBins : windowBins,
    binSeconds,
    half,
    freqHz,
    frames,
  };
}

/** Largest power of two that is <= n (0 for n < 1). */
export function largestPow2AtMost(n: number): number {
  if (n < 1) return 0;
  return 2 ** Math.floor(Math.log2(n));
}

/** Nearest power of two to n (ties round up), minimum 1. */
export function nearestPow2(n: number): number {
  if (n <= 1) return 1;
  const lower = 2 ** Math.floor(Math.log2(n));
  const upper = lower * 2;
  return n - lower < upper - n ? lower : upper;
}

/**
 * Pick a sensible default STFT window length (in samples/bins) for a series of
 * `n` samples. Targets ~16 frames of time resolution while keeping enough
 * frequency bins, as the nearest power of two to n/16, clamped to [32, 256] and
 * never larger than the series itself. Returns 0 when the series is too short
 * (< 32 samples) to form a meaningful spectrogram.
 */
export function chooseSpectrogramWindow(n: number): number {
  if (n < 32) return 0;
  const target = nearestPow2(n / 16);
  const clamped = Math.min(256, Math.max(32, target));
  return Math.min(clamped, largestPow2AtMost(n));
}

/**
 * Hop (advance) between successive frames for a given window length and overlap
 * percentage. Overlap 0% → hop = window (no overlap); 50% → hop = window/2.
 * Clamped to at least 1 sample and at most the window length.
 */
export function hopFromOverlap(windowBins: number, overlapPct: number): number {
  const frac = 1 - Math.min(100, Math.max(0, overlapPct)) / 100;
  return Math.min(windowBins, Math.max(1, Math.round(windowBins * frac)));
}
