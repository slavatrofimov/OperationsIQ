import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ErrorMessageBar } from '../ErrorMessageBar';
import {
  Badge,
  Button,
  Checkbox,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Switch,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { SearchRegular, TagRegular } from '@fluentui/react-icons';
import { queryRows } from '../../lib/eventhouse';
import { kqlString } from '../../lib/kql';
import { parseParams } from '../../lib/mp/livyClient';
import { rawSignalCsl } from '../../lib/mp/rawSignalQuery';
import type { TagInfo } from '../../lib/tags';
import type { AnalysisJob, Label, LabelCategory, LabelInput } from '../../lib/mp/types';
import { buildFindMoreSeed, type SimilarityQuerySeed } from '../../lib/appTypes';
import type { OverviewBucket } from './SignalLane';
import { labelMatchesTarget, type Span } from '../../lib/mp/labeling';
import { SignalPanels, type PanelLane, type PanelOverlay, type PanelBoundary } from './SignalPanels';
import { MatrixProfileLane } from './MatrixProfileLane';
import { MotifDetails, type MotifPair } from './MotifDetails';
import { DiscordFlags, type DiscordFlag } from './DiscordFlags';
import { RegimeRibbon, type RegimeBoundary } from './RegimeRibbon';
import { ChainView, type ChainLink } from './ChainView';
import { LabelLayer, type LabelTarget } from './LabelLayer';
import { LabelEditDialog } from './LabelEditDialog';
import type { LabelUpdate } from '../../lib/mp/analysisClient';
import { ConvergenceMeter } from './ConvergenceMeter';
import { JobDiagnosticsPanel } from './JobDiagnosticsPanel';
import { RunMethodologyPanel } from './RunMethodologyPanel';
import { methodologyFor } from '../../lib/mp/methodology';
import { motifStrength, discordStrength } from '../../lib/mp/interpret';
import { runAdvice } from '../../lib/mp/runAdvice';
import { describeJobStatus } from '../../lib/mp/livyStatus';
import { shortPatternId } from '../../lib/mp/patternId';
import { patternColor, patternOverlayColor } from '../../lib/mp/patternColors';
import { useTagLabeler } from '../../context/TagDisplayContext';
import { useTimezoneOffset } from '../../context/TimezoneContext';
import { toChartMs } from '../../lib/timezone';

const POLL_INTERVAL_MS = 5000;
/** After a job succeeds, keep re-querying KQL this many times to absorb ingestion lag. */
const FINALIZE_MAX_ATTEMPTS = 12;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  identity: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  identityMeta: { color: tokens.colorNeutralForeground3 },
  labelChips: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
  },
  row: { display: 'flex', gap: tokens.spacingHorizontalL },
  main: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  side: { width: '260px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  spinner: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  abList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  abRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    cursor: 'pointer',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
  },
  abRowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  laneHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  rowLead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  swatch: {
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  sectionTitle: { marginTop: tokens.spacingVerticalS },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    alignItems: 'center',
  },
  legendItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  findMore: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  findMoreText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
});

// ---- KQL row types -----------------------------------------------------------

interface MpResultRow {
  idx: number;
  mp: number;
  mpi: number;
}

interface MotifPairRow {
  rank: number;
  idxA: number;
  idxB: number;
  dist: number;
  subLen: number;
  seriesA?: number | null;
  seriesB?: number | null;
  /** Multidimensional motif: participating channel count + CSL of channel indices. */
  numDims?: number | null;
  dims?: string | null;
}

interface DiscordRow {
  rank: number;
  idx: number;
  nnDist: number;
  severity: number;
  seriesId?: number | null;
  /** Multidimensional discord: how many channels define the novelty. */
  numDims?: number | null;
}

/** motif_occurrences row: one stretch that matches a motif's shape. `seriesId` is 0/1 for
 *  AB-join (A/B) and null/absent for single-series & multidimensional (one shared clock). */
interface MotifOccurrenceRow {
  rank: number;
  occurrence: number;
  idx: number;
  dist: number | null;
  seriesId?: number | null;
  subLen: number;
}

/** md_dimensions row: per-channel participation for a multidimensional motif/discord. */
interface MdDimensionRow {
  rank: number;
  resultKind: string;
  seriesId: number;
  dist: number | null;
  included: boolean;
}

/** consensus_members row: one series' member of the fleet-wide consensus motif. */
interface ConsensusMemberRow {
  rank: number;
  seriesId: number;
  idx: number;
  dist: number | null;
  isCentral: boolean;
}

interface OverviewRow {
  bucket: number;
  tMin: number;
  tMax: number;
  tAvg: number;
  seriesId?: number | null;
}

interface ArcCurveRow {
  idx: number;
  cac: number | null;
}

interface SegmentRow {
  rank: number;
  boundaryIdx: number;
  cac: number | null;
}

interface ChainLinkRow {
  chainRank: number;
  linkOrder: number;
  idx: number;
  subLen: number;
}

/** Latest best-so-far snapshot streamed by the Spark job into the job_progress table. */
interface ProgressRow {
  pct: number;
  stage: string;
  bestDist: number | null;
  bestIdxA: number | null;
  bestIdxB: number | null;
  subLen: number | null;
}

interface TimeseriesRow {
  Value: number;
}

// ---- helpers -----------------------------------------------------------------

function parseQuality(job: AnalysisJob): number {
  if (job.summary) {
    try {
      const p = JSON.parse(job.summary) as { quality?: number };
      if (typeof p.quality === 'number') return p.quality;
    } catch { /* ignore */ }
  }
  return job.progressPct / 100;
}

/** Estimate seconds-per-sample from the analysis window and sample count. */
function estimateSecondsPerSample(job: AnalysisJob, nSamples: number): number | undefined {
  if (nSamples <= 1) return undefined;
  const start = new Date(job.windowStart).getTime();
  const end = new Date(job.windowEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return (end - start) / 1000 / nSamples;
}

// ---- component ---------------------------------------------------------------

export interface ResultsViewProps {
  job: AnalysisJob;
  tags: TagInfo[];
  labels: Label[];
  categories: LabelCategory[];
  onCreateLabels: (inputs: LabelInput[]) => void;
  onDeleteLabel: (id: string) => void;
  onUpdateLabel: (id: string, patch: LabelUpdate) => void;
  /** Called when the job has been re-polled and its status/progressPct has changed. */
  onJobUpdate?: (updated: AnalysisJob) => void;
  /** Stop the running job early, keeping the best-so-far result (design spec §7.2). */
  onStop?: (id: string) => void;
  /**
   * Launch a granularity-locked Similarity search prefilled from the selected
   * discovered pattern ("Find more like these" — Scenario 2). When omitted, the
   * trigger is hidden.
   */
  onFindMore?: (seed: SimilarityQuerySeed) => void;
}

/**
 * The main results visualization for a Matrix Profile analysis job
 * (design spec §7.3). Orchestrates:
 * - SignalLane (signal overview with motif/discord span highlights)
 * - MatrixProfileLane (MP profile chart)
 * - MotifDetails (all found motifs, per-motif stats, aligned overlay)
 * - DiscordFlags (for DISCORD jobs)
 * - LabelLayer (labels, driven by the selected motif instance)
 * - ExplainRail (context-aware explanation)
 * - ConvergenceMeter while running
 *
 * Polls for results every 5 s while active, and keeps re-querying briefly after a job
 * succeeds so results appear as soon as KQL ingestion catches up.
 */
export function ResultsView({
  job,
  tags,
  labels,
  categories,
  onCreateLabels,
  onDeleteLabel,
  onUpdateLabel,
  onJobUpdate,
  onStop,
  onFindMore,
}: ResultsViewProps) {
  const styles = useStyles();
  const tzOffset = useTimezoneOffset();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The label currently open in the click-to-edit dialog (null when closed).
  const [editingLabel, setEditingLabel] = useState<Label | null>(null);

  const [mpValues, setMpValues] = useState<number[]>([]);
  const [mpiValues, setMpiValues] = useState<number[]>([]);
  const [overview, setOverview] = useState<OverviewBucket[]>([]);
  const [overviewB, setOverviewB] = useState<OverviewBucket[]>([]);
  const [motifPairs, setMotifPairs] = useState<MotifPairRow[]>([]);
  const [motifOccurrences, setMotifOccurrences] = useState<MotifOccurrenceRow[]>([]);
  const [discords, setDiscords] = useState<DiscordRow[]>([]);
  const [arcCurve, setArcCurve] = useState<number[]>([]);
  const [regimeBounds, setRegimeBounds] = useState<RegimeBoundary[]>([]);
  const [selectedBoundaryIdx, setSelectedBoundaryIdx] = useState<number | null>(null);
  const [chainLinks, setChainLinks] = useState<ChainLink[]>([]);
  const [rawSignal, setRawSignal] = useState<number[]>([]);
  const [rawSignalB, setRawSignalB] = useState<number[]>([]);
  const [progress, setProgress] = useState<ProgressRow | null>(null);

  // Multi-series (multidimensional / consensus) lanes: one overview + raw signal per series.
  const [multiLanes, setMultiLanes] = useState<
    Array<{ seriesId: number; buckets: OverviewBucket[]; raw: number[] }>
  >([]);
  const [mdDimensions, setMdDimensions] = useState<MdDimensionRow[]>([]);
  const [consensusMembers, setConsensusMembers] = useState<ConsensusMemberRow[]>([]);
  // Focus/expand toggle for multidimensional results with many channels (>4 lanes).
  const [showAllLanes, setShowAllLanes] = useState(false);

  // Which found motif is expanded/inspected, and the span pre-filled for labeling.
  const [selectedMotifRank, setSelectedMotifRank] = useState(1);
  // "Show all occurrences" expands the selected single-signal motif from its matched pair
  // to every similar stretch (via label propagation) on the chart + shape inspector.
  const [showAllOccurrences, setShowAllOccurrences] = useState(false);
  // Which anomaly (by severity rank, D1 = most severe) is selected for detail/emphasis.
  const [selectedDiscordRank, setSelectedDiscordRank] = useState(1);
  // Which evolving chain (1-based, ordered longest→shortest) is focused for detail + chart.
  const [selectedChainIndex, setSelectedChainIndex] = useState(1);
  // Which discovered patterns are drawn on the synchronized chart (color-coded overlays).
  const [visiblePatternIds, setVisiblePatternIds] = useState<Set<string>>(new Set());
  // Stretches queued for labeling. A single pattern can span several signals (AB / multi),
  // so this is a list of per-signal targets the label form writes in one action.
  const [labelTargets, setLabelTargets] = useState<LabelTarget[]>([]);

  const tag = tags.find((t) => t.tagId === job.signalId);
  const isMotif = job.type === 'MOTIF_MOMP' || job.type === 'FULL_MP' || job.type === 'PAN_MP';
  const isDiscord = job.type === 'DISCORD_DAMP';
  const isSegmentation = job.type === 'SEGMENTATION';
  const isChain = job.type === 'CHAIN';
  const isAbMotif = job.type === 'AB_MOTIF';
  const isAbDiscord = job.type === 'AB_DISCORD';
  const isAb = isAbMotif || isAbDiscord;
  const isMultiDimMotif = job.type === 'MULTIDIM_MOTIF';
  const isMultiDimDiscord = job.type === 'MULTIDIM_DISCORD';
  const isMultiDimSeg = job.type === 'MULTIDIM_SEGMENTATION';
  const isMultiDim = isMultiDimMotif || isMultiDimDiscord || isMultiDimSeg;
  const isConsensus = job.type === 'CONSENSUS_MOTIF';
  const isMulti = isMultiDim || isConsensus;
  const needsRawSignal = isMotif || isChain || isDiscord;

  // Multi-series identity: seriesId 0..N-1 maps to signalIds[seriesId] (first = primary).
  const seriesTagIds = job.signalIds && job.signalIds.length > 0 ? job.signalIds : [job.signalId];
  const seriesKey = seriesTagIds.join(',');

  // AB-join series B identity: a second signal (compareSignalId) and/or a second window.
  const compareTagId = job.compareSignalId ?? job.signalId;
  const compareTag = tags.find((t) => t.tagId === compareTagId);
  const compareWindowStart = job.compareWindowStart ?? job.windowStart;
  const compareWindowEnd = job.compareWindowEnd ?? job.windowEnd;

  const jobTable = job.resultKqlTable ?? 'mp_result';
  const overviewTable = job.overviewKqlTable ?? 'overview';

  // The grid on which the backend actually analyzed this run (from the wizard's binning
  // panel). When set, raw signals are loaded on this SAME grid so pattern sample indices
  // (idx/subLen, emitted in bin units) map back to real wall-clock time and to the shape
  // slices. See rawSignalCsl for the full rationale.
  const jobParams = useMemo(
    () => job.params ?? parseParams(job.summary ?? undefined),
    [job.params, job.summary],
  );
  const analysisBinSeconds =
    typeof jobParams.binSeconds === 'number'
      ? jobParams.binSeconds
      : Number.isFinite(Number(jobParams.binSeconds))
        ? Number(jobParams.binSeconds)
        : undefined;
  const analysisAgg = typeof jobParams.aggregation === 'string' ? jobParams.aggregation : undefined;
  const analysisGapFill = typeof jobParams.gapFill === 'string' ? jobParams.gapFill : undefined;

  // Refs so the poll/finalize loop can read the latest job + callback without
  // re-subscribing on every parent re-render (the parent passes fresh closures).
  const jobRef = useRef(job);
  jobRef.current = job;
  const onJobUpdateRef = useRef(onJobUpdate);
  onJobUpdateRef.current = onJobUpdate;

  /** Load all result tables for the job. Returns true once headline results exist. */
  const loadResults = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      const jobId = kqlString(job.id);

      // AB-join (two-series) has a distinct result shape: overview + profile are tagged by
      // seriesId (0 = A, 1 = B), motif pairs span both series, and novelties live in one
      // series. Load and render it on its own two-lane path.
      if (isAb) {
        const ovA = await queryRows<OverviewRow>(
          `${overviewTable} | where jobId == ${jobId} and level == 0 and seriesId == 0 | order by bucket asc | take 2000`,
        );
        const ovB = await queryRows<OverviewRow>(
          `${overviewTable} | where jobId == ${jobId} and level == 0 and seriesId == 1 | order by bucket asc | take 2000`,
        );
        setOverview(ovA.map((r) => ({ bucket: r.bucket, tMin: r.tMin, tMax: r.tMax, tAvg: r.tAvg })));
        setOverviewB(ovB.map((r) => ({ bucket: r.bucket, tMin: r.tMin, tMax: r.tMax, tAvg: r.tAvg })));

        let abMotifRows: MotifPairRow[] = [];
        let abDiscordRows: DiscordRow[] = [];
        if (isAbMotif) {
          abMotifRows = await queryRows<MotifPairRow>(
            `motif_pairs | where jobId == ${jobId} | order by rank asc | take 20`,
          );
          setMotifPairs(abMotifRows);
          setMotifOccurrences(
            await queryRows<MotifOccurrenceRow>(
              `motif_occurrences | where jobId == ${jobId} | order by rank asc, occurrence asc | take 5000`,
            ),
          );
        } else {
          abDiscordRows = await queryRows<DiscordRow>(
            `discords | where jobId == ${jobId} | order by rank asc | take 10`,
          );
          setDiscords(abDiscordRows);
        }

        // Fetch both raw series so the span→bucket mapping is exact and the lanes align.
        if (tag) {
          const tsA = rawSignalCsl({
            signalId: tag.tagId,
            startIso: job.windowStart,
            endIso: job.windowEnd,
            binSeconds: analysisBinSeconds,
            aggregation: analysisAgg,
            gapFill: analysisGapFill,
          });
          const rowsA = await queryRows<TimeseriesRow>(tsA);
          setRawSignal(rowsA.map((r) => r.Value));
        }
        if (compareTag) {
          const tsB = rawSignalCsl({
            signalId: compareTag.tagId,
            startIso: compareWindowStart,
            endIso: compareWindowEnd,
            binSeconds: analysisBinSeconds,
            aggregation: analysisAgg,
            gapFill: analysisGapFill,
          });
          const rowsB = await queryRows<TimeseriesRow>(tsB);
          setRawSignalB(rowsB.map((r) => r.Value));
        }

        if (isAbMotif) return abMotifRows.length > 0 || ovA.length > 0;
        return abDiscordRows.length > 0 || ovB.length > 0;
      }

      // Multi-series (multidimensional mSTAMP / consensus Ostinato): overview is tagged by
      // seriesId (0..N-1, mapping to seriesTagIds), and the result carries per-series detail
      // (md_dimensions for multidim participation, consensus_members for the fleet motif).
      // Render one stacked lane per series.
      if (isMulti) {
        const lanes: Array<{ seriesId: number; buckets: OverviewBucket[]; raw: number[] }> = [];
        for (let s = 0; s < seriesTagIds.length; s++) {
          const ov = await queryRows<OverviewRow>(
            `${overviewTable} | where jobId == ${jobId} and level == 0 and seriesId == ${s} | order by bucket asc | take 2000`,
          );
          let raw: number[] = [];
          const laneTag = tags.find((t) => t.tagId === seriesTagIds[s]);
          if (laneTag) {
            const ts = rawSignalCsl({
              signalId: laneTag.tagId,
              startIso: job.windowStart,
              endIso: job.windowEnd,
              binSeconds: analysisBinSeconds,
              aggregation: analysisAgg,
              gapFill: analysisGapFill,
            });
            const rows = await queryRows<TimeseriesRow>(ts);
            raw = rows.map((r) => r.Value);
          }
          lanes.push({
            seriesId: s,
            buckets: ov.map((r) => ({ bucket: r.bucket, tMin: r.tMin, tMax: r.tMax, tAvg: r.tAvg })),
            raw,
          });
        }
        setMultiLanes(lanes);
        const anyOverview = lanes.some((l) => l.buckets.length > 0);

        if (isMultiDimMotif) {
          const rows = await queryRows<MotifPairRow>(
            `motif_pairs | where jobId == ${jobId} | order by rank asc | take 20`,
          );
          setMotifPairs(rows);
          setMotifOccurrences(
            await queryRows<MotifOccurrenceRow>(
              `motif_occurrences | where jobId == ${jobId} | order by rank asc, occurrence asc | take 5000`,
            ),
          );
          const dims = await queryRows<MdDimensionRow>(
            `md_dimensions | where jobId == ${jobId} and resultKind == 'MOTIF' | order by rank asc, seriesId asc | take 500`,
          );
          setMdDimensions(dims);
          return rows.length > 0 || anyOverview;
        }
        if (isMultiDimDiscord) {
          const rows = await queryRows<DiscordRow>(
            `discords | where jobId == ${jobId} | order by rank asc | take 10`,
          );
          setDiscords(rows);
          const dims = await queryRows<MdDimensionRow>(
            `md_dimensions | where jobId == ${jobId} and resultKind == 'DISCORD' | order by rank asc, seriesId asc | take 500`,
          );
          setMdDimensions(dims);
          return rows.length > 0 || anyOverview;
        }
        if (isMultiDimSeg) {
          const arcRows = await queryRows<ArcCurveRow>(
            `arc_curve | where jobId == ${jobId} | order by idx asc | take 200000`,
          );
          setArcCurve(arcRows.map((r) => (r.cac == null ? 1 : r.cac)));
          const segRows = await queryRows<SegmentRow>(
            `segments | where jobId == ${jobId} | order by rank asc | take 50`,
          );
          setRegimeBounds(
            segRows.map((r) => ({ rank: r.rank, boundaryIdx: r.boundaryIdx, cac: r.cac })),
          );
          return segRows.length > 0 || arcRows.length > 0 || anyOverview;
        }
        // Consensus motif: one member per series (the shape's location in each).
        const members = await queryRows<ConsensusMemberRow>(
          `consensus_members | where jobId == ${jobId} | order by rank asc, seriesId asc | take 500`,
        );
        setConsensusMembers(members);
        return members.length > 0 || anyOverview;
      }

      const mpRows = await queryRows<MpResultRow>(
        `${jobTable} | where jobId == ${jobId} | order by idx asc | take 200000`,
      );
      setMpValues(mpRows.map((r) => r.mp));
      setMpiValues(mpRows.map((r) => r.mpi));

      const overviewRows = await queryRows<OverviewRow>(
        `${overviewTable} | where jobId == ${jobId} and level == 0 | order by bucket asc | take 2000`,
      );
      setOverview(
        overviewRows.map((r) => ({ bucket: r.bucket, tMin: r.tMin, tMax: r.tMax, tAvg: r.tAvg })),
      );

      let motifRows: MotifPairRow[] = [];
      if (isMotif) {
        motifRows = await queryRows<MotifPairRow>(
          `motif_pairs | where jobId == ${jobId} | order by rank asc | take 20`,
        );
        setMotifPairs(motifRows);
        setMotifOccurrences(
          await queryRows<MotifOccurrenceRow>(
            `motif_occurrences | where jobId == ${jobId} | order by rank asc, occurrence asc | take 5000`,
          ),
        );
      }

      let discordRows: DiscordRow[] = [];
      if (isDiscord) {
        discordRows = await queryRows<DiscordRow>(
          `discords | where jobId == ${jobId} | order by rank asc | take 10`,
        );
        setDiscords(discordRows);
      }

      let arcRows: ArcCurveRow[] = [];
      let segRows: SegmentRow[] = [];
      if (isSegmentation) {
        arcRows = await queryRows<ArcCurveRow>(
          `arc_curve | where jobId == ${jobId} | order by idx asc | take 200000`,
        );
        setArcCurve(arcRows.map((r) => (r.cac == null ? 1 : r.cac)));
        segRows = await queryRows<SegmentRow>(
          `segments | where jobId == ${jobId} | order by rank asc | take 50`,
        );
        setRegimeBounds(
          segRows.map((r) => ({ rank: r.rank, boundaryIdx: r.boundaryIdx, cac: r.cac })),
        );
      }

      let chainRows: ChainLinkRow[] = [];
      if (isChain) {
        chainRows = await queryRows<ChainLinkRow>(
          `chain_links | where jobId == ${jobId} | order by chainRank asc, linkOrder asc | take 5000`,
        );
        setChainLinks(
          chainRows.map((r) => ({
            chainRank: r.chainRank,
            linkOrder: r.linkOrder,
            idx: r.idx,
            subLen: r.subLen,
          })),
        );
      }

      if (tag && needsRawSignal) {
        const tsCsl = rawSignalCsl({
          signalId: tag.tagId,
          startIso: job.windowStart,
          endIso: job.windowEnd,
          binSeconds: analysisBinSeconds,
          aggregation: analysisAgg,
          gapFill: analysisGapFill,
        });
        const tsRows = await queryRows<TimeseriesRow>(tsCsl);
        setRawSignal(tsRows.map((r) => r.Value));
      }

      // "Headline results" = the primary artifact for this job type is present.
      if (isDiscord) return discordRows.length > 0;
      if (isSegmentation) return segRows.length > 0 || arcRows.length > 0 || overviewRows.length > 0;
      if (isChain) return chainRows.length > 0 || overviewRows.length > 0;
      return motifRows.length > 0 || overviewRows.length > 0;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, [job.id, job.windowStart, job.windowEnd, tag, isMotif, isDiscord, isSegmentation, isChain, isAb, isAbMotif, isMulti, isMultiDimMotif, isMultiDimDiscord, isMultiDimSeg, isConsensus, seriesKey, tags, compareTag, compareWindowStart, compareWindowEnd, needsRawSignal, jobTable, overviewTable, analysisBinSeconds, analysisAgg, analysisGapFill]);

  // Clear any highlighted mode-change when switching to a different run.
  useEffect(() => {
    setSelectedBoundaryIdx(null);
  }, [job.id]);

  /** Load the latest best-so-far progress snapshot streamed by the Spark job. */
  const loadProgress = useCallback(async (): Promise<void> => {
    try {
      const rows = await queryRows<ProgressRow>(
        `job_progress | where jobId == ${kqlString(job.id)} | order by updatedAt desc | take 1`,
      );
      if (rows.length > 0) setProgress(rows[0]);
    } catch {
      /* progress is best-effort; a missing table or transient read must not surface an error */
    }
  }, [job.id]);
  const loadProgressRef = useRef(loadProgress);
  loadProgressRef.current = loadProgress;

  // Reset all result state whenever the selected job changes so stale charts
  // cannot be mistaken for the new run.
  useEffect(() => {
    setMpValues([]);
    setMpiValues([]);
    setOverview([]);
    setOverviewB([]);
    setMotifPairs([]);
    setMotifOccurrences([]);
    setDiscords([]);
    setArcCurve([]);
    setRegimeBounds([]);
    setChainLinks([]);
    setRawSignal([]);
    setRawSignalB([]);
    setMultiLanes([]);
    setMdDimensions([]);
    setConsensusMembers([]);
    setShowAllLanes(false);
    setProgress(null);
    setSelectedMotifRank(1);
    setSelectedDiscordRank(1);
    setSelectedChainIndex(1);
    setLabelTargets([]);
    setError(null);
    setLoading(true);
  }, [job.id]);

  // Load + poll. Re-runs when the job id or status changes so the transition into
  // SUCCEEDED immediately checks for newly queryable results. Uses refs for the
  // latest job/callback inside timers.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    void loadResults();
    // Pull the latest best-so-far immediately too, so a running job (or one that was
    // stopped early / cancelled) shows its partial motif without waiting a poll cycle.
    void loadProgress();

    const active = job.status === 'QUEUED' || job.status === 'RUNNING';
    if (active) {
      timer = setInterval(() => {
        if (jobRef.current.status === 'RUNNING') {
          void loadResults();
          void loadProgressRef.current();
        }
        onJobUpdateRef.current?.({ ...jobRef.current });
      }, POLL_INTERVAL_MS);
    } else if (job.status === 'SUCCEEDED') {
      // Keep retrying until results are queryable (KQL streaming ingestion can lag the
      // statement completing by tens of seconds), then stop.
      let attempts = 0;
      timer = setInterval(async () => {
        attempts += 1;
        const has = await loadResults();
        if (cancelled) return;
        if (has || attempts >= FINALIZE_MAX_ATTEMPTS) {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      }, POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [job.id, job.status, loadResults, loadProgress]);

  // ---- Build chart data -------------------------------------------------------

  // Final motif rows once ingested; otherwise a synthesized "partial" motif from the
  // latest best-so-far snapshot so a running / stopped-early job still shows its result
  // (design spec §6.6, §7.2).
  const partialMotif: MotifPair[] =
    progress && progress.bestIdxA != null && progress.bestIdxB != null
      ? [
          {
            rank: 1,
            idxA: progress.bestIdxA,
            idxB: progress.bestIdxB,
            dist: progress.bestDist ?? 0,
            subLen: progress.subLen ?? job.subLen ?? 0,
          },
        ]
      : [];
  const displayMotifs = motifPairs.length > 0 ? motifPairs : partialMotif;
  const isPartial = motifPairs.length === 0 && partialMotif.length > 0;

  const selectedMotif =
    displayMotifs.find((m) => m.rank === selectedMotifRank) ?? displayMotifs[0];

  const discordFlags: DiscordFlag[] = discords.map((d) => ({ idx: d.idx, severity: d.severity }));

  // Evolving chains: group links by chainRank, ordered longest→shortest (more links = a
  // stronger drift signal), and expose each as its own selectable, color-coded pattern.
  const chainGroups = useMemo(() => {
    const byRank = new Map<number, ChainLink[]>();
    for (const l of chainLinks) {
      const arr = byRank.get(l.chainRank) ?? [];
      arr.push(l);
      byRank.set(l.chainRank, arr);
    }
    return [...byRank.entries()]
      .map(([rank, links]) => ({ rank, links: [...links].sort((a, b) => a.linkOrder - b.linkOrder) }))
      .sort((a, b) => b.links.length - a.links.length || a.rank - b.rank)
      .map((g, i) => ({ ...g, index: i + 1 }));
  }, [chainLinks]);

  // ---- AB-join (two-series) derived data --------------------------------------
  // For AB motif, the selected pair links a span in A (idxA) to a span in B (idxB).
  const selectedAbMotif = isAbMotif
    ? motifPairs.find((m) => m.rank === selectedMotifRank) ?? motifPairs[0]
    : undefined;
  const abSubLen = job.subLen ?? (motifPairs[0]?.subLen ?? 0);

  // ---- Multi-series (multidimensional / consensus) derived data ---------------
  const multiSubLen = job.subLen ?? motifPairs[0]?.subLen ?? 0;

  // Multidimensional motif: the selected pair + which channels participate (from the CSL on
  // the motif row, falling back to the md_dimensions rows for that rank).
  const selectedMdMotif = isMultiDimMotif
    ? motifPairs.find((m) => m.rank === selectedMotifRank) ?? motifPairs[0]
    : undefined;
  const mdMotifDims = new Set<number>(
    selectedMdMotif?.dims
      ? selectedMdMotif.dims
          .split(',')
          .map((x) => parseInt(x, 10))
          .filter((n) => !Number.isNaN(n))
      : mdDimensions
          .filter((d) => d.resultKind === 'MOTIF' && d.rank === (selectedMdMotif?.rank ?? 1))
          .map((d) => d.seriesId),
  );
  // Multidimensional discord: the top novelty + the channels that define it.
  const topMdDiscord = isMultiDimDiscord ? discords[0] : undefined;
  const mdDiscordDims = new Set<number>(
    mdDimensions
      .filter((d) => d.resultKind === 'DISCORD' && d.rank === (topMdDiscord?.rank ?? 1))
      .map((d) => d.seriesId),
  );

  /** Channels participating in a multidim result of the given rank (drives dimming + overlays). */
  const dimsForRank = (kind: 'MOTIF' | 'DISCORD', rank: number, csl?: string | null): Set<number> => {
    const set = new Set<number>();
    if (csl) {
      csl
        .split(',')
        .map((x) => parseInt(x, 10))
        .filter((n) => !Number.isNaN(n))
        .forEach((n) => set.add(n));
      if (set.size > 0) return set;
    }
    mdDimensions
      .filter((d) => d.resultKind === kind && d.rank === rank)
      .forEach((d) => set.add(d.seriesId));
    return set;
  };

  /** True when a lane participates in the current multidim result (drives dimming). */
  const laneParticipates = (seriesId: number): boolean => {
    if (isMultiDimMotif) return mdMotifDims.has(seriesId);
    if (isMultiDimDiscord) return mdDiscordDims.has(seriesId);
    return true; // consensus: every series is a member
  };

  // >4 lanes legibility: for multidimensional results, focus on the participating channels
  // by default and let the user expand to all channels.
  const manyLanes = multiLanes.length > 4;
  const focusMultiDim = isMultiDim && manyLanes && !showAllLanes;
  const visibleLanes = focusMultiDim
    ? multiLanes.filter((l) => laneParticipates(l.seriesId))
    : multiLanes;

  // Prefer the real streamed convergence (job_progress) over the summary/progressPct
  // proxy — the latter is a stand-in for input params and is effectively always 0.
  const quality = progress ? Math.max(0, Math.min(1, progress.pct / 100)) : parseQuality(job);

  // Seconds represented by one sample/index. Pattern indices (idx/subLen, motif idxA/idxB,
  // occurrences) are emitted by the backend on the analysis grid — i.e. one step every
  // `binSeconds`, anchored at the window start. Prefer that authoritative grid so an index
  // maps to wall-clock time on the SAME clock the backend used (and thus the same clock as
  // the backend `overview` line). Deriving it as windowDuration/loadedRows instead is only
  // correct when the frontend raw load returns exactly the compute grid; a signal with gaps
  // or a different data density (very common for AB-join series B) loads a different row
  // count, which would drift — or, for large indices, overflow off-chart — the overlays.
  const secondsPerSample =
    analysisBinSeconds && analysisBinSeconds > 0
      ? analysisBinSeconds
      : estimateSecondsPerSample(
          job,
          rawSignal.length ||
            mpValues.length ||
            multiLanes.find((l) => l.raw.length > 1)?.raw.length ||
            overview.length ||
            overviewB.length ||
            multiLanes.find((l) => l.buckets.length > 1)?.buckets.length ||
            0,
        );

  // Absolute time mapping so signal lanes can show real timestamps on the x-axis.
  // `job.windowStart/End` are REAL-UTC client instants (the wizard/picker window),
  // whereas the raw-signal grid comes back from KQL already shifted +offset into
  // wall-clock/chart space. Shift the window anchors the same way (toChartMs) so
  // the reconstructed lane times line up with the plotted samples and render in
  // the preferred zone (see lib/timezone.ts).
  const windowStartMs = Number.isNaN(Date.parse(job.windowStart))
    ? undefined
    : toChartMs(Date.parse(job.windowStart), tzOffset);
  const windowEndMs = Number.isNaN(Date.parse(job.windowEnd))
    ? undefined
    : toChartMs(Date.parse(job.windowEnd), tzOffset);
  // Overview buckets span the whole window uniformly, so a bucket's wall-clock width is the
  // window duration divided by the bucket count — computed EXACTLY (no ceil), otherwise the
  // rounding error accumulates left→right and, on a long window, drifts the plotted line by
  // up to ~half a cycle relative to the pattern overlays (which are placed at exact sample
  // times). Anchoring both the line and the overlays to [windowStart, windowEnd] keeps the
  // highlighted band sitting exactly over the shape it marks.
  const msPerBucket =
    overview.length > 0 &&
    windowStartMs !== undefined &&
    windowEndMs !== undefined &&
    windowEndMs > windowStartMs
      ? (windowEndMs - windowStartMs) / overview.length
      : undefined;

  // Comparison (B) window time mapping for AB-join lanes.
  const compareEnd = job.compareWindowEnd ?? job.windowEnd;
  const windowStartMsB = Number.isNaN(Date.parse(compareWindowStart))
    ? undefined
    : toChartMs(Date.parse(compareWindowStart), tzOffset);
  const compareEndMs = Number.isNaN(Date.parse(compareEnd))
    ? undefined
    : toChartMs(Date.parse(compareEnd), tzOffset);
  // Series B shares the same analysis grid as A (both loaded/computed at `binSeconds`), so
  // prefer that authoritative step; fall back to the compare-window/row-count estimate only
  // when the grid is unknown. This keeps B's pattern overlays on the same clock as B's
  // backend `overview` line (see the secondsPerSample note above for why row-count division
  // drifts for a second series with a different data density).
  const secondsPerSampleB =
    analysisBinSeconds && analysisBinSeconds > 0
      ? analysisBinSeconds
      : rawSignalB.length > 1 &&
          !Number.isNaN(Date.parse(compareWindowStart)) &&
          !Number.isNaN(Date.parse(compareEnd)) &&
          Date.parse(compareEnd) > Date.parse(compareWindowStart)
        ? (Date.parse(compareEnd) - Date.parse(compareWindowStart)) / 1000 / rawSignalB.length
        : secondsPerSample;
  const msPerBucketB =
    overviewB.length > 0 &&
    windowStartMsB !== undefined &&
    compareEndMs !== undefined &&
    compareEndMs > windowStartMsB
      ? (compareEndMs - windowStartMsB) / overviewB.length
      : undefined;

  const explainTitle =
    job.status === 'RUNNING'
      ? 'Analysis in progress'
      : isMultiDimMotif
        ? 'Multi-sensor events'
        : isMultiDimDiscord
          ? 'Multi-sensor anomalies'
          : isMultiDimSeg
            ? 'Multi-sensor mode changes'
            : isConsensus
              ? 'A shape common across the fleet'
              : isAbMotif
                ? 'Comparing two series'
                : isAbDiscord
                  ? 'What changed vs the baseline?'
                  : isMotif
                    ? 'What are repeating patterns?'
                    : isDiscord
                      ? 'What are anomalies?'
                      : isSegmentation
                        ? 'What are mode changes?'
                        : 'What is slow degradation?';

  const explainText =
    isMultiDimMotif
      ? 'We lined the sensors up on a common clock and found the moment their shapes repeat together. The event is highlighted on the sensors that took part; the others are dimmed.'
      : isMultiDimDiscord
        ? 'We read the sensors together and flagged the stretch most unlike the rest across them. The novelty is highlighted on the sensors that define it; the others are dimmed.'
        : isMultiDimSeg
          ? 'We tracked how the sensors\u2019 combined shape repeats and flagged where their joint behavior changes \u2014 splitting the window into operating modes that reflect the whole asset.'
          : isConsensus
            ? 'We found the single shape that shows up across the fleet and highlighted where it occurs in each signal. The central occurrence (the reference the others match) is marked in gold.'
            : isAbMotif
              ? 'We compared the two series and highlighted the stretches that look most alike across them — confirming one behaves like the other, or that this period matches the reference.'
              : isAbDiscord
                ? 'We flagged the stretches of the comparison series that have no close match anywhere in the baseline — the genuinely new behavior that emerged relative to the reference.'
                : isMotif
                  ? 'We found the stretches of signal most alike. Repeated shapes usually mean a normal, healthy cycle.'
                  : isDiscord
                    ? "We found the stretch least like anything else. Stand-out events are often the earliest sign of a fault."
                    : isSegmentation
                      ? 'We track how the signal\u2019s shape repeats and flag where its character changes \u2014 splitting the window into operating modes like start-up, steady running, and shutdown. Dips in the change-score line mark the switch-overs.'
                      : 'We link a recurring pattern to each of its repeats to form a chain, then watch how its shape drifts over time. A steady drift is the fingerprint of gradual wear \u2014 bearing degradation, fouling, or sensor drift.';

  const labeler = useTagLabeler();
  const labelForSignal = useCallback(
    (signalId: string) => labeler(signalId, tags.find((t) => t.tagId === signalId)?.tagName),
    [labeler, tags],
  );
  const statusView = describeJobStatus(job);
  const showDiagnostics =
    job.status === 'QUEUED' || job.status === 'RUNNING' || job.status === 'FAILED';

  const isSucceeded = job.status === 'SUCCEEDED';
  const isCancelled = job.status === 'CANCELLED';
  const noResultsYet =
    isSucceeded && !loading && overview.length === 0 && overviewB.length === 0 && mpValues.length === 0 &&
    motifPairs.length === 0 && discords.length === 0 &&
    arcCurve.length === 0 && regimeBounds.length === 0 && chainLinks.length === 0 &&
    consensusMembers.length === 0;

  // Adaptive, per-run verdict + next-step (design: dynamic per-run interpretation).
  const adviceFamily = methodologyFor(job.type).family;
  const adviceResultCount =
    adviceFamily === 'discord'
      ? discords.length
      : adviceFamily === 'segmentation'
        ? regimeBounds.length
        : adviceFamily === 'chain'
          ? chainGroups.length
          : adviceFamily === 'compare'
            ? motifPairs.length + discords.length
            : adviceFamily === 'consensus'
              ? (consensusMembers.length > 0 ? 1 : 0)
              : motifPairs.length;
  const topMotifStrength =
    motifPairs.length > 0
      ? motifStrength({
          distance: motifPairs[0].dist,
          subLen: motifPairs[0].subLen,
          secondDistance: motifPairs[1]?.dist,
        })
      : undefined;
  const topDiscordStrength =
    discords.length > 0 ? discordStrength(discords[0].severity) : undefined;
  const advice =
    (isSucceeded || isCancelled) && !loading && !noResultsYet
      ? runAdvice({
          family: adviceFamily,
          resultCount: adviceResultCount,
          topMotifStrength,
          topDiscordStrength,
          running: job.status === 'RUNNING',
        })
      : undefined;

  // ---- Unified, color-coded, toggleable pattern overlay model -----------------
  // Every discovered pattern becomes a color-coded set of time spans on the panels it
  // occurs in. The list controls which are drawn (visiblePatternIds) and which is focused
  // (selectedPatternId); the synchronized chart renders them as shaded bands.
  const spsMs = secondsPerSample && secondsPerSample > 0 ? secondsPerSample * 1000 : undefined;
  const spsMsB = secondsPerSampleB && secondsPerSampleB > 0 ? secondsPerSampleB * 1000 : spsMs;

  // Anomalies are identified in the single-signal case by severity rank (D1 = most severe),
  // matching DiscordFlags; AB / multidim use the KQL rank shown in their ranked lists.
  const discordBySeverity = [...discords].sort((a, b) => b.severity - a.severity);

  // Exact occurrences of each motif, grouped by rank, as computed by the backend
  // (motif_occurrences table). This is the authoritative set — every stretch that matches a
  // motif's shape, across single-signal, AB-join (seriesId 0/1), and multidimensional runs.
  const occurrencesByRank = useMemo(() => {
    const map = new Map<number, MotifOccurrenceRow[]>();
    for (const o of motifOccurrences) {
      const list = map.get(o.rank);
      if (list) list.push(o);
      else map.set(o.rank, [o]);
    }
    return map;
  }, [motifOccurrences]);

  // How many occurrences the selected motif has (backend). Drives whether the "Show all
  // occurrences" toggle is offered (only meaningful when there are more than the matched pair).
  const selectedOccurrenceCount =
    occurrencesByRank.get(selectedMotifRank)?.length ?? 0;
  const canShowAllOccurrences = isMotif && selectedOccurrenceCount > 2;

  // All occurrences of the selected motif for the single-signal shape inspector, as label
  // Spans, from the exact backend motif_occurrences table (one clock; single-signal only).
  const selectedMotifOccurrences = useMemo<Span[] | undefined>(() => {
    if (!isMotif || isMulti || isAb || !selectedMotif) return undefined;
    const backend = occurrencesByRank.get(selectedMotif.rank);
    if (!backend || backend.length === 0) return undefined;
    return backend.map((o) => ({ startIndex: o.idx, length: o.subLen }));
  }, [isMotif, isMulti, isAb, selectedMotif, occurrencesByRank]);

  interface PatternSpanDef {
    id: string;
    spans: { laneId: string; startIdx: number; length: number }[];
  }
  const patternDefs: PatternSpanDef[] = [];
  if (isMotif && !isMulti && !isAb) {
    for (const m of displayMotifs) {
      const isSelected = m.rank === (selectedMotif?.rank ?? selectedMotifRank);
      const expand =
        showAllOccurrences &&
        isSelected &&
        selectedMotifOccurrences &&
        selectedMotifOccurrences.length > 0;
      const spans = expand
        ? selectedMotifOccurrences!.map((s) => ({
            laneId: 'single',
            startIdx: s.startIndex,
            length: s.length,
          }))
        : [
            { laneId: 'single', startIdx: m.idxA, length: m.subLen },
            { laneId: 'single', startIdx: m.idxB, length: m.subLen },
          ];
      patternDefs.push({ id: shortPatternId('motif', m.rank), spans });
    }
  } else if (isDiscord && !isMulti && !isAb) {
    discordBySeverity.forEach((d, i) => {
      patternDefs.push({
        id: shortPatternId('discord', i + 1),
        spans: [{ laneId: 'single', startIdx: d.idx, length: job.subLen ?? multiSubLen }],
      });
    });
  } else if (isChain) {
    for (const g of chainGroups) {
      patternDefs.push({
        id: shortPatternId('chain', g.index),
        spans: g.links.map((l) => ({ laneId: 'single', startIdx: l.idx, length: l.subLen })),
      });
    }
  } else if (isAbMotif) {
    for (const m of motifPairs) {
      const isSelected = m.rank === (selectedAbMotif?.rank ?? selectedMotifRank);
      const occ = occurrencesByRank.get(m.rank);
      const expand = showAllOccurrences && isSelected && occ && occ.length > 2;
      const spans = expand
        ? occ!.map((o) => ({
            laneId: o.seriesId === 1 ? 'B' : 'A',
            startIdx: o.idx,
            length: o.subLen,
          }))
        : [
            { laneId: 'A', startIdx: m.idxA, length: m.subLen },
            { laneId: 'B', startIdx: m.idxB, length: m.subLen },
          ];
      patternDefs.push({ id: shortPatternId('motif', m.rank), spans });
    }
  } else if (isAbDiscord) {
    for (const d of discords) {
      patternDefs.push({
        id: shortPatternId('discord', d.rank),
        spans: [{ laneId: 'B', startIdx: d.idx, length: abSubLen }],
      });
    }
  } else if (isMultiDimMotif) {
    for (const m of motifPairs) {
      const dims = dimsForRank('MOTIF', m.rank, m.dims);
      const isSelected = m.rank === (selectedMdMotif?.rank ?? selectedMotifRank);
      const occ = occurrencesByRank.get(m.rank);
      const expand = showAllOccurrences && isSelected && occ && occ.length > 2;
      // Multidimensional occurrences share one clock; draw each occurrence across every
      // participating sensor lane (the motif's dimension subspace) so the joint repeat reads
      // as one highlighted stretch spanning all its channels.
      const spans = expand
        ? occ!.flatMap((o) =>
            [...dims].map((s) => ({ laneId: String(s), startIdx: o.idx, length: o.subLen })),
          )
        : [...dims].flatMap((s) => [
            { laneId: String(s), startIdx: m.idxA, length: m.subLen },
            { laneId: String(s), startIdx: m.idxB, length: m.subLen },
          ]);
      patternDefs.push({ id: shortPatternId('motif', m.rank), spans });
    }
  } else if (isMultiDimDiscord) {
    for (const d of discords) {
      const dims = dimsForRank('DISCORD', d.rank);
      patternDefs.push({
        id: shortPatternId('discord', d.rank),
        spans: [...dims].map((s) => ({ laneId: String(s), startIdx: d.idx, length: multiSubLen })),
      });
    }
  } else if (isConsensus) {
    const members = consensusMembers.filter((mem) => mem.rank === 1);
    if (members.length > 0) {
      patternDefs.push({
        id: shortPatternId('consensus', 1),
        spans: members.map((mem) => ({
          laneId: String(mem.seriesId),
          startIdx: mem.idx,
          length: multiSubLen,
        })),
      });
    }
  }

  const chartPatterns = patternDefs.map((p, i) => ({ ...p, color: patternOverlayColor(i) }));
  const colorForId = (id: string): string =>
    chartPatterns.find((p) => p.id === id)?.color ?? patternColor('motif');

  // Default every discovered pattern to visible; re-seed whenever the set of patterns
  // changes (new run, or results finish loading).
  const patternIdKey = chartPatterns.map((p) => p.id).join('|');
  useEffect(() => {
    setVisiblePatternIds(new Set(patternIdKey ? patternIdKey.split('|') : []));
  }, [patternIdKey]);

  // Which pattern is focused for detail/emphasis (its overlay is drawn boldest).
  const familyIsDiscord = isDiscord || isAbDiscord || isMultiDimDiscord;
  const selectedPatternId = familyIsDiscord
    ? shortPatternId('discord', selectedDiscordRank)
    : isConsensus
      ? shortPatternId('consensus', 1)
      : isChain
        ? shortPatternId('chain', selectedChainIndex)
        : shortPatternId('motif', selectedMotifRank);

  const toggleVisible = (id: string) =>
    setVisiblePatternIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Per-lane absolute-time mapping so a sample-index span becomes a wall-clock chart span.
  const laneTime: Record<string, { start: number; msPerSample: number } | undefined> = {};
  if (windowStartMs !== undefined && spsMs !== undefined) {
    laneTime.single = { start: windowStartMs, msPerSample: spsMs };
    laneTime.A = { start: windowStartMs, msPerSample: spsMs };
    for (const lane of multiLanes) laneTime[String(lane.seriesId)] = { start: windowStartMs, msPerSample: spsMs };
  }
  if (windowStartMsB !== undefined && spsMsB !== undefined) {
    laneTime.B = { start: windowStartMsB, msPerSample: spsMsB };
  }

  const overlays: PanelOverlay[] = chartPatterns
    .filter((p) => visiblePatternIds.has(p.id))
    .flatMap((p) =>
      p.spans.flatMap((s) => {
        const lt = laneTime[s.laneId];
        if (!lt) return [] as PanelOverlay[];
        const startMs = lt.start + s.startIdx * lt.msPerSample;
        return [
          {
            laneId: s.laneId,
            startMs,
            endMs: startMs + s.length * lt.msPerSample,
            color: p.color,
            selected: p.id === selectedPatternId,
            label: p.id,
          },
        ];
      }),
    );

  // Mode-change boundaries as vertical lines on the signal panels (segmentation runs).
  // Boundary indices are subsequence positions in the shared clock, mapped to absolute time
  // exactly like pattern overlays. The selected change is emphasized + labeled.
  const panelBoundaries: PanelBoundary[] = useMemo(() => {
    if (!isSegmentation && !isMultiDimSeg) return [];
    if (windowStartMs === undefined || spsMs === undefined) return [];
    return [...regimeBounds]
      .sort((a, b) => a.boundaryIdx - b.boundaryIdx)
      .map((b, i) => ({
        timeMs: windowStartMs + b.boundaryIdx * spsMs,
        label: `Change ${i + 1}`,
        selected: b.boundaryIdx === selectedBoundaryIdx,
      }));
  }, [isSegmentation, isMultiDimSeg, regimeBounds, windowStartMs, spsMs, selectedBoundaryIdx]);


  const laneSignal = (laneId: string): { signalId: string; secondsPerSample?: number; laneLabel: string } => {
    if (laneId === 'B') {
      return {
        signalId: compareTagId,
        secondsPerSample: secondsPerSampleB,
        laneLabel: labeler(compareTagId, compareTag?.tagName),
      };
    }
    if (laneId === 'single' || laneId === 'A') {
      return { signalId: job.signalId, secondsPerSample, laneLabel: labeler(job.signalId, tag?.tagName) };
    }
    // Multi lane ids are the numeric seriesId.
    const sid = Number(laneId);
    const laneTagId = seriesTagIds[sid] ?? job.signalId;
    const laneTag = tags.find((t) => t.tagId === laneTagId);
    return { signalId: laneTagId, secondsPerSample, laneLabel: labeler(laneTagId, laneTag?.tagName) };
  };

  // Turn a discovered pattern's spans into per-signal label targets (deduped per signal so
  // motif A/B on one lane collapses to a single target on that signal's first occurrence).
  const targetsForPattern = (patternId: string): LabelTarget[] => {
    const p = chartPatterns.find((cp) => cp.id === patternId);
    if (!p) return [];
    const bySignal = new Map<string, LabelTarget>();
    for (const s of p.spans) {
      const info = laneSignal(s.laneId);
      const key = `${info.signalId}:${s.startIdx}`;
      if (!bySignal.has(key)) {
        bySignal.set(key, {
          signalId: info.signalId,
          startIndex: s.startIdx,
          length: s.length,
          secondsPerSample: info.secondsPerSample,
          laneLabel: info.laneLabel,
        });
      }
    }
    return [...bySignal.values()];
  };

  const annotateSelectedPattern = () => setLabelTargets(targetsForPattern(selectedPatternId));

  // "Find more like these": seed a granularity-locked Similarity search from the
  // selected discovered pattern. Reuses the same per-track occurrences that drive
  // labeling, so a multidimensional pattern seeds every participating track's tag
  // and a single-tag pattern seeds one — both at the pattern's discovery bin.
  // Scoped to single-tag and multidimensional motif/discord (the families a SAX
  // similarity search can consume); AB-join / consensus / segmentation are out.
  const canFindMore =
    !!onFindMore && (isMotif || isDiscord || isMultiDimMotif || isMultiDimDiscord);
  const handleFindMoreLikeThese = () => {
    if (!onFindMore) return;
    const targets = targetsForPattern(selectedPatternId).map((t) => ({
      signalId: t.signalId,
      startIndex: t.startIndex,
      length: t.length,
      secondsPerSample: t.secondsPerSample,
    }));
    const seed = buildFindMoreSeed(job.windowStart, targets, secondsPerSample);
    if (seed) onFindMore(seed);
  };

  // The kind of label written by "Label pattern" for this run family.
  const labelKind: 'MOTIF' | 'DISCORD' = familyIsDiscord ? 'DISCORD' : 'MOTIF';
  // Existing labels across every signal this run touches (so multi-signal labels show too).
  const runSignalIds = new Set<string>([job.signalId, compareTagId, ...seriesTagIds]);
  const runLabels = labels.filter((l) => runSignalIds.has(l.signalId));

  // Saved labels that label a given discovered pattern — matched by identity (signal +
  // exact start index) against the pattern's per-signal targets, since a label is created at
  // its instance's exact start. Lets each pattern row/detail show only its own labels, even
  // when neighboring patterns' windows partially overlap.
  const labelsForPatternId = (patternId: string): Label[] => {
    const targets = targetsForPattern(patternId);
    if (targets.length === 0) return [];
    return runLabels.filter((l) => targets.some((t) => labelMatchesTarget(l, t)));
  };

  // Whether a discovered pattern has ≥1 label — drives the per-row tag icon in list tables.
  const hasLabelsForPattern = (patternId: string): boolean =>
    labelsForPatternId(patternId).length > 0;

  // Compact colored chips for the labels on a pattern (rendered inline in list rows/detail).
  // Each chip shows category + confidence on hover and opens the edit dialog on click.
  const renderLabelChips = (patternId: string) => {
    const ls = labelsForPatternId(patternId);
    if (ls.length === 0) return null;
    return (
      <span className={styles.labelChips}>
        {ls.map((l) => {
          const catName = l.category
            ? (categories.find((c) => c.id === l.category)?.name ?? 'Uncategorized')
            : 'Uncategorized';
          const conf = l.confidence !== undefined ? `${Math.round(l.confidence * 100)}%` : '—';
          return (
            <Tooltip
              key={l.id}
              content={`${catName} · confidence ${conf} · click to edit`}
              relationship="description"
              withArrow
            >
              <Badge
                size="small"
                appearance="tint"
                icon={<TagRegular />}
                style={{ cursor: 'pointer', ...(l.color ? { color: l.color } : {}) }}
                onClick={() => setEditingLabel(l)}
                role="button"
                tabIndex={0}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditingLabel(l);
                  }
                }}
              >
                {l.text || 'label'}
              </Badge>
            </Tooltip>
          );
        })}
      </span>
    );
  };

  // The stacked panels for the synchronized chart, one per rendered signal.
  const panelLanes: PanelLane[] = (() => {
    if (isAb) {
      const out: PanelLane[] = [];
      if (overview.length > 0 && windowStartMs !== undefined && msPerBucket !== undefined) {
        out.push({
          id: 'A',
          label: `Baseline (A): ${labeler(job.signalId, tag?.tagName)}`,
          buckets: overview,
          startMs: windowStartMs,
          msPerBucket,
        });
      }
      if (overviewB.length > 0 && windowStartMsB !== undefined && msPerBucketB !== undefined) {
        out.push({
          id: 'B',
          label: `Comparison (B): ${labeler(compareTagId, compareTag?.tagName)}`,
          buckets: overviewB,
          startMs: windowStartMsB,
          msPerBucket: msPerBucketB,
        });
      }
      return out;
    }
    if (isMulti) {
      if (windowStartMs === undefined || spsMs === undefined) return [];
      // Each lane's buckets span the whole window uniformly — derive the bucket width by
      // exact division (windowDuration / bucketCount) so the plotted line stays anchored to
      // the same clock as the pattern overlays (no accumulating ceil-rounding drift).
      const laneMsPerBucket = (buckets: number): number | undefined =>
        buckets > 0 && windowEndMs !== undefined && windowEndMs > windowStartMs
          ? (windowEndMs - windowStartMs) / buckets
          : undefined;
      return visibleLanes
        .filter((lane) => lane.buckets.length > 0)
        .map((lane) => {
          const laneTagId = seriesTagIds[lane.seriesId];
          const laneTag = tags.find((t) => t.tagId === laneTagId);
          const participates = laneParticipates(lane.seriesId);
          return {
            id: String(lane.seriesId),
            label: `${labeler(laneTagId, laneTag?.tagName)}${
              isMultiDim && !participates ? ' · not part of this event' : ''
            }`,
            dimmed: !participates,
            buckets: lane.buckets,
            startMs: windowStartMs,
            msPerBucket: laneMsPerBucket(lane.buckets.length) ?? spsMs,
          };
        });
    }
    if (overview.length > 0 && windowStartMs !== undefined && msPerBucket !== undefined) {
      return [
        {
          id: 'single',
          label: labeler(job.signalId, tag?.tagName),
          buckets: overview,
          startMs: windowStartMs,
          msPerBucket,
        },
      ];
    }
    return [];
  })();

  return (
    <div className={styles.root}>
      {/* Run detail header: identity, execution stats, methodology & how-to-interpret. */}
      <RunMethodologyPanel
        job={job}
        labelFor={labelForSignal}
        explainTitle={explainTitle}
        explainText={explainText}
      />

      {advice && (
        <MessageBar intent={advice.tone === 'positive' ? 'success' : advice.tone === 'suggestion' ? 'warning' : 'info'}>
          <MessageBarBody>
            <MessageBarTitle>{advice.headline}</MessageBarTitle>
            {advice.detail}
          </MessageBarBody>
        </MessageBar>
      )}

      {job.status === 'RUNNING' && (
        <>
          <ConvergenceMeter
            quality={quality}
            running
            onStop={onStop ? () => onStop(job.id) : undefined}
          />
          {progress?.stage && (
            <Text size={200} className={styles.identityMeta}>
              {progress.stage}
              {isPartial ? ' · showing best match so far' : ''}
            </Text>
          )}
        </>
      )}

      {isCancelled && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Stopped early — showing the best match found so far
            {progress ? ` (${Math.round(progress.pct)}% converged).` : '.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {showDiagnostics && <JobDiagnosticsPanel job={job} />}

      {job.status === 'FAILED' && (
        <ErrorMessageBar error={statusView.detail} />
      )}

      {error && (
        <ErrorMessageBar error={error} prefix="Failed to load results: " />
      )}

      {loading && (
        <div className={styles.spinner}>
          <Spinner size="tiny" />
          <Text size={200}>Loading results…</Text>
        </div>
      )}

      {noResultsYet && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>
              <span className={styles.spinner}>
                <Spinner size="tiny" /> Analysis finished — loading results
              </span>
            </MessageBarTitle>
            The computation is complete and the discovered patterns are being written to the
            query store so they can be charted. This usually takes a few seconds (longer for
            very large windows). This view refreshes automatically — no need to re-run the search.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── 1) Found patterns — list + detail, presented ABOVE the charts so the
             discovered patterns are the primary content and drive the chart below. ── */}

      {/* AB-join results: a ranked list of matched pairs (motif) or novelties (discord).
          The "Show" checkbox toggles each pattern's color-coded overlay on the chart;
          clicking a row focuses it. */}
      {isAbMotif && motifPairs.length > 0 && (
        <div className={styles.abList}>
          <Text weight="semibold">Closest matches across the two series</Text>
          {motifPairs.map((m) => {
            const id = shortPatternId('motif', m.rank);
            return (
              <div
                key={m.rank}
                className={`${styles.abRow} ${m.rank === (selectedAbMotif?.rank ?? 1) ? styles.abRowSelected : ''}`}
                onClick={() => setSelectedMotifRank(m.rank)}
              >
                <div className={styles.rowLead} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={visiblePatternIds.has(id)}
                    onChange={() => toggleVisible(id)}
                    aria-label={`Show ${id} on chart`}
                  />
                  <span className={styles.swatch} style={{ background: colorForId(id) }} aria-hidden />
                </div>
                <Text size={200} weight="semibold">{id}</Text>
                <Text size={200} className={styles.identityMeta}>
                  A@{m.idxA} ↔ B@{m.idxB} · distance {m.dist.toFixed(3)}
                </Text>
                {renderLabelChips(id)}
              </div>
            );
          })}
          <div>
            <Button appearance="primary" icon={<TagRegular />} onClick={annotateSelectedPattern}>
              Label this match
            </Button>
          </div>
          {canShowAllOccurrences && (
            <Switch
              checked={showAllOccurrences}
              onChange={() => setShowAllOccurrences((v) => !v)}
              label={`Show all ${selectedOccurrenceCount} occurrences of the selected match`}
            />
          )}
        </div>
      )}

      {isAbDiscord && discords.length > 0 && (
        <div className={styles.abList}>
          <Text weight="semibold">New behavior in the comparison series</Text>
          {discords.map((d) => {
            const id = shortPatternId('discord', d.rank);
            return (
              <div
                key={d.rank}
                className={`${styles.abRow} ${d.rank === selectedDiscordRank ? styles.abRowSelected : ''}`}
                onClick={() => setSelectedDiscordRank(d.rank)}
              >
                <div className={styles.rowLead} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={visiblePatternIds.has(id)}
                    onChange={() => toggleVisible(id)}
                    aria-label={`Show ${id} on chart`}
                  />
                  <span className={styles.swatch} style={{ background: colorForId(id) }} aria-hidden />
                </div>
                <Text size={200} weight="semibold">{id}</Text>
                <Text size={200} className={styles.identityMeta}>
                  B@{d.idx} · distance from baseline {d.nnDist.toFixed(3)}
                </Text>
                {renderLabelChips(id)}
              </div>
            );
          })}
          <div>
            <Button appearance="primary" icon={<TagRegular />} onClick={annotateSelectedPattern}>
              Label this anomaly
            </Button>
          </div>
        </div>
      )}

      {/* Multidimensional motif: ranked list of multi-sensor events. Selecting a rank
          moves the highlighted span and re-computes which channels participate. */}
      {isMultiDimMotif && motifPairs.length > 0 && (
        <div className={styles.abList}>
          <Text weight="semibold">Multi-sensor events</Text>
          {motifPairs.map((m) => {
            const id = shortPatternId('motif', m.rank);
            return (
              <div
                key={m.rank}
                className={`${styles.abRow} ${m.rank === (selectedMdMotif?.rank ?? 1) ? styles.abRowSelected : ''}`}
                onClick={() => setSelectedMotifRank(m.rank)}
              >
                <div className={styles.rowLead} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={visiblePatternIds.has(id)}
                    onChange={() => toggleVisible(id)}
                    aria-label={`Show ${id} on chart`}
                  />
                  <span className={styles.swatch} style={{ background: colorForId(id) }} aria-hidden />
                </div>
                <Text size={200} weight="semibold">{id}</Text>
                <Text size={200} className={styles.identityMeta}>
                  @{m.idxA} ↔ @{m.idxB} · distance {m.dist.toFixed(3)} ·{' '}
                  {m.numDims ?? mdMotifDims.size} of {seriesTagIds.length} sensors
                </Text>
                {renderLabelChips(id)}
              </div>
            );
          })}
          <Text size={200} className={styles.identityMeta}>
            Participating:{' '}
            {[...mdMotifDims]
              .map((s) => labeler(seriesTagIds[s], tags.find((t) => t.tagId === seriesTagIds[s])?.tagName))
              .join(', ') || '—'}
          </Text>
          <div>
            <Button appearance="primary" icon={<TagRegular />} onClick={annotateSelectedPattern}>
              Label this event ({mdMotifDims.size} sensors)
            </Button>
          </div>
          {canShowAllOccurrences && (
            <Switch
              checked={showAllOccurrences}
              onChange={() => setShowAllOccurrences((v) => !v)}
              label={`Show all ${selectedOccurrenceCount} occurrences of the selected event`}
            />
          )}
        </div>
      )}

      {/* Multidimensional discord: ranked multi-sensor novelties. */}
      {isMultiDimDiscord && discords.length > 0 && (
        <div className={styles.abList}>
          <Text weight="semibold">Multi-sensor anomalies</Text>
          {discords.map((d) => {
            const id = shortPatternId('discord', d.rank);
            return (
              <div
                key={d.rank}
                className={`${styles.abRow} ${d.rank === selectedDiscordRank ? styles.abRowSelected : ''}`}
                onClick={() => setSelectedDiscordRank(d.rank)}
              >
                <div className={styles.rowLead} onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={visiblePatternIds.has(id)}
                    onChange={() => toggleVisible(id)}
                    aria-label={`Show ${id} on chart`}
                  />
                  <span className={styles.swatch} style={{ background: colorForId(id) }} aria-hidden />
                </div>
                <Text size={200} weight="semibold">{id}</Text>
                <Text size={200} className={styles.identityMeta}>
                  @{d.idx} · distance {d.nnDist.toFixed(3)}
                  {d.numDims != null ? ` · ${d.numDims} of ${seriesTagIds.length} sensors` : ''}
                </Text>
                {renderLabelChips(id)}
              </div>
            );
          })}
          <Text size={200} className={styles.identityMeta}>
            Defining sensors:{' '}
            {[...mdDiscordDims]
              .map((s) => labeler(seriesTagIds[s], tags.find((t) => t.tagId === seriesTagIds[s])?.tagName))
              .join(', ') || '—'}
          </Text>
          <div>
            <Button appearance="primary" icon={<TagRegular />} onClick={annotateSelectedPattern}>
              Label this anomaly ({mdDiscordDims.size} sensors)
            </Button>
          </div>
        </div>
      )}

      {/* Consensus motif: one member per series (where the shared shape occurs). A single
          overlay (C1) marks the shape in every signal; the toggle shows/hides it. */}
      {isConsensus && consensusMembers.length > 0 && (
        <div className={styles.abList}>
          <div className={styles.laneHeaderRow}>
            <Text weight="semibold">The shape across the fleet</Text>
            {chartPatterns[0] && (
              <div className={styles.rowLead}>
                <Checkbox
                  checked={visiblePatternIds.has(chartPatterns[0].id)}
                  onChange={() => toggleVisible(chartPatterns[0].id)}
                  label="Show on chart"
                />
                <span className={styles.swatch} style={{ background: colorForId(chartPatterns[0].id) }} aria-hidden />
              </div>
            )}
          </div>
          {consensusMembers
            .filter((mem) => mem.rank === 1)
            .map((mem) => {
              const memTagId = seriesTagIds[mem.seriesId];
              const memTag = tags.find((t) => t.tagId === memTagId);
              return (
                <div key={mem.seriesId} className={styles.abRow}>
                  <Text size={200}>{mem.isCentral ? '★' : '•'}</Text>
                  <Text size={200} className={styles.identityMeta}>
                    {labeler(memTagId, memTag?.tagName)} · @{mem.idx}
                    {mem.dist != null ? ` · distance ${mem.dist.toFixed(3)}` : ''}
                    {mem.isCentral ? ' · reference' : ''}
                  </Text>
                </div>
              );
            })}
          {renderLabelChips(shortPatternId('consensus', 1))}
          <div>
            <Button appearance="primary" icon={<TagRegular />} onClick={annotateSelectedPattern}>
              Label the consensus occurrences
            </Button>
          </div>
        </div>
      )}

      {/* Found motifs: list, per-motif stats, aligned overlay, labeling controls.
          Uses the live/partial best-so-far when final rows are not yet ingested. */}
      {isMotif && displayMotifs.length > 0 && (
        <MotifDetails
          motifs={displayMotifs}
          rawSignal={rawSignal}
          secondsPerSample={secondsPerSample}
          windowStartMs={windowStartMs}
          selectedRank={selectedMotif?.rank ?? 1}
          onSelectRank={setSelectedMotifRank}
          onLabel={(span: Span) =>
            setLabelTargets([
              {
                signalId: job.signalId,
                startIndex: span.startIndex,
                length: span.length,
                secondsPerSample,
                laneLabel: labeler(job.signalId, tag?.tagName),
              },
            ])
          }
          visibleIds={visiblePatternIds}
          onToggleVisible={toggleVisible}
          colorForId={colorForId}
          occurrenceSpans={selectedMotifOccurrences}
          showAllOccurrences={showAllOccurrences}
          onToggleShowAll={() => setShowAllOccurrences((v) => !v)}
          renderLabels={renderLabelChips}
          hasLabels={hasLabelsForPattern}
        />
      )}

      {/* Discord flags (discord jobs) */}
      {isDiscord && discordFlags.length > 0 && (
        <DiscordFlags
          discords={discordFlags}
          totalSamples={rawSignal.length || mpValues.length || overview.length}
          secondsPerSample={secondsPerSample}
          subLen={job.subLen}
          windowStartMs={windowStartMs}
          selectedRank={selectedDiscordRank}
          onSelectRank={setSelectedDiscordRank}
          onAnnotate={annotateSelectedPattern}
          visibleIds={visiblePatternIds}
          onToggleVisible={toggleVisible}
          colorForId={colorForId}
          renderLabels={renderLabelChips}
          hasLabels={hasLabelsForPattern}
        />
      )}

      {/* Slow degradation: chain members + head→tail drift trend. */}
      {isChain && chainLinks.length > 0 && (
        <ChainView
          chains={chainLinks}
          rawSignal={rawSignal}
          secondsPerSample={secondsPerSample}
          windowStartMs={windowStartMs}
          selectedIndex={selectedChainIndex}
          onSelectIndex={setSelectedChainIndex}
          visibleIds={visiblePatternIds}
          onToggleVisible={toggleVisible}
          colorForId={colorForId}
          onAnnotate={annotateSelectedPattern}
        />
      )}

      {/* "Find more like these": launch a granularity-locked Similarity search
          seeded from the selected pattern's shape (and every track it spans). */}
      {canFindMore && !noResultsYet && (
        <div className={styles.findMore}>
          <div className={styles.findMoreText}>
            <Text weight="semibold">Find more like these</Text>
            <Text size={200} className={styles.identityMeta}>
              Search for this {familyIsDiscord ? 'anomaly' : 'pattern'} shape elsewhere at the same
              temporal granularity it was discovered at
              {isMultiDim ? ', across every sensor that took part' : ''}.
            </Text>
          </div>
          <Button appearance="primary" icon={<SearchRegular />} onClick={handleFindMoreLikeThese}>
            Find more like these
          </Button>
        </div>
      )}

      {/* Labeling — label the selected pattern across every signal it touches. Placed
          directly under the pattern list/detail so it's discoverable; the "Label pattern" button
          in each pattern's detail queues its stretches here. */}
      {!noResultsYet && (isMotif || familyIsDiscord || isMulti || isChain) && (
        <LabelLayer
          signalId={job.signalId}
          jobId={job.id}
          targets={labelTargets}
          kind={labelKind}
          categories={categories}
          labels={runLabels}
          mp={mpValues}
          mpi={mpiValues}
          secondsPerSample={secondsPerSample}
          onCreate={(inputs) => {
            onCreateLabels(inputs);
            setLabelTargets([]);
          }}
          onDelete={onDeleteLabel}
        />
      )}

      <LabelEditDialog
        label={editingLabel}
        categories={categories}
        onUpdate={onUpdateLabel}
        onDelete={onDeleteLabel}
        onClose={() => setEditingLabel(null)}
      />

      {/* ── 2) Synchronized signal chart: one stacked panel per signal sharing a single
             time axis, a linked crosshair, and one zoom/pan control. Discovered patterns
             are overlaid as color-coded shaded bands (toggled from the list above). ── */}
      {panelLanes.length > 0 && (
        <>
          {manyLanes && isMultiDim && (
            <div className={styles.laneHeaderRow}>
              <Text size={200} className={styles.identityMeta}>
                {focusMultiDim
                  ? `Showing ${visibleLanes.length} participating of ${multiLanes.length} sensors`
                  : `Showing all ${multiLanes.length} sensors`}
              </Text>
              <Button size="small" appearance="subtle" onClick={() => setShowAllLanes((v) => !v)}>
                {showAllLanes ? 'Focus on participating' : 'Show all sensors'}
              </Button>
            </div>
          )}
          {chartPatterns.length > 0 && (
            <div className={styles.legend}>
              {chartPatterns.map((p) => (
                <span
                  key={p.id}
                  className={styles.legendItem}
                  style={{ opacity: visiblePatternIds.has(p.id) ? 1 : 0.4 }}
                >
                  <span className={styles.swatch} style={{ background: p.color }} aria-hidden />
                  <Text size={200}>{p.id}</Text>
                </span>
              ))}
            </div>
          )}
          <SignalPanels
            lanes={panelLanes}
            overlays={overlays}
            boundaries={panelBoundaries}
            fileName={`run_${job.id}`}
          />
        </>
      )}

      {/* ── 3) Supporting analytic lanes ── */}
      {!isAb && mpValues.length > 0 && <MatrixProfileLane mp={mpValues} />}

      {/* Regime / mode changes: colored ribbon + change-score lane. */}
      {isSegmentation && (arcCurve.length > 0 || regimeBounds.length > 0) && (
        <RegimeRibbon
          boundaries={regimeBounds}
          cac={arcCurve}
          totalSamples={arcCurve.length || rawSignal.length}
          selectedBoundaryIdx={selectedBoundaryIdx}
          onSelectBoundary={setSelectedBoundaryIdx}
        />
      )}
      {isMultiDimSeg && (arcCurve.length > 0 || regimeBounds.length > 0) && (
        <RegimeRibbon
          boundaries={regimeBounds}
          cac={arcCurve}
          totalSamples={arcCurve.length || multiLanes[0]?.raw.length || 0}
          selectedBoundaryIdx={selectedBoundaryIdx}
          onSelectBoundary={setSelectedBoundaryIdx}
        />
      )}
    </div>
  );
}
