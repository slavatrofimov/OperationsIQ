import { describe, it, expect } from 'vitest';
import {
  midiToFreq,
  midiToNoteName,
  percentileClip,
  robustNormalize,
  normalizedToMidi,
  quantizeToScale,
  paaDownsample,
  loudnessFeature,
  featureToGains,
  sonify,
  SCALE_SEMITONES,
  DEFAULT_SONIFY_PARAMS,
  type SonifyParams,
} from './sonify';

const params = (over: Partial<SonifyParams> = {}): SonifyParams => ({
  ...DEFAULT_SONIFY_PARAMS,
  ...over,
});

describe('midiToFreq', () => {
  it('maps A4 (69) to 440 Hz and C4 (60) to ~261.63 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6);
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3);
  });
  it('is one octave up per 12 semitones', () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 6);
  });
});

describe('midiToNoteName', () => {
  it('names notes in scientific pitch notation', () => {
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(69)).toBe('A4');
    expect(midiToNoteName(72)).toBe('C5');
    expect(midiToNoteName(61)).toBe('C\u266f4');
  });
  it('rounds fractional MIDI values', () => {
    expect(midiToNoteName(60.4)).toBe('C4');
  });
});

describe('percentileClip', () => {
  it('clips outliers symmetrically', () => {
    const vals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const [lo, hi] = percentileClip(vals, 0.1);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThan(100); // the outlier is clipped out
  });
  it('ignores nulls and returns [0,0] when empty', () => {
    expect(percentileClip([null, null], 0.02)).toEqual([0, 0]);
  });
});

describe('robustNormalize', () => {
  it('maps to [0,1] and clamps', () => {
    expect(robustNormalize(5, 0, 10)).toBeCloseTo(0.5);
    expect(robustNormalize(-5, 0, 10)).toBe(0);
    expect(robustNormalize(50, 0, 10)).toBe(1);
  });
  it('returns 0.5 for a flat range', () => {
    expect(robustNormalize(7, 7, 7)).toBe(0.5);
  });
});

describe('normalizedToMidi', () => {
  it('centers 0.5 on centerMidi and spans octaves symmetrically', () => {
    expect(normalizedToMidi(0.5, 2, 60)).toBe(60);
    expect(normalizedToMidi(1, 2, 60)).toBe(72); // +1 octave
    expect(normalizedToMidi(0, 2, 60)).toBe(48); // -1 octave
  });
});

describe('quantizeToScale', () => {
  it('snaps to nearest pentatonic degree anchored on C', () => {
    // Pentatonic degrees relative to C: 0,2,4,7,9. MIDI 61 (C#) -> nearest is 60 (C).
    expect(quantizeToScale(61, 'pentatonic', 60)).toBe(60);
    // 62 (D) is itself a degree.
    expect(quantizeToScale(62, 'pentatonic', 60)).toBe(62);
    // 65 (F, degree 5) is not pentatonic; nearest degree is 64 (E) or 67 (G) — 65->64.
    expect(quantizeToScale(65, 'pentatonic', 60)).toBe(64);
  });
  it('chromatic rounds to nearest semitone', () => {
    expect(quantizeToScale(60.4, 'chromatic', 60)).toBe(60);
    expect(quantizeToScale(60.6, 'chromatic', 60)).toBe(61);
  });
  it('none leaves pitch continuous', () => {
    expect(quantizeToScale(60.4, 'none', 60)).toBe(60.4);
  });
  it('only ever returns allowed pitch classes for major', () => {
    const degrees = SCALE_SEMITONES.major;
    for (let m = 48; m <= 84; m++) {
      const q = quantizeToScale(m + 0.3, 'major', 60);
      expect(degrees.includes(((q - 60) % 12 + 12) % 12)).toBe(true);
    }
  });
});

describe('paaDownsample', () => {
  it('reduces length to the target and averages buckets', () => {
    const x = [0, 1, 2, 3];
    const values = [0, 10, 20, 30];
    const out = paaDownsample(x, values, undefined, 2);
    expect(out.values.length).toBe(2);
    expect(out.values[0]).toBeCloseTo(5); // mean(0,10)
    expect(out.values[1]).toBeCloseTo(25); // mean(20,30)
  });
  it('returns input unchanged when it already fits', () => {
    const x = [0, 1];
    const values = [1, 2];
    const out = paaDownsample(x, values, undefined, 10);
    expect(out.values).toBe(values);
  });
  it('keeps an all-null bucket null and ignores nulls in a mixed bucket', () => {
    const out = paaDownsample([0, 1, 2, 3], [null, null, 4, null], undefined, 2);
    expect(out.values[0]).toBeNull();
    expect(out.values[1]).toBeCloseTo(4);
  });
});

describe('loudnessFeature', () => {
  it('deviation uses baseline when present', () => {
    const f = loudnessFeature([10, 12], [10, 10], 'deviation');
    expect(f).toEqual([0, 2]);
  });
  it('change is absolute first difference', () => {
    const f = loudnessFeature([5, 8, 6], undefined, 'change');
    expect(f).toEqual([0, 3, 2]);
  });
  it('fixed is constant and rests stay null', () => {
    const f = loudnessFeature([5, null, 6], undefined, 'fixed');
    expect(f).toEqual([1, null, 1]);
  });
});

describe('featureToGains', () => {
  it('maps the feature into [minGain, maxGain]', () => {
    const g = featureToGains([0, 5, 10], 0.2, 1);
    expect(g[0]).toBeCloseTo(0.2);
    expect(g[2]).toBeCloseTo(1);
    expect(g[1]).toBeCloseTo(0.6);
  });
  it('a flat feature maps to maxGain', () => {
    const g = featureToGains([3, 3, 3], 0.2, 1);
    expect(g).toEqual([1, 1, 1]);
  });
});

describe('sonify', () => {
  it('sustains equal consecutive notes into one longer note', () => {
    // Flat series -> all samples map to the same (center) pitch -> one sustained note.
    const x = [0, 1, 2, 3];
    const res = sonify({ x, values: [5, 5, 5, 5] }, params({ notesPerSecond: 4 }));
    expect(res.noteCount).toBe(1);
    expect(res.notes[0].durSec).toBeCloseTo(1); // 4 samples * (1/4)s
    expect(res.notes[0].startSec).toBe(0);
  });

  it('re-articulates a distinct note when the pitch changes', () => {
    // A rising ramp spanning the pitch range with chromatic scale -> distinct notes.
    const x = [0, 1, 2, 3, 4];
    const values = [0, 1, 2, 3, 4];
    const res = sonify(
      { x, values },
      params({ scale: 'chromatic', octaves: 4, notesPerSecond: 4, clipPercentile: 0 }),
    );
    expect(res.noteCount).toBeGreaterThan(1);
    // Notes are contiguous in time.
    for (let i = 1; i < res.notes.length; i++) {
      expect(res.notes[i].startSec).toBeGreaterThan(res.notes[i - 1].startSec);
    }
  });

  it('renders nulls as rests that still consume time', () => {
    const x = [0, 1, 2, 3];
    const res = sonify({ x, values: [5, null, null, 5] }, params({ notesPerSecond: 2 }));
    expect(res.restCount).toBe(2);
    // Two audible notes (before and after the gap), separated by the rest duration.
    expect(res.noteCount).toBe(2);
    expect(res.notes[1].startSec).toBeCloseTo(3 * 0.5); // 4th sample at index 3
    expect(res.totalDurationSec).toBeCloseTo(4 * 0.5);
  });

  it('caps note count via PAA when the series exceeds maxNotes', () => {
    const n = 1000;
    const x = Array.from({ length: n }, (_, i) => i);
    const values = Array.from({ length: n }, (_, i) => Math.sin(i / 5));
    const res = sonify({ x, values }, params({ maxNotes: 100 }));
    expect(res.gridValues.length).toBe(100);
    expect(res.noteCount).toBeLessThanOrEqual(100);
  });

  it('louder note for a larger deviation from baseline', () => {
    // Two flat-ish segments; the second sample deviates far from baseline.
    const x = [0, 1];
    const res = sonify(
      { x, values: [10, 50], baseline: [10, 10] },
      params({ scale: 'chromatic', octaves: 6, loudnessSource: 'deviation', clipPercentile: 0 }),
    );
    // Distinct notes; the high-deviation sample is at max gain, the zero-deviation at min.
    const byIndex = [...res.notes].sort((a, b) => a.sampleIndex - b.sampleIndex);
    expect(byIndex[byIndex.length - 1].gain).toBeGreaterThan(byIndex[0].gain);
  });

  it('produces frequencies consistent with the note MIDI numbers', () => {
    const res = sonify({ x: [0], values: [5] }, params());
    expect(res.notes[0].freq).toBeCloseTo(midiToFreq(res.notes[0].midi), 6);
  });
});
