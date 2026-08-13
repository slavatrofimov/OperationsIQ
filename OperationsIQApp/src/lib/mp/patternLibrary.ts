/**
 * Pure helpers for the Pattern library — the browsable, searchable store of saved
 * patterns (design: "store patterns persistently … browsable/filterable gallery … usable
 * across runs"). Saved patterns are persisted as {@link Label}s carrying provenance
 * (source signal, originating run, location + length, kind, category, saved date), so the
 * library is built entirely from the existing Labels backend. Pure + dependency-light so
 * the whole library layer is unit-tested without a browser or backend.
 */
import type { Label } from './types';
import type { JobType } from './types';
import { formatDuration } from './units';

export interface LibraryFilter {
  /** Free-text match on the pattern name, category, signal, or run id. */
  text?: string;
  /** Restrict to a kind. */
  kind?: Label['kind'] | 'all';
  /** Restrict to a category id. */
  category?: string | 'all';
  /** Restrict to a source signal id. */
  signalId?: string | 'all';
  /** Restrict to the analysis type (job type) the pattern was discovered by. */
  analysisType?: JobType | 'all';
}

export type LibrarySortKey = 'date' | 'name' | 'kind' | 'signal';
export type LibrarySortDir = 'asc' | 'desc';

/** A saved pattern's display name: its text, else a kind + location fallback. */
export function patternName(label: Label): string {
  const t = label.text?.trim();
  if (t) return t;
  const kind = label.kind === 'MOTIF' ? 'Pattern' : 'Anomaly';
  return `${kind} @${label.startIndex}`;
}

function createdMs(label: Label): number {
  if (!label.createdAt) return 0;
  const t = new Date(label.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Real-world duration of a saved pattern, using its persisted temporal resolution
 * (`secondsPerSample`). Returns a formatted string (e.g. "1h 5m") when the resolution is
 * known, else `undefined` so callers can fall back to the sample count.
 */
export function patternDuration(label: Label): string | undefined {
  const sps = label.secondsPerSample;
  if (!sps || !Number.isFinite(sps) || sps <= 0) return undefined;
  if (!Number.isFinite(label.length) || label.length <= 0) return undefined;
  return formatDuration(label.length * sps);
}

/** Distinct category ids present in the saved patterns, in first-seen order. */
export function libraryCategories(labels: Label[]): string[] {
  const seen: string[] = [];
  for (const l of labels) {
    if (l.category && !seen.includes(l.category)) seen.push(l.category);
  }
  return seen;
}

/** Distinct source signal ids present in the saved patterns, in first-seen order. */
export function librarySignals(labels: Label[]): string[] {
  const seen: string[] = [];
  for (const l of labels) {
    if (l.signalId && !seen.includes(l.signalId)) seen.push(l.signalId);
  }
  return seen;
}

/**
 * Distinct analysis types (job types) present among the saved patterns, in first-seen
 * order. `typeFor` resolves a saved pattern to the analysis type of the run it came from
 * (patterns carry only a `jobId`, so the type is looked up against the run history).
 */
export function libraryAnalysisTypes(
  labels: Label[],
  typeFor: (label: Label) => JobType | undefined,
): JobType[] {
  const seen: JobType[] = [];
  for (const l of labels) {
    const t = typeFor(l);
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

/**
 * Filter saved patterns. `nameFor` optionally maps a signal id to a friendly name so text
 * search matches the label users actually see (falls back to the raw id). `typeFor` maps a
 * pattern to its originating analysis type, enabling the `analysisType` filter.
 */
export function filterLibrary(
  labels: Label[],
  filter: LibraryFilter,
  nameFor: (signalId: string) => string = (id) => id,
  typeFor: (label: Label) => JobType | undefined = () => undefined,
): Label[] {
  const { text, kind = 'all', category = 'all', signalId = 'all', analysisType = 'all' } = filter;
  const q = (text ?? '').trim().toLowerCase();
  return labels.filter((l) => {
    if (kind !== 'all' && l.kind !== kind) return false;
    if (category !== 'all' && l.category !== category) return false;
    if (signalId !== 'all' && l.signalId !== signalId) return false;
    if (analysisType !== 'all' && typeFor(l) !== analysisType) return false;
    if (q) {
      const hay = [
        patternName(l),
        l.category ?? '',
        l.signalId,
        nameFor(l.signalId),
        l.jobId ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Stable sort of saved patterns by a column. */
export function sortLibrary(
  labels: Label[],
  key: LibrarySortKey,
  dir: LibrarySortDir,
  nameFor: (signalId: string) => string = (id) => id,
): Label[] {
  const sign = dir === 'asc' ? 1 : -1;
  const withIndex = labels.map((l, i) => ({ l, i }));
  withIndex.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'date':
        cmp = createdMs(a.l) - createdMs(b.l);
        break;
      case 'name':
        cmp = patternName(a.l).localeCompare(patternName(b.l));
        break;
      case 'kind':
        cmp = a.l.kind.localeCompare(b.l.kind);
        break;
      case 'signal':
        cmp = nameFor(a.l.signalId).localeCompare(nameFor(b.l.signalId));
        break;
    }
    if (cmp !== 0) return cmp * sign;
    return a.i - b.i;
  });
  return withIndex.map((x) => x.l);
}
