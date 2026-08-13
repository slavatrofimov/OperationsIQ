/**
 * The analysis wizard's state + reducer (design spec §7.1). Kept as a pure reducer so the
 * step-flow logic (which step is next, when Run is allowed) is unit-tested without React.
 */
import type { JobType } from "../lib/mp/types";
import { recipeById } from "../lib/mp/recipes";
import {
  BIN_COUNT_MAX_MP,
  DEFAULT_BINNING_SETTINGS,
  chooseBinFor,
  parseBinningSettings,
  type BinningSettings,
} from "../lib/binningSettings";
import { durationToSubLen } from "../lib/mp/units";

export type WizardStep = "goal" | "signal" | "length" | "results" | "review";

export const STEP_ORDER: WizardStep[] = ["goal", "signal", "length", "results", "review"];

/** How the user expressed the pattern length: an uncertain range, or a single value. */
export type LengthMode = "range" | "point";

/** How missing buckets (after aggregation) are handled before analysis. */
export type GapFill = "linear" | "none";

/** How finely the Pan-MP length range is sliced into candidate lengths. */
export type ScanGranularity = "coarse" | "balanced" | "fine";

/** Target number of candidate lengths scanned for each granularity. */
const SCAN_TARGET_LENGTHS: Record<ScanGranularity, number> = {
  coarse: 6,
  balanced: 12,
  fine: 24,
};

/** Results cap — complex data sets (e.g. accelerometer behavior classes) can hold many motifs. */
export const MAX_RESULT_COUNT = 100;

/** AB-join (two-series) input mode: two distinct signals, or two windows of one signal. */
export type AbMode = "two-signals" | "two-windows";

/** True for the two-series AB-join job types (compare two periods / machines). */
export function isCompareType(jobType?: JobType): boolean {
  return jobType === "AB_MOTIF" || jobType === "AB_DISCORD";
}

/** True for the multidimensional (mSTAMP) job types — k time-aligned sensors of one asset. */
export function isMultiDimType(jobType?: JobType): boolean {
  return (
    jobType === "MULTIDIM_MOTIF" ||
    jobType === "MULTIDIM_DISCORD" ||
    jobType === "MULTIDIM_SEGMENTATION"
  );
}

/** True for the consensus (Ostinato) job type — one shape shared across N fleet signals. */
export function isConsensusType(jobType?: JobType): boolean {
  return jobType === "CONSENSUS_MOTIF";
}

/** True for any multi-series job type (multidimensional or consensus): the signal step
 *  collects a set of signals rather than one, plus one shared window. */
export function isMultiSeriesType(jobType?: JobType): boolean {
  return isMultiDimType(jobType) || isConsensusType(jobType);
}

/** Minimum number of signals a multi-series analysis needs. */
export const MULTI_SERIES_MIN_SIGNALS = 2;

export interface WizardState {
  step: WizardStep;
  recipeId?: string;
  jobType?: JobType;
  dataSourceId?: string;
  signalId?: string;
  /** Optional user-supplied analysis name; blank means auto-generate at submit. */
  name?: string;
  /** Compatibility hint; the effective sample interval comes from the chosen bin width. */
  sampleRateHz?: number;
  windowStart?: string;
  windowEnd?: string;
  /** AB-join comparison series B selection (only used by compare recipes). */
  abMode?: AbMode;
  compareSignalId?: string;
  compareSampleRateHz?: number;
  compareWindowStart?: string;
  compareWindowEnd?: string;
  /** Multi-series (multidimensional / consensus) selection: the ordered set of signal ids.
   *  signalId mirrors signalIds[0] as the primary/back-compat member. */
  signalIds?: string[];
  /** Consensus only: minimum number of the N signals that must contain the shape (>= m of N).
   *  Undefined = strict all-N consensus. */
  minCount?: number;
  /** Adaptive-binning settings applied to the source read (aggregation + max points + preferred width). */
  binning: BinningSettings;
  /** Pattern-length input mode: an uncertain range (Pan-MP scan) or a single value. */
  lengthMode: LengthMode;
  /** Range mode: lower / upper bound of the pattern length, in seconds. */
  lengthMinSec: number;
  lengthMaxSec: number;
  /** Point mode: a single pattern length, in seconds. */
  lengthSec: number;
  /** Number of results (motifs / discords / regimes) to return, 1..100. */
  resultCount: number;
  /** Minimum separation between results, in seconds; 0 = automatic (exclusion zone). */
  minSeparationSec: number;
  /** Missing-bucket handling after aggregation. */
  gapFill: GapFill;
  /** Range mode only: how finely to slice the length range. */
  scanGranularity: ScanGranularity;
}

export const INITIAL_WIZARD: WizardState = {
  step: "goal",
  binning: parseBinningSettings({ ...DEFAULT_BINNING_SETTINGS }, BIN_COUNT_MAX_MP),
  lengthMode: "range",
  lengthMinSec: 10,
  lengthMaxSec: 600,
  lengthSec: 60,
  resultCount: 3,
  minSeparationSec: 0,
  gapFill: "linear",
  scanGranularity: "balanced",
};

export type WizardAction =
  | { kind: "pickRecipe"; recipeId: string }
  | { kind: "pickSignal"; dataSourceId: string; signalId: string; sampleRateHz: number }
  | { kind: "setWindow"; start: string; end: string }
  | { kind: "setAbMode"; mode: AbMode }
  | { kind: "pickCompareSignal"; signalId: string; sampleRateHz: number }
  | { kind: "setCompareWindow"; start: string; end: string }
  | { kind: "setSignalIds"; dataSourceId: string; signalIds: string[]; sampleRateHz: number }
  | { kind: "setMinCount"; value?: number }
  | { kind: "setBinning"; patch: Partial<BinningSettings> }
  | { kind: "setLengthMode"; mode: LengthMode }
  | { kind: "setLengthRange"; minSec?: number; maxSec?: number }
  | { kind: "setLengthPoint"; seconds: number }
  | { kind: "setResultCount"; value: number }
  | { kind: "setMinSeparation"; seconds: number }
  | { kind: "setGapFill"; value: GapFill }
  | { kind: "setScanGranularity"; value: ScanGranularity }
  | { kind: "setName"; name: string }
  | { kind: "goto"; step: WizardStep }
  | { kind: "next" }
  | { kind: "back" }
  | { kind: "reset" };

function stepIndex(step: WizardStep): number {
  return STEP_ORDER.indexOf(step);
}

/** Whether the AB-join comparison series B is fully specified for the chosen mode. */
export function canAdvanceCompareSignal(state: WizardState): boolean {
  if (!state.signalId || !state.windowStart || !state.windowEnd) return false;
  if (state.abMode === "two-signals") {
    return !!state.compareSignalId;
  }
  if (state.abMode === "two-windows") {
    return !!state.compareWindowStart && !!state.compareWindowEnd;
  }
  return false;
}

/** Whether a multi-series analysis has enough signals + a shared window to advance. */
export function canAdvanceMultiSignal(state: WizardState): boolean {
  const ids = state.signalIds ?? [];
  return ids.length >= MULTI_SERIES_MIN_SIGNALS && !!state.windowStart && !!state.windowEnd;
}

/** Segmentation, chains, the two-series AB-join, and every multi-series analysis run on a
 *  single concrete window length (no length scan). */
function requiresSingleLength(jobType?: JobType): boolean {
  return (
    jobType === "SEGMENTATION" ||
    jobType === "CHAIN" ||
    isCompareType(jobType) ||
    isMultiSeriesType(jobType)
  );
}

/**
 * The effective bin width (seconds per point) the analysis will run at, derived from the
 * window + binning settings exactly as the Spark source read will bin the data. Pattern
 * durations are converted to subsequence lengths (points) against this width.
 */
export function effectiveBinSeconds(state: WizardState): number {
  const fallback =
    state.binning.preferredMillis && state.binning.preferredMillis > 0
      ? state.binning.preferredMillis / 1000
      : 1;
  if (!state.windowStart || !state.windowEnd) return fallback;
  const start = new Date(state.windowStart);
  const end = new Date(state.windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return fallback;
  }
  return chooseBinFor({ start, end }, state.binning).millis / 1000;
}

export interface ResolvedLength {
  /** Effective job type after length-mode routing (e.g. range motif -> PAN_MP scan). */
  type: JobType;
  /** Single subsequence length in points (point mode / non-scan job types). */
  subLen?: number;
  /** Pan-MP scan bounds in points (range mode, scan-capable job types). */
  lengthMin?: number;
  lengthMax?: number;
  lengthStep?: number;
}

/**
 * Resolve the pattern-length inputs into a concrete job configuration in **points**,
 * routing an uncertain range to a Pan-MP length scan for scan-capable analyses and using a
 * single representative length for the rest.
 */
export function resolveLength(state: WizardState): ResolvedLength {
  const binSec = effectiveBinSeconds(state);
  const base = state.jobType ?? "MOTIF_MOMP";

  if (state.lengthMode === "range" && !requiresSingleLength(base)) {
    const lo = durationToSubLen(state.lengthMinSec, binSec);
    const hi = Math.max(lo + 1, durationToSubLen(state.lengthMaxSec, binSec));
    // Motif-family and the auto recipe scan a range of lengths (Pan-MP). DAMP cannot scan,
    // so it falls back to the geometric-mean length as a single representative window.
    if (base === "MOTIF_MOMP" || base === "FULL_MP" || base === "PAN_MP") {
      const target = SCAN_TARGET_LENGTHS[state.scanGranularity];
      const step = Math.max(1, Math.round((hi - lo) / Math.max(1, target - 1)));
      return { type: "PAN_MP", lengthMin: lo, lengthMax: hi, lengthStep: step };
    }
    const midSec = Math.sqrt(state.lengthMinSec * state.lengthMaxSec);
    return { type: base, subLen: durationToSubLen(midSec, binSec) };
  }

  // Point mode: a single length. A single-length request on the auto recipe is really a
  // fixed-length motif search.
  const m = durationToSubLen(state.lengthSec, binSec);
  const type: JobType = base === "PAN_MP" ? "MOTIF_MOMP" : base;
  return { type, subLen: m };
}

/** Whether the given step has enough info to advance. */
export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case "goal":
      return !!state.jobType;
    case "signal":
      if (isMultiSeriesType(state.jobType)) return canAdvanceMultiSignal(state);
      if (isCompareType(state.jobType)) return canAdvanceCompareSignal(state);
      return !!state.signalId && !!state.windowStart && !!state.windowEnd;
    case "length":
      if (state.lengthMode === "range" && !requiresSingleLength(state.jobType)) {
        return state.lengthMinSec > 0 && state.lengthMaxSec > state.lengthMinSec;
      }
      return state.lengthSec > 0;
    case "results":
      return state.resultCount >= 1 && state.resultCount <= MAX_RESULT_COUNT;
    case "review":
      return true;
  }
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.kind) {
    case "pickRecipe": {
      const recipe = recipeById(action.recipeId);
      const jobType = recipe?.jobType;
      // The auto recipe scans a range of lengths; segmentation, chains, and the two-series
      // AB-join need one concrete length, so they start in point mode. Everything else keeps
      // the current mode.
      const lengthMode: LengthMode =
        jobType === "PAN_MP"
          ? "range"
          : requiresSingleLength(jobType)
            ? "point"
            : state.lengthMode;
      // Default new compare recipes to the two-signals mode; clear stale compare state
      // when switching to a single-series recipe so it can't leak into the submitted job.
      const abMode: AbMode | undefined = isCompareType(jobType)
        ? state.abMode ?? "two-signals"
        : undefined;
      const compareReset = isCompareType(jobType)
        ? {}
        : {
            compareSignalId: undefined,
            compareSampleRateHz: undefined,
            compareWindowStart: undefined,
            compareWindowEnd: undefined,
          };
      // Clear stale multi-series selection when switching away from a multi-series recipe;
      // default consensus to strict all-N (minCount undefined).
      const multiReset = isMultiSeriesType(jobType)
        ? {}
        : { signalIds: undefined, minCount: undefined };
      return {
        ...state,
        recipeId: action.recipeId,
        jobType,
        lengthMode,
        abMode,
        ...compareReset,
        ...multiReset,
      };
    }
    case "pickSignal":
      return {
        ...state,
        dataSourceId: action.dataSourceId,
        signalId: action.signalId,
        sampleRateHz: action.sampleRateHz,
      };
    case "setWindow":
      return { ...state, windowStart: action.start, windowEnd: action.end };
    case "setAbMode":
      // Switching mode clears the other mode's compare inputs so validation can't pass on
      // stale values (e.g. a leftover compareSignalId while in two-windows mode).
      return action.mode === "two-signals"
        ? { ...state, abMode: action.mode, compareWindowStart: undefined, compareWindowEnd: undefined }
        : { ...state, abMode: action.mode, compareSignalId: undefined, compareSampleRateHz: undefined };
    case "pickCompareSignal":
      return {
        ...state,
        compareSignalId: action.signalId,
        compareSampleRateHz: action.sampleRateHz,
      };
    case "setCompareWindow":
      return { ...state, compareWindowStart: action.start, compareWindowEnd: action.end };
    case "setSignalIds": {
      const ids = action.signalIds;
      // signalId mirrors the first member so single-series read paths and back-compat
      // queries keep working; sampleRateHz tracks the shared source.
      return {
        ...state,
        dataSourceId: action.dataSourceId,
        signalIds: ids,
        signalId: ids[0],
        sampleRateHz: action.sampleRateHz,
        // Drop a min-count that no longer fits the selected fleet size.
        minCount:
          state.minCount != null && state.minCount > ids.length ? ids.length : state.minCount,
      };
    }
    case "setMinCount": {
      const ids = state.signalIds ?? [];
      const v = action.value;
      if (v == null) return { ...state, minCount: undefined };
      const clamped = Math.max(
        MULTI_SERIES_MIN_SIGNALS,
        Math.min(ids.length || MULTI_SERIES_MIN_SIGNALS, Math.round(v)),
      );
      return { ...state, minCount: clamped };
    }
    case "setBinning":
      return {
        ...state,
        binning: parseBinningSettings(
          { ...state.binning, ...action.patch },
          BIN_COUNT_MAX_MP,
        ),
      };
    case "setLengthMode":
      return { ...state, lengthMode: action.mode };
    case "setLengthRange":
      return {
        ...state,
        lengthMinSec: action.minSec ?? state.lengthMinSec,
        lengthMaxSec: action.maxSec ?? state.lengthMaxSec,
      };
    case "setLengthPoint":
      return { ...state, lengthSec: Math.max(0, action.seconds) };
    case "setResultCount":
      return {
        ...state,
        resultCount: Math.max(1, Math.min(MAX_RESULT_COUNT, Math.round(action.value))),
      };
    case "setMinSeparation":
      return { ...state, minSeparationSec: Math.max(0, action.seconds) };
    case "setGapFill":
      return { ...state, gapFill: action.value };
    case "setScanGranularity":
      return { ...state, scanGranularity: action.value };
    case "setName":
      return { ...state, name: action.name };
    case "goto":
      return { ...state, step: action.step };
    case "next": {
      if (!canAdvance(state)) return state;
      const i = stepIndex(state.step);
      const next = STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)];
      return { ...state, step: next };
    }
    case "back": {
      const i = stepIndex(state.step);
      return { ...state, step: STEP_ORDER[Math.max(i - 1, 0)] };
    }
    case "reset":
      return INITIAL_WIZARD;
  }
}

/** Build the job-submit input from a completed wizard state. */
export function toJobInput(state: WizardState) {
  const resolved = resolveLength(state);
  const binSec = effectiveBinSeconds(state);

  const params: Record<string, unknown> = {
    // Number of motifs/discords/regimes to return. buildJobPayload() reads `k` back out.
    k: state.resultCount,
    // Source binning applied to the analysis read (summarize <agg> by bin(bin, binSeconds)).
    binSeconds: binSec,
    aggregation: state.binning.aggregation,
    gapFill: state.gapFill,
  };
  if (resolved.lengthMin != null) params.lengthMin = resolved.lengthMin;
  if (resolved.lengthMax != null) params.lengthMax = resolved.lengthMax;
  if (resolved.lengthStep != null) params.lengthStep = resolved.lengthStep;
  if (state.minSeparationSec > 0) {
    params.minlag = durationToSubLen(state.minSeparationSec, binSec);
  }

  // AB-join: series A is (signalId, window). Series B is either a second signal (two-signals
  // mode, sharing series A's window) or a second window of the same signal (two-windows mode).
  let compare: {
    compareSignalId?: string;
    compareWindowStart?: string;
    compareWindowEnd?: string;
  } = {};
  if (isCompareType(state.jobType)) {
    if (state.abMode === "two-signals") {
      compare = { compareSignalId: state.compareSignalId };
    } else if (state.abMode === "two-windows") {
      compare = {
        compareWindowStart: state.compareWindowStart,
        compareWindowEnd: state.compareWindowEnd,
      };
    }
  }

  // Multi-series: multidimensional (mSTAMP) passes the aligned set of sensors; consensus
  // (Ostinato) passes the fleet of signals plus an optional partial-consensus min count.
  let multi: { signalIds?: string[]; minCount?: number } = {};
  if (isMultiSeriesType(state.jobType)) {
    multi = { signalIds: state.signalIds };
    if (isConsensusType(state.jobType) && state.minCount != null) {
      multi.minCount = state.minCount;
    }
  }

  return {
    signalId: state.signalId!,
    type: resolved.type,
    windowStart: state.windowStart!,
    windowEnd: state.windowEnd!,
    subLen: resolved.subLen,
    name: state.name?.trim() || undefined,
    ...compare,
    ...multi,
    params,
  };
}
