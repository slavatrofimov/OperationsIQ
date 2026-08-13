/**
 * Pure run-history helpers for the Deep Discovery Runs list (design: "list pattern
 * search jobs with unique IDs, names, and dates … how long it took, how many patterns").
 *
 * These are pure + dependency-light (only `formatDuration`, `jobTypeLabel`, and the
 * `ResultSummary` shape) so the whole run-history layer is unit-tested without a browser.
 * The result-count is BEST-EFFORT from the persisted summary (which often carries only the
 * top results); the authoritative per-pattern counts live in the KQL result tables shown in
 * the run-detail view. Callers should label the list count accordingly.
 */
import type { AnalysisJob, JobType, ResultSummary } from './types';
import { formatDuration } from './units';
import { jobTypeLabel } from './naming';

/** Short, human-readable run id derived from the (GUID-ish) job id. */
export function shortRunId(id: string): string {
  const clean = (id || '').replace(/[^a-zA-Z0-9]/g, '');
  return clean ? clean.slice(0, 8).toUpperCase() : '—';
}

/** The run's display title: its name, else the friendly type label. */
export function runTitle(job: AnalysisJob): string {
  return job.name?.trim() || jobTypeLabel(job.type);
}

/** How long the job ran, in seconds: prefer computeSeconds, else finished−started/submitted. */
export function runDurationSeconds(job: AnalysisJob): number | undefined {
  if (typeof job.computeSeconds === 'number' && job.computeSeconds > 0) return job.computeSeconds;
  if (!job.finishedAt) return undefined;
  const end = new Date(job.finishedAt).getTime();
  const startIso = job.startedAt ?? job.submittedAt;
  if (!startIso) return undefined;
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return undefined;
  return (end - start) / 1000;
}

/** Formatted run duration, e.g. "2 min 10 s", or undefined when not yet known. */
export function runDurationLabel(job: AnalysisJob): string | undefined {
  const s = runDurationSeconds(job);
  return s === undefined ? undefined : formatDuration(s);
}

/** The epoch ms the run was submitted (fallback started/finished), for sorting. */
export function runDateMs(job: AnalysisJob): number {
  const iso = job.submittedAt ?? job.startedAt ?? job.finishedAt;
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

/** Locale date-time the run was submitted, or "—". */
export function runDateLabel(job: AnalysisJob): string {
  const iso = job.submittedAt ?? job.startedAt ?? job.finishedAt;
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Compact relative time, e.g. "just now", "5 min ago", "2 h ago", "3 d ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Safely parse a job's summary JSON into a {@link ResultSummary}. */
export function parseSummary(job: AnalysisJob): ResultSummary | undefined {
  if (!job.summary) return undefined;
  try {
    return JSON.parse(job.summary) as ResultSummary;
  } catch {
    return undefined;
  }
}

export interface RunResultCount {
  /** Best-effort number of discovered patterns/results from the summary. */
  count: number;
  /** True when the count reflects only the top results, not an exhaustive total. */
  approximate: boolean;
}

/**
 * Best-effort count of discovered patterns from the persisted summary, per job type.
 * Returns undefined when the run is not finished or carries no countable summary.
 */
export function runResultCount(job: AnalysisJob): RunResultCount | undefined {
  if (job.status !== 'SUCCEEDED') return undefined;
  const s = parseSummary(job);
  if (!s) return undefined;

  // Discord-style: explicit list, else a single top discord.
  if (Array.isArray(s.discords) && s.discords.length > 0) {
    return { count: s.discords.length, approximate: true };
  }
  if (s.topDiscord) return { count: 1, approximate: true };

  // Consensus: one member per participating series → one shared shape.
  if (s.consensus) {
    if (Array.isArray(s.members) && s.members.length > 0) return { count: 1, approximate: true };
    return { count: 1, approximate: true };
  }

  // Motif-style: the best pair is one pattern (two instances).
  if (s.topMotif || s.motif) return { count: 1, approximate: true };

  return undefined;
}

export type RunSortKey = 'date' | 'name' | 'type' | 'status' | 'duration';
export type SortDir = 'asc' | 'desc';

export interface RunParam {
  label: string;
  value: string;
  /** Optional one-line explanation shown on hover / beneath the value. */
  hint?: string;
}

function fmtDateTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

/**
 * Human-readable parameter rows describing how a run was configured. `labelFor` maps a
 * signal id to a friendly name (falls back to the raw id). Only parameters relevant to the
 * job type are included, so single-signal runs don't show empty multi-signal fields.
 */
export function runParameters(
  job: AnalysisJob,
  labelFor: (signalId: string) => string = (id) => id,
): RunParam[] {
  const params: RunParam[] = [];

  const ids = job.signalIds && job.signalIds.length > 0 ? job.signalIds : [job.signalId];
  const names = ids.filter(Boolean).map(labelFor);
  if (names.length > 0) {
    params.push({
      label: names.length > 1 ? `Signals (${names.length})` : 'Signal',
      value: names.join(', '),
    });
  }

  const start = fmtDateTime(job.windowStart) ?? job.windowStart;
  const end = fmtDateTime(job.windowEnd) ?? job.windowEnd;
  if (start && end) params.push({ label: 'Window', value: `${start} → ${end}` });

  if (job.compareSignalId || job.compareWindowStart) {
    const cName = job.compareSignalId ? labelFor(job.compareSignalId) : names[0];
    const cStart = fmtDateTime(job.compareWindowStart);
    const cEnd = fmtDateTime(job.compareWindowEnd);
    const win = cStart && cEnd ? ` · ${cStart} → ${cEnd}` : '';
    params.push({ label: 'Comparison (B)', value: `${cName ?? '—'}${win}` });
  }

  if (typeof job.subLen === 'number' && job.subLen > 0) {
    params.push({
      label: 'Pattern length',
      value: `${job.subLen} samples`,
      hint: 'The stretch length the search looked for.',
    });
  }

  if (typeof job.nDims === 'number' && job.nDims > 0) {
    params.push({
      label: 'Sensors required',
      value: `${job.nDims} of ${ids.length}`,
      hint: 'How many sensors must jointly share the pattern (k of N).',
    });
  }

  if (typeof job.minCount === 'number' && job.minCount > 0) {
    params.push({
      label: 'Consensus threshold',
      value: `at least ${job.minCount} of ${ids.length}`,
      hint: 'Minimum number of series that must contain the shared shape.',
    });
  }

  appendSubmittedParams(job, params);

  return params;
}

/** Friendly label for a make-series aggregate. */
function aggregationLabel(agg: string): string {
  switch (agg) {
    case 'avg':
      return 'Average';
    case 'min':
      return 'Minimum';
    case 'max':
      return 'Maximum';
    case 'sum':
      return 'Sum';
    case 'count':
      return 'Count';
    default:
      return agg;
  }
}

function numAt(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Append rows for the parameters the wizard persisted in `job.params` (packed by
 * `toJobInput`): number of results (`k`), minimum separation (`minlag`, in samples),
 * source resolution (`binSeconds`), aggregation, missing-data handling (`gapFill`), and
 * any Pan-MP length-scan bounds. Labels are jargon-free for the operations-analyst persona.
 */
function appendSubmittedParams(job: AnalysisJob, params: RunParam[]): void {
  const p = job.params;
  if (!p) return;

  const binSeconds = numAt(p, 'binSeconds');

  const k = numAt(p, 'k');
  if (k !== undefined && k > 0) {
    params.push({
      label: 'Results returned',
      value: String(k),
      hint: 'How many of the top patterns the search kept.',
    });
  }

  const minlag = numAt(p, 'minlag');
  if (minlag !== undefined && minlag > 0) {
    const asDuration =
      binSeconds && binSeconds > 0 ? ` (~${formatDuration(minlag * binSeconds)})` : '';
    params.push({
      label: 'Minimum separation',
      value: `${minlag} samples${asDuration}`,
      hint: 'Discovered patterns had to be at least this far apart, so near-duplicates are not counted twice.',
    });
  }

  const lengthMin = numAt(p, 'lengthMin');
  const lengthMax = numAt(p, 'lengthMax');
  if (lengthMin !== undefined && lengthMax !== undefined) {
    const step = numAt(p, 'lengthStep');
    const stepTxt = step && step > 0 ? `, step ${step}` : '';
    params.push({
      label: 'Length scan',
      value: `${lengthMin} → ${lengthMax} samples${stepTxt}`,
      hint: 'Range of pattern lengths the scan tried automatically (Pan Matrix Profile).',
    });
  }

  if (binSeconds !== undefined && binSeconds > 0) {
    params.push({
      label: 'Resolution (bin width)',
      value: formatDuration(binSeconds),
      hint: 'The time each sample represents — the source data was aggregated to this spacing before analysis.',
    });
  }

  const aggregation = typeof p.aggregation === 'string' ? p.aggregation : undefined;
  if (aggregation) {
    params.push({
      label: 'Aggregation',
      value: aggregationLabel(aggregation),
      hint: 'How raw readings were combined into each bin.',
    });
  }

  const gapFill = typeof p.gapFill === 'string' ? p.gapFill : undefined;
  if (gapFill) {
    params.push({
      label: 'Missing data',
      value: gapFill === 'linear' ? 'Filled by interpolation' : 'Left as gaps',
      hint:
        gapFill === 'linear'
          ? 'Gaps between readings were filled with a straight line so the analysis saw a continuous series.'
          : 'Gaps between readings were left in place rather than filled.',
    });
  }
}

/** Stable sort of runs by a column. Undefined durations sort last. */
export function sortRuns(jobs: AnalysisJob[], key: RunSortKey, dir: SortDir): AnalysisJob[] {
  const sign = dir === 'asc' ? 1 : -1;
  const withIndex = jobs.map((j, i) => ({ j, i }));
  withIndex.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'date':
        cmp = runDateMs(a.j) - runDateMs(b.j);
        break;
      case 'name':
        cmp = runTitle(a.j).localeCompare(runTitle(b.j));
        break;
      case 'type':
        cmp = jobTypeLabel(a.j.type).localeCompare(jobTypeLabel(b.j.type));
        break;
      case 'status':
        cmp = a.j.status.localeCompare(b.j.status);
        break;
      case 'duration': {
        const da = runDurationSeconds(a.j);
        const db = runDurationSeconds(b.j);
        if (da === undefined && db === undefined) cmp = 0;
        else if (da === undefined) return 1; // undefined always last
        else if (db === undefined) return -1;
        else cmp = da - db;
        break;
      }
    }
    if (cmp !== 0) return cmp * sign;
    return a.i - b.i; // stable tiebreak
  });
  return withIndex.map((x) => x.j);
}

export interface RunFilter {
  type?: JobType | 'all';
  status?: AnalysisJob['status'] | 'all';
  text?: string;
}

/** Filter runs by type, status, and a free-text match on name / id / type label. */
export function filterRuns(jobs: AnalysisJob[], filter: RunFilter): AnalysisJob[] {
  const { type = 'all', status = 'all', text } = filter;
  const q = (text ?? '').trim().toLowerCase();
  return jobs.filter((j) => {
    if (type !== 'all' && j.type !== type) return false;
    if (status !== 'all' && j.status !== status) return false;
    if (q) {
      const hay = `${runTitle(j)} ${j.id} ${jobTypeLabel(j.type)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
