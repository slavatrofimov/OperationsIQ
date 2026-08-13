/**
 * Descriptive default names for analyses so the run history is readable
 * (e.g. "Repeating patterns · Pump-3 vib · Jul 1–7"). Pure + dependency-free.
 */
import type { JobType } from './types';

const TYPE_LABEL: Record<JobType, string> = {
  MOTIF_MOMP: 'Repeating patterns',
  DISCORD_DAMP: 'Anomalies',
  PAN_MP: 'Auto-find patterns',
  FULL_MP: 'Full similarity scan',
  SEGMENTATION: 'Segmentation',
  CHAIN: 'Trend chains',
  RULE_DISCOVERY: 'Rule discovery',
  CONSENSUS: 'Consensus motifs',
  MULTIDIM: 'Multi-signal motifs',
  MULTIDIM_MOTIF: 'Multi-sensor events',
  MULTIDIM_DISCORD: 'Multi-sensor anomalies',
  MULTIDIM_SEGMENTATION: 'Multi-sensor segments',
  CONSENSUS_MOTIF: 'Fleet-wide shape',
  AB_MOTIF: 'Compare: shared patterns',
  AB_DISCORD: 'Compare: what changed',
};

/** Canonical display order for job types (used by the run-history type filter). */
export const JOB_TYPE_ORDER = Object.keys(TYPE_LABEL) as JobType[];

/** Friendly, jargon-free label for an analysis job type. */
export function jobTypeLabel(type: JobType): string {
  return TYPE_LABEL[type] ?? type;
}

function shortDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Build a friendly default analysis name from the job type, signal, and window. */
export function defaultAnalysisName(input: {
  type?: JobType;
  signalName?: string;
  windowStart?: string;
  windowEnd?: string;
}): string {
  const parts: string[] = [];
  parts.push(input.type ? TYPE_LABEL[input.type] ?? 'Analysis' : 'Analysis');
  if (input.signalName) parts.push(input.signalName);
  const start = shortDate(input.windowStart);
  const end = shortDate(input.windowEnd);
  if (start && end) parts.push(start === end ? start : `${start}–${end}`);
  else if (start) parts.push(start);
  return parts.join(' · ');
}
