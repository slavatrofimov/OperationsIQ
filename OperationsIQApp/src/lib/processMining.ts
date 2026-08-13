/**
 * Process mining over threshold-derived operating states.
 *
 * `buildProcessMiningQuery` classifies each time bin of a signal into one of an
 * ordered set of operating bands (N thresholds -> N+1 labeled states, e.g.
 * off / idle / run / overload, defaulting to low / normal / high) and uses the
 * KQL `scan` operator to collapse consecutive same-state bins into episodes.
 * This module parses those episodes and mines recurring operational sequences
 * (n-grams of consecutive states) with occurrence counts and median durations —
 * e.g. how often a low -> normal -> high startup ramp occurs and how long it
 * typically takes.
 *
 * Scope note: states are derived purely from one signal's value thresholds.
 * Correlating discovered sequences with discrete Events (alarms, mode changes)
 * is a natural future extension and is intentionally out of scope here.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/**
 * An ordered set of operating bands: `thresholds` are ascending cut points and
 * `labels` names each band from lowest to highest. N thresholds define N+1
 * bands, where each threshold is the inclusive lower bound of the band above it
 * (band k covers `[thresholds[k-1], thresholds[k])`; the lowest band is
 * everything below `thresholds[0]`).
 */
export interface BandModel {
  thresholds: number[];
  labels: string[];
}

/** The classic three-band low / normal / high setup used as the default. */
export const DEFAULT_BAND_MODEL: BandModel = {
  thresholds: [20, 80],
  labels: ['low', 'normal', 'high'],
};

/**
 * Validate a band model, returning a human-readable error message or `null`
 * when it is well-formed. Enforces at least two bands, `labels.length ===
 * thresholds.length + 1`, non-empty and case-insensitively unique labels, and
 * strictly ascending finite thresholds.
 */
export function validateBandModel(m: BandModel): string | null {
  const { thresholds, labels } = m;
  if (labels.length < 2) return 'Define at least two bands.';
  if (labels.length !== thresholds.length + 1) {
    return 'Each pair of bands needs one threshold between them (labels must equal thresholds + 1).';
  }
  if (labels.some((l) => !l.trim())) return 'Every band needs a name.';
  const lower = labels.map((l) => l.trim().toLowerCase());
  if (new Set(lower).size !== lower.length) return 'Band names must be unique.';
  if (thresholds.some((t) => !Number.isFinite(t))) return 'Thresholds must be numbers.';
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1]) {
      return 'Thresholds must increase from the lowest band to the highest.';
    }
  }
  return null;
}

/**
 * Append a new highest band, placing its lower threshold one step above the
 * current top (reusing the last gap, or 10 when there is none to infer).
 */
export function addBand(m: BandModel): BandModel {
  const { thresholds, labels } = m;
  const n = thresholds.length;
  const last = n ? thresholds[n - 1] : 0;
  const gap = n >= 2 ? thresholds[n - 1] - thresholds[n - 2] : 10;
  const step = Number.isFinite(gap) && gap > 0 ? gap : 10;
  return {
    thresholds: [...thresholds, last + step],
    labels: [...labels, `band ${labels.length + 1}`],
  };
}

/**
 * Remove band `index`, dropping the threshold that borders it (the boundary
 * below it, or the boundary above the lowest band). Keeps at least two bands.
 */
export function removeBand(m: BandModel, index: number): BandModel {
  const { thresholds, labels } = m;
  if (labels.length <= 2 || index < 0 || index >= labels.length) return m;
  const thIndex = index === 0 ? 0 : index - 1;
  return {
    thresholds: thresholds.filter((_, i) => i !== thIndex),
    labels: labels.filter((_, i) => i !== index),
  };
}

export interface Episode {
  segId: number;
  state: string;
  /** Episode start (epoch ms). */
  start: number;
  /** Last bin's timestamp within the episode (epoch ms). */
  end: number;
  /** Number of bins in the episode. */
  bins: number;
  /** Episode duration in seconds (span + one trailing bin). */
  durationSeconds: number;
}

export interface DiscoveredSequence {
  /** The ordered states, e.g. ['low','normal','high']. */
  states: string[];
  /** Stable key, e.g. 'low > normal > high'. */
  key: string;
  /** How many times this sequence occurred. */
  count: number;
  /** Median total duration (seconds) across occurrences. */
  medianDurationSeconds: number;
}

export interface StateStat {
  state: string;
  episodes: number;
  totalDurationSeconds: number;
}

export interface ProcessMining {
  episodes: Episode[];
  sequences: DiscoveredSequence[];
  /** Distinct states present, in canonical low/normal/high order where possible. */
  states: string[];
  stateStats: StateStat[];
  sequenceLength: number;
}

interface EpisodeRow {
  SegId: number;
  State: string;
  StartTime: string;
  EndTime: string;
  Bins: number;
}

const STATE_ORDER = ['low', 'normal', 'high'];

/**
 * Build a comparator index for states given the caller's band order (lowest to
 * highest). Falls back to the canonical low/normal/high order, then to
 * unknown-last for anything not in the list.
 */
function makeOrderIndex(bandOrder?: string[]): (state: string) => number {
  const order = bandOrder && bandOrder.length ? bandOrder : STATE_ORDER;
  return (state: string) => {
    const i = order.indexOf(state);
    return i === -1 ? order.length : i;
  };
}

function toMs(v: unknown): number {
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Parse scan-produced episode rows into typed, duration-annotated episodes. */
export function parseEpisodes(table: KustoTable, binSeconds: number): Episode[] {
  const rows = rowsToObjects<EpisodeRow>(table);
  const episodes: Episode[] = [];
  for (const r of rows) {
    const start = toMs(r.StartTime);
    const end = toMs(r.EndTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const bins = Number(r.Bins) || 0;
    // Span from first to last bin, plus one bin so a single-bin episode still
    // has a positive duration.
    const durationSeconds = Math.max(0, (end - start) / 1000) + binSeconds;
    episodes.push({
      segId: Number(r.SegId) || 0,
      state: String(r.State ?? ''),
      start,
      end,
      bins,
      durationSeconds,
    });
  }
  episodes.sort((a, b) => a.start - b.start);
  return episodes;
}

/**
 * Mine recurring sequences of `length` consecutive episode states via a sliding
 * window. Each window contributes its total duration; the median across
 * occurrences is reported. Sequences are ranked by descending count then
 * duration.
 */
export function mineSequences(episodes: Episode[], length: number): DiscoveredSequence[] {
  if (length < 2 || episodes.length < length) return [];
  const groups = new Map<string, { states: string[]; durations: number[] }>();
  for (let i = 0; i + length <= episodes.length; i++) {
    const window = episodes.slice(i, i + length);
    const states = window.map((e) => e.state);
    const key = states.join(' > ');
    const total = window.reduce((sum, e) => sum + e.durationSeconds, 0);
    const g = groups.get(key);
    if (g) g.durations.push(total);
    else groups.set(key, { states, durations: [total] });
  }
  const out: DiscoveredSequence[] = [];
  for (const [key, g] of groups) {
    out.push({
      states: g.states,
      key,
      count: g.durations.length,
      medianDurationSeconds: median(g.durations),
    });
  }
  out.sort((a, b) => b.count - a.count || b.medianDurationSeconds - a.medianDurationSeconds);
  return out;
}

/** Per-state episode counts and total dwell time. */
export function summarizeStates(episodes: Episode[], bandOrder?: string[]): StateStat[] {
  const orderIndex = makeOrderIndex(bandOrder);
  const map = new Map<string, StateStat>();
  for (const e of episodes) {
    const s = map.get(e.state) ?? { state: e.state, episodes: 0, totalDurationSeconds: 0 };
    s.episodes += 1;
    s.totalDurationSeconds += e.durationSeconds;
    map.set(e.state, s);
  }
  return Array.from(map.values()).sort(
    (a, b) => orderIndex(a.state) - orderIndex(b.state),
  );
}

/** Full parse: episodes + mined sequences + per-state stats. */
export function parseProcessMining(
  table: KustoTable,
  binSeconds: number,
  sequenceLength = 3,
  bandOrder?: string[],
): ProcessMining {
  const orderIndex = makeOrderIndex(bandOrder);
  const episodes = parseEpisodes(table, binSeconds);
  const states = Array.from(new Set(episodes.map((e) => e.state))).sort(
    (a, b) => orderIndex(a) - orderIndex(b),
  );
  return {
    episodes,
    sequences: mineSequences(episodes, sequenceLength),
    states,
    stateStats: summarizeStates(episodes, bandOrder),
    sequenceLength,
  };
}
