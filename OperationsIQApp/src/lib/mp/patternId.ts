/**
 * Stable, human-readable pattern identity (design: "Unique ID of the pattern", shown
 * consistently in the list, on the chart, and in the pattern detail). Pure + testable.
 *
 * Format: `P-<run>-<kind><rank>` e.g. `P-AB12CD34-M1` (motif #1 of run AB12CD34).
 * The run segment reuses {@link shortRunId} so an id is traceable back to its run at a
 * glance, and the kind letter keeps motifs, discords, chains, regimes, and consensus
 * shapes visually distinct.
 */
import { shortRunId } from './runHistory';

export type PatternIdKind = 'motif' | 'discord' | 'chain' | 'regime' | 'consensus';

const KIND_LETTER: Record<PatternIdKind, string> = {
  motif: 'M',
  discord: 'D',
  chain: 'L',
  regime: 'R',
  consensus: 'C',
};

/** Build a stable pattern id from its parent run id, kind, and 1-based rank. */
export function patternId(jobId: string, kind: PatternIdKind, rank: number): string {
  const run = shortRunId(jobId);
  const letter = KIND_LETTER[kind] ?? 'P';
  const r = Number.isFinite(rank) && rank > 0 ? Math.trunc(rank) : 1;
  return `P-${run}-${letter}${r}`;
}

/** Short pattern id without the run segment, e.g. `M1` — for tight, in-context labels. */
export function shortPatternId(kind: PatternIdKind, rank: number): string {
  const letter = KIND_LETTER[kind] ?? 'P';
  const r = Number.isFinite(rank) && rank > 0 ? Math.trunc(rank) : 1;
  return `${letter}${r}`;
}
