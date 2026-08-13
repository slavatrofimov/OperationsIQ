/**
 * Transparent job-status helpers for Livy-backed analyses (design spec §8).
 *
 * The Patterns tab used to show a bare "Waiting…" spinner forever when a job was stuck.
 * These pure functions turn an {@link AnalysisJob} into a *transparent* status the UI can
 * render: a plain-language label + detail, how long it has been waiting/running, and a
 * heuristic "this looks stuck — troubleshoot it" flag. Mirrors the backend
 * `interpret_livy_status` in `orchestration/fabric_livy.py`.
 *
 * Pure and dependency-free so the logic is testable and reusable across JobPanel,
 * ResultsView, and the diagnostics panel.
 */
import type { AnalysisJob, JobStatus } from './types';
import { formatDuration } from './units';

export type StatusTone = 'informative' | 'important' | 'success' | 'danger' | 'subtle' | 'warning';

/** A job is "stuck starting" if it has been QUEUED longer than this (ms). */
export const STUCK_QUEUED_MS = 90_000;
/** A RUNNING job that runs longer than this (ms) is flagged for a closer look.
 *  Fabric's Livy API does not stream statement progress, so this is based purely
 *  on elapsed running time, not on a progress percentage. */
export const STALLED_RUNNING_MS = 900_000;

export interface JobStatusView {
  /** Short badge label, e.g. "Waiting…", "Analyzing…", "Failed". */
  label: string;
  /** One-line plain-language explanation of what is happening / why it waits. */
  detail: string;
  tone: StatusTone;
  /** Milliseconds since the job was submitted (0 when unknown). */
  elapsedMs: number;
  /** Friendly elapsed string, e.g. "1 min 30 s". */
  elapsedText: string;
  /** True when the job appears stuck and troubleshooting should be surfaced. */
  isStuck: boolean;
  /** True while the job is in a non-terminal state (QUEUED/RUNNING). */
  isActive: boolean;
}

const STATUS_LABEL: Record<JobStatus, string> = {
  QUEUED: 'Waiting…',
  RUNNING: 'Analyzing…',
  SUCCEEDED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Stopped',
};

const STATUS_TONE: Record<JobStatus, StatusTone> = {
  QUEUED: 'informative',
  RUNNING: 'important',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  CANCELLED: 'subtle',
};

/** Humanize a coarse stage string (e.g. "session:starting") for display. */
export function humanizeStage(stage?: string): string | undefined {
  if (!stage) return undefined;
  const map: Record<string, string> = {
    submitting: 'Submitting to Spark',
    'session:not_started': 'Requesting a Spark session',
    'session:starting': 'Starting a Spark session (acquiring capacity)',
    'session:recovering': 'Recovering the Spark session',
    'session:idle': 'Spark session ready',
    'session:busy': 'Spark session busy',
    'session:dead': 'Spark session died',
    'session:error': 'Spark session error',
    'session:killed': 'Spark session was killed',
    'statement:waiting': 'Queued behind another statement',
    'statement:running': 'Analyzing the signal',
    'statement:available': 'Finalizing results',
    'statement:error': 'Analysis reported an error',
    'statement:cancelled': 'Analysis cancelled',
    'statement:cancelling': 'Cancelling the analysis',
  };
  return map[stage] ?? stage;
}

/**
 * Build a transparent status view for a job. ``now`` is injectable for testing /
 * deterministic rendering.
 */
export function describeJobStatus(job: AnalysisJob, now: number = Date.now()): JobStatusView {
  const submittedMs = job.submittedAt ? new Date(job.submittedAt).getTime() : now;
  const startedMs = job.startedAt ? new Date(job.startedAt).getTime() : undefined;
  const elapsedMs = Math.max(0, now - submittedMs);
  const elapsedText = formatDuration(elapsedMs / 1000);

  const isActive = job.status === 'QUEUED' || job.status === 'RUNNING';
  const stageText = humanizeStage(job.stage);

  let label = STATUS_LABEL[job.status] ?? job.status;
  let detail: string;
  let tone: StatusTone = STATUS_TONE[job.status] ?? 'informative';
  let isStuck = false;

  switch (job.status) {
    case 'QUEUED': {
      detail = stageText ?? 'Waiting for a Spark session to start.';
      if (elapsedMs >= STUCK_QUEUED_MS) {
        isStuck = true;
        tone = 'warning';
        label = 'Still waiting';
        detail = `${stageText ?? 'Waiting for a Spark session'} — this is taking longer than usual (${elapsedText}). The session may be waiting for capacity.`;
      }
      break;
    }
    case 'RUNNING': {
      const runningMs = startedMs !== undefined ? Math.max(0, now - startedMs) : elapsedMs;
      const runningText = formatDuration(runningMs / 1000);
      // Fabric's Livy API does not report per-statement progress, so progressPct
      // stays 0 for the whole run. Elapsed time is the only honest signal — show it
      // instead of a misleading 0% bar, and only warn (not "stalled") once a job has
      // run unusually long, pointing at the live driver log / Spark UI to investigate.
      detail = `${stageText ?? 'Analyzing the signal on Spark'} — running for ${runningText}.`;
      if (runningMs >= STALLED_RUNNING_MS) {
        isStuck = true;
        tone = 'warning';
        detail = `${stageText ?? 'Analyzing'} — still running after ${runningText}. This is longer than a typical analysis; open the driver log below, or check the Monitor page in the Microsoft Fabric portal, to see what the statement is doing.`;
      }
      break;
    }
    case 'FAILED':
      detail = job.errorMessage
        ? firstLine(job.errorMessage)
        : 'The analysis failed. Open troubleshooting for the Spark session log.';
      break;
    case 'CANCELLED':
      detail = 'The analysis was stopped.';
      break;
    case 'SUCCEEDED':
    default:
      detail = 'Analysis complete.';
      break;
  }

  return { label, detail, tone, elapsedMs, elapsedText, isStuck, isActive };
}

/** Parse the stored (newline-joined) driver log tail into lines for display. */
export function parseDriverLog(job: AnalysisJob): string[] {
  if (!job.driverLogTail) return [];
  return job.driverLogTail.split('\n').filter((l) => l.trim().length > 0);
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx >= 0 ? text.slice(0, idx) : text;
}
