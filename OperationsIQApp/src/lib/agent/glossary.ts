/**
 * Method & term glossary — the knowledge base behind `explain_method`.
 *
 * The Operations Advisor teaches, so its explanations of the app's own analytics should
 * be consistent and grounded rather than re-invented per turn. Each entry pairs
 * a short definition with when-to-use guidance and the honest caveats the tool
 * results themselves carry, so the model repeats the same careful framing every
 * time. This is static, read-only knowledge — no query, no state.
 *
 * Keep entries terse and analyst-facing. When a method maps to a tool, name the
 * tool so the model can route from an explanation to an action.
 */

export interface GlossaryEntry {
  /** Canonical term id (lower-case, used for lookup). */
  term: string;
  /** Human-friendly display title. */
  title: string;
  /** One-to-three sentence definition. */
  definition: string;
  /** When an analyst should reach for it. */
  whenToUse: string;
  /** The honest limitations to state alongside any result. */
  caveats: string;
  /** Related tool name(s), when the method is exposed as a tool. */
  relatedTools?: string[];
  /** Alternate spellings/synonyms that resolve to this entry. */
  aliases?: string[];
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'sax',
    title: 'SAX (Symbolic Aggregate approXimation)',
    definition:
      'A representation that z-normalizes a window, reduces it with Piecewise Aggregate ' +
      'Approximation (PAA), then maps each segment to a letter from a fixed alphabet, turning ' +
      'a numeric subsequence into a short word.',
    whenToUse:
      'Underpins fast shape-based similarity search, discord discovery, and SAX-VSM ' +
      'classification — reach for it when the *shape* of a pattern matters more than exact values.',
    caveats:
      'Z-normalization discards absolute level and scale, so SAX matches on shape, not magnitude. ' +
      'Alphabet size and word length trade sensitivity against noise robustness.',
    relatedTools: ['find_similar_patterns', 'detect_discords'],
    aliases: ['symbolic aggregate approximation'],
  },
  {
    term: 'discord',
    title: 'Time-series discord',
    definition:
      'The subsequence of a series that is maximally different from every other subsequence — ' +
      'the most unusual window, a parameter-light anomaly definition.',
    whenToUse: 'Find the single strangest stretch of a signal when you have no labeled examples.',
    caveats:
      'A discord is always the *relatively* most unusual window; it is not proof of a fault, and ' +
      'the result depends on the chosen window length.',
    relatedTools: ['detect_discords'],
    aliases: ['discords', 'anomaly subsequence'],
  },
  {
    term: 'motif',
    title: 'Time-series motif',
    definition: 'A subsequence shape that recurs — the most-repeated pattern in a signal.',
    whenToUse: 'Identify a signal\'s characteristic repeated behaviour (e.g. a normal duty cycle).',
    caveats: 'Recurrence is measured on shape after normalization; a motif is not inherently "good" or "bad".',
    relatedTools: ['find_similar_patterns', 'segment_cycles'],
    aliases: ['motifs', 'recurring pattern'],
  },
  {
    term: 'forecast_band',
    title: 'Forecast prediction interval',
    definition:
      'The uncertainty band around a point forecast. When a rolling-origin backtest is feasible ' +
      'the band is calibrated from MEASURED out-of-sample per-horizon errors (which need not widen ' +
      'as √time); otherwise it falls back to a band that widens with √(steps ahead) under a ' +
      'random-walk, Gaussian-error assumption.' +
      ' The model input may be automatically outlier-cleaned (isolated spikes winsorized to the decomposition baseline) when a rolling-origin backtest shows it lowers out-of-sample error; otherwise the raw series is used. The fit may also use a shortened recent-regime history window instead of the full history when a rolling-origin backtest shows it forecasts the current regime more accurately.',
    whenToUse: 'Communicate how confident a projection is, and the probability of crossing a threshold.',
    caveats:
      'The √-time widening assumes independent, identically distributed errors and no regime change; ' +
      'breach probabilities assume independent, approximately-normal per-step errors and are therefore ' +
      'approximate estimates, not a guaranteed bound (they can be higher or lower than the true risk). ' +
      'The aggregate any-breach probability is estimated from residual-based error trajectories that ' +
      'preserve cross-horizon dependence when the band is empirically calibrated.',
    relatedTools: ['forecast', 'forecast_detail'],
    aliases: ['prediction interval', 'confidence band', 'forecast interval', 'forecast band'],
  },
  {
    term: 'granger_causality',
    title: 'Granger causality',
    definition:
      'A statistical test of whether one series\'s past values improve prediction of another\'s, ' +
      'used to draw directional "influence" edges between tags.',
    whenToUse: 'Rank likely drivers of a target and see the direction of lead/lag relationships.',
    caveats:
      'Granger causality is predictive association, NOT physical causation: a hidden common driver, ' +
      'confounding, or the wrong lag can all produce a spurious edge.',
    relatedTools: ['causality_matrix', 'rank_causes'],
    aliases: ['granger', 'causality'],
  },
  {
    term: 'control_chart',
    title: 'SPC control chart (I-MR)',
    definition:
      'A Statistical Process Control chart of individuals (I) and moving range (MR) with control ' +
      'limits derived from the process\'s own variation, plus run-rule tests (WECO/Nelson).',
    whenToUse: 'Decide whether a process is in statistical control and flag special-cause signals.',
    caveats:
      'Limits assume a roughly stable, unimodal process; drift, autocorrelation, or mixed regimes ' +
      'inflate false alarms. Control limits are not spec limits.',
    relatedTools: ['control_chart', 'set_spc_baseline'],
    aliases: ['spc', 'i-mr', 'imr', 'statistical process control'],
  },
  {
    term: 'sax_vsm',
    title: 'SAX-VSM classification',
    definition:
      'An interpretable classifier that turns labeled spans into bags of SAX words, weights them ' +
      'with tf-idf, and scores new windows by cosine similarity to each class term-vector.',
    whenToUse: 'Train a lightweight, explainable pattern classifier from a handful of labeled examples.',
    caveats:
      'Quality depends on label coverage; tf-idf weights explain a decision but are not a physical model.',
    relatedTools: ['train_vsm_model'],
    aliases: ['vsm', 'sax vsm', 'classification'],
  },
  {
    term: 'anomaly',
    title: 'Unsupervised anomaly (series_decompose_anomalies)',
    definition:
      'A statistical outlier flagged by decomposing a series into trend + seasonal + residual and ' +
      'testing the residual against a sensitivity threshold.',
    whenToUse: 'A quick, label-free first pass at "is anything odd here?" while exploring a signal.',
    caveats:
      'Flags statistical outliers, not confirmed faults; sensitivity controls how many points trip. ' +
      'Interpolated gaps can create artefacts.',
    relatedTools: ['explore_signals'],
    aliases: ['anomalies', 'outlier'],
  },
];

const BY_KEY = (() => {
  const map = new Map<string, GlossaryEntry>();
  for (const e of GLOSSARY) {
    map.set(e.term, e);
    for (const a of e.aliases ?? []) map.set(a.toLowerCase(), e);
  }
  return map;
})();

/** Resolve a term or alias (case-insensitive) to its glossary entry, or null. */
export function lookupMethod(term: string): GlossaryEntry | null {
  const key = term.trim().toLowerCase();
  if (!key) return null;
  const direct = BY_KEY.get(key);
  if (direct) return direct;
  // Loose contains-match fallback so "the forecast band" still resolves.
  for (const [k, entry] of BY_KEY) {
    if (key.includes(k) || k.includes(key)) return entry;
  }
  return null;
}

/** All known terms (canonical ids), for discovery. */
export function listMethods(): { term: string; title: string }[] {
  return GLOSSARY.map((e) => ({ term: e.term, title: e.title }));
}
