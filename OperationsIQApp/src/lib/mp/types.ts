/**
 * Control-plane types mirrored from the Rayfin @entity models (rayfin/data/*.ts).
 * Kept as a hand-written slice so the SPA compiles independently of codegen.
 */

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type JobType =
  | "MOTIF_MOMP"
  | "DISCORD_DAMP"
  | "FULL_MP"
  | "PAN_MP"
  | "SEGMENTATION"
  | "CHAIN"
  | "RULE_DISCOVERY"
  | "CONSENSUS"
  | "MULTIDIM"
  | "MULTIDIM_MOTIF"
  | "MULTIDIM_DISCORD"
  | "MULTIDIM_SEGMENTATION"
  | "CONSENSUS_MOTIF"
  | "AB_MOTIF"
  | "AB_DISCORD";

export interface DataSource {
  id: string;
  name: string;
  kqlClusterUri: string;
  database: string;
  table: string;
  timeColumn: string;
  valueColumn: string;
  tagColumn?: string;
  defaultSampleRateHz: number;
}

export interface Signal {
  id: string;
  dataSourceId: string;
  tagName: string;
  unit?: string;
  description?: string;
}

export interface AnalysisJob {
  id: string;
  name?: string;
  signalId: string;
  type: JobType;
  windowStart: string;
  windowEnd: string;
  /** AB-join (two-series) comparison series B. When set, series A is (signalId, window)
   *  and series B is (compareSignalId ?? signalId, compareWindowStart/End ?? window). */
  compareSignalId?: string;
  compareWindowStart?: string;
  compareWindowEnd?: string;
  /** Multi-series (multidimensional mSTAMP / consensus Ostinato) participating signals.
   *  JSON array of signal ids. signalId stays the primary/first for back-compat. */
  signalIds?: string[];
  /** Multidimensional: how many of the d channels a motif/discord must jointly share
   *  (the "k" in k-of-d). When unset the backend uses all channels. */
  nDims?: number;
  /** Consensus: minimum number of the N series that must contain the shape (>= m of N).
   *  When unset the backend requires all N (strict consensus). */
  minCount?: number;
  subLen?: number;
  status: JobStatus;
  progressPct: number;
  bestSoFar?: string; // JSON
  sparkAppId?: string;
  /** The Fabric Livy session id running this job (for troubleshooting). */
  livySessionId?: string;
  /** The Livy statement id executing the analysis within the session. */
  livyStatementId?: string;
  /** Raw Livy state (starting, idle, busy, dead, …) for transparent status. */
  livyState?: string;
  /** Coarse stage, e.g. "session:starting" / "statement:running". */
  stage?: string;
  /** Deep link to the Spark UI / driver log for this session. */
  sparkUiUrl?: string;
  /** Tail of the driver log captured for troubleshooting (newline-joined). */
  driverLogTail?: string;
  resultKqlTable?: string;
  resultKey?: string;
  overviewKqlTable?: string;
  summary?: string; // JSON
  /** The run's submitted parameters (as packed by the wizard's toJobInput): number of
   *  results (`k`), source bin width (`binSeconds`), aggregation, missing-data handling
   *  (`gapFill`), minimum separation (`minlag`, in samples) and any Pan-MP scan bounds
   *  (`lengthMin`/`lengthMax`/`lengthStep`). Parsed back from the persisted `params` JSON. */
  params?: Record<string, unknown>;
  errorMessage?: string;
  submittedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  computeSeconds?: number;
}

export interface Label {
  id: string;
  signalId: string;
  jobId?: string;
  kind: "MOTIF" | "DISCORD";
  startIndex: number;
  length: number;
  text: string;
  category?: string;
  color?: string;
  confidence?: number;
  /** ISO timestamp the label/pattern was saved (for the Pattern library). */
  createdAt?: string;
  /**
   * Temporal resolution the pattern was discovered at — seconds represented by each
   * sample/index. Lets the Pattern library show real durations/timing without the run.
   */
  secondsPerSample?: number;
}

export interface LabelCategory {
  id: string;
  name: string;
  color: string;
  description?: string;
}

/** Input for creating a label (id/ownership assigned server-side). */
export interface LabelInput {
  signalId: string;
  jobId?: string;
  kind: "MOTIF" | "DISCORD";
  startIndex: number;
  length: number;
  text: string;
  category?: string;
  color?: string;
  confidence?: number;
  /** Temporal resolution (seconds per sample) at discovery time; stored for the library. */
  secondsPerSample?: number;
}

/** A parsed best-so-far / summary payload (shape produced by the Spark runner). */
export interface ResultSummary {
  motif?: { idxA: number; idxB: number; dist: number; subLen: number };
  discords?: Array<{ idx: number; nnDist: number; severity: number }>;
  quality?: number;
  /** AB-join summary fields (present when the job is an AB_MOTIF / AB_DISCORD run). */
  abMode?: boolean;
  target?: "a" | "b";
  topMotif?: { idxA: number; idxB: number; dist: number; nDims?: number; dims?: number[] };
  topDiscord?: { index: number; nnDist: number; nDims?: number; dims?: number[] };
  /** Multidimensional (mSTAMP) summary fields. */
  multiDim?: boolean;
  numChannels?: number;
  /** Consensus (Ostinato) summary fields. */
  consensus?: boolean;
  numSeries?: number;
  radius?: number;
  centralSeries?: number;
  members?: Array<{ seriesId: number; idx: number; dist: number; isCentral: boolean }>;
}
