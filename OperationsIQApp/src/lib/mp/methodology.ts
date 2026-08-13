/**
 * Per-analysis-type methodology, interpretation guidance, and metric explanations.
 *
 * This is the single source of truth for the "what are we doing, and how do I read it?"
 * copy shown on the Run detail page. It is written for an operations analyst — plain
 * language, no Matrix Profile jargon — so every pattern-search type explains itself
 * consistently. Pure + dependency-free so it is fully unit-testable.
 */
import type { JobType } from './types';

export type MethodFamily =
  | 'motif'
  | 'discord'
  | 'segmentation'
  | 'chain'
  | 'consensus'
  | 'compare'
  | 'auto'
  | 'similarity'
  | 'rule';

export interface MetricGuide {
  /** Short label shown on a metric chip / stat card. */
  label: string;
  /** One-line, plain-language "what this number means". */
  meaning: string;
}

export interface Methodology {
  family: MethodFamily;
  /** Underlying algorithm family, shown as a small caption ("how it works"). */
  algorithm: string;
  /** 2–3 sentence plain-language description of what the analysis does. */
  method: string;
  /** How an operations analyst should read the results. */
  interpretation: string;
  /** The key outputs this analysis reports, each with a one-line meaning. */
  metrics: MetricGuide[];
}

const METRIC: Record<string, MetricGuide> = {
  similarity: {
    label: 'Similarity',
    meaning: 'How closely the two stretches match — higher means a cleaner, more confident repeat.',
  },
  distance: {
    label: 'Distance',
    meaning: 'Shape difference between the matched stretches — lower means more alike.',
  },
  severity: {
    label: 'Severity',
    meaning: 'How far the flagged stretch sits from everything else — higher means more unusual.',
  },
  nnDistance: {
    label: 'Distance to nearest match',
    meaning: 'How far the stretch is from its closest look-alike — larger means more isolated / anomalous.',
  },
  duration: {
    label: 'Duration',
    meaning: 'How long the pattern lasts, from its start to its end timestamp.',
  },
  channels: {
    label: 'Participating sensors',
    meaning: 'Which sensors actually drive this event (the "k of N" that moved together).',
  },
  modes: {
    label: 'Operating modes',
    meaning: 'The distinct behavior segments the timeline was split into.',
  },
  links: {
    label: 'Chain length',
    meaning: 'How many linked repeats were found — a longer chain is a stronger drift signal.',
  },
  drift: {
    label: 'Drift',
    meaning: 'How much the pattern grows or shrinks from the first repeat to the last.',
  },
};

const MOTIF: Methodology = {
  family: 'motif',
  algorithm: 'Matrix Profile motif search (MOMP)',
  method:
    'We scan the whole window and find the two stretches whose shapes are the most alike. Repeating shapes usually mark normal, healthy cycles you can treat as a baseline.',
  interpretation:
    'Start with the top match — a strong repeat means a clear, routine cycle. Weak repeats suggest the pattern length is off or the signal is mostly noise; try a different length or sensor.',
  metrics: [METRIC.similarity, METRIC.distance, METRIC.duration],
};

const DISCORD: Methodology = {
  family: 'discord',
  algorithm: 'Matrix Profile discord search (DAMP)',
  method:
    'We look for the stretch that is least like anything else in the window. These stand-out events are often the earliest sign of a developing fault or upset.',
  interpretation:
    'Higher severity means the stretch is more unlike its surroundings. Review the top-ranked discords first; a mildly unusual result is often just normal variation.',
  metrics: [METRIC.severity, METRIC.nnDistance, METRIC.duration],
};

const SEGMENTATION: Methodology = {
  family: 'segmentation',
  algorithm: 'Regime detection (arc-curve / FLUSS)',
  method:
    "We track how the signal's shape repeats and flag the moments its character changes, splitting the timeline into distinct operating modes.",
  interpretation:
    'Each boundary is a switch-over point (for example start-up → steady → shutdown). The dips in the change-score line beneath the signal mark where behavior changed.',
  metrics: [METRIC.modes, METRIC.duration],
};

const CHAIN: Methodology = {
  family: 'chain',
  algorithm: 'Time-series chains',
  method:
    'We find a recurring pattern and link each repeat to the next, forming a chain that tracks how the shape slowly evolves over time.',
  interpretation:
    'A steady drift along the chain is the fingerprint of gradual wear — bearing degradation, fouling, or sensor drift. A longer chain with a clear trend is more trustworthy.',
  metrics: [METRIC.links, METRIC.drift, METRIC.duration],
};

const AUTO: Methodology = {
  family: 'auto',
  algorithm: 'Pan Matrix Profile (multi-length scan)',
  method:
    "We try a whole range of pattern lengths at once and keep the clearest results, so you don't have to guess how long the pattern is.",
  interpretation:
    'Compare the surfaced patterns across lengths — the clearest, most repeated shapes rise to the top. Use them to decide the pattern length worth a focused re-run.',
  metrics: [METRIC.similarity, METRIC.duration],
};

const SIMILARITY: Methodology = {
  family: 'similarity',
  algorithm: 'Full Matrix Profile',
  method:
    'We compute the full similarity profile of the window — for every stretch, how close its nearest look-alike is. This underpins both repeat and anomaly views.',
  interpretation:
    'Low points on the profile are the most repeated shapes; high points are the most unusual. Use it as an overview before drilling into specific motifs or discords.',
  metrics: [METRIC.distance, METRIC.duration],
};

const RULE: Methodology = {
  family: 'rule',
  algorithm: 'Association-rule discovery',
  method:
    'We mine the discovered patterns for "when X happens, Y tends to follow" style relationships between recurring shapes.',
  interpretation:
    'Each rule links a triggering shape to a likely consequence. Treat higher-support, higher-confidence rules as the most dependable.',
  metrics: [METRIC.similarity, METRIC.duration],
};

/**
 * Methodology copy per job type. Families share base text; multi-sensor and compare
 * variants add the extra context that makes them distinct.
 */
export const METHODOLOGY: Record<JobType, Methodology> = {
  MOTIF_MOMP: MOTIF,
  DISCORD_DAMP: DISCORD,
  FULL_MP: SIMILARITY,
  PAN_MP: AUTO,
  SEGMENTATION: SEGMENTATION,
  CHAIN: CHAIN,
  RULE_DISCOVERY: RULE,
  CONSENSUS: {
    family: 'consensus',
    algorithm: 'Consensus motif (Ostinato)',
    method:
      'We search a set of signals for a single shape that appears in all — or most — of them, revealing behavior shared across a fleet of assets.',
    interpretation:
      'The consensus shape is the common thread across the fleet. The central member is the most representative example; outliers may be assets behaving differently.',
    metrics: [METRIC.similarity, METRIC.channels, METRIC.duration],
  },
  CONSENSUS_MOTIF: {
    family: 'consensus',
    algorithm: 'Consensus motif (Ostinato)',
    method:
      'We search a set of signals for a single shape that appears in all — or at least a chosen number — of them, revealing a fleet-wide common behavior.',
    interpretation:
      'The consensus shape is the pattern shared across the fleet. Check which series contain it and how central each match is; missing members are worth investigating.',
    metrics: [METRIC.similarity, METRIC.channels, METRIC.duration],
  },
  MULTIDIM: {
    family: 'motif',
    algorithm: 'Multidimensional Matrix Profile (mSTAMP)',
    method:
      'We line up several sensors from one asset on a common clock and find the moment their shapes repeat together, then report which sensors took part.',
    interpretation:
      'A multi-sensor repeat is a coordinated operating event no single sensor makes obvious. Focus on the participating sensors; the rest are shown dimmed for context.',
    metrics: [METRIC.similarity, METRIC.channels, METRIC.duration],
  },
  MULTIDIM_MOTIF: {
    family: 'motif',
    algorithm: 'Multidimensional Matrix Profile (mSTAMP)',
    method:
      'We line up several sensors from one asset on a common clock and find the moment their shapes repeat together, then name which sensors took part.',
    interpretation:
      'A multi-sensor repeat is a coordinated operating event no single sensor makes obvious. Focus on the participating sensors; the rest are dimmed for context.',
    metrics: [METRIC.similarity, METRIC.channels, METRIC.duration],
  },
  MULTIDIM_DISCORD: {
    family: 'discord',
    algorithm: 'Multidimensional discord (mSTAMP)',
    method:
      'We line up several sensors from one asset on a common clock and flag the stretch that is most unlike the rest across the sensors together.',
    interpretation:
      'A joint anomaly stands out only when the sensors are read as a group. The named sensors are the ones driving the novelty — a strong cue for root-cause.',
    metrics: [METRIC.severity, METRIC.channels, METRIC.duration],
  },
  MULTIDIM_SEGMENTATION: {
    family: 'segmentation',
    algorithm: 'Multidimensional regime detection',
    method:
      'We line up several sensors on a common clock and split the timeline where their joint behavior changes at once.',
    interpretation:
      'Each boundary is a moment the asset changed operating mode across several sensors together — a more robust regime signal than any single channel.',
    metrics: [METRIC.modes, METRIC.channels, METRIC.duration],
  },
  AB_MOTIF: {
    family: 'compare',
    algorithm: 'AB-join motif search',
    method:
      'We compare a baseline (series A) with a comparison (series B) — two signals, or the same signal in two windows — and find the stretches that look most alike across them.',
    interpretation:
      'Strong cross-matches confirm B behaves like the A baseline (a healthy sibling, or this week matching last week). Weak matches mean B has drifted from the baseline.',
    metrics: [METRIC.similarity, METRIC.distance, METRIC.duration],
  },
  AB_DISCORD: {
    family: 'compare',
    algorithm: 'AB-join novelty search',
    method:
      'We take a known-good baseline (series A) and the period to check (series B), and flag the stretches of B that have no close match anywhere in A.',
    interpretation:
      'Flagged stretches are genuinely new behavior that emerged relative to the baseline. The larger the distance to A, the more novel the behavior.',
    metrics: [METRIC.nnDistance, METRIC.severity, METRIC.duration],
  },
};

/** Methodology for a job type, falling back to the full-profile description. */
export function methodologyFor(type: JobType): Methodology {
  return METHODOLOGY[type] ?? SIMILARITY;
}
