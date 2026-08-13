/**
 * Traceability / provenance helpers (functional spec: every derived output must
 * be auditable). Builds a {@link Provenance} descriptor for a computed result
 * and persists it to the `model_outputs` table via the Rayfin data client.
 *
 * The same {@link Provenance} shape drives the {@link ProvenanceChip} UI so the
 * user always sees "which model, which version, over which window, generated
 * when" next to any forecast / anomaly / root-cause / scenario result.
 */

import { client, getFabricAccountId } from './rayfinClient';

/** The kinds of derived output the app can produce. */
export type ModelOutputType =
  | 'forecast'
  | 'anomaly'
  | 'root_cause'
  | 'scenario'
  | 'signal_validation'
  | 'causality';

/** Lightweight provenance descriptor attached to any derived result. */
export interface Provenance {
  outputType: ModelOutputType;
  tagId?: string;
  modelName: string;
  modelVersion: string;
  featureVersion: string;
  /** Inclusive start of the source data window. */
  sourceWindowStart: Date;
  /** Exclusive end of the source data window. */
  sourceWindowEnd: Date;
  /** Event time the output pertains to (forecast origin, incident time, ...). */
  eventTime: Date;
  /** Wall-clock generation time. Defaults to now if omitted. */
  generatedAt?: Date;
  /** Optional small summary object (params + headline results). */
  summary?: Record<string, unknown>;
  /** Optional pointer to a larger result artifact. */
  resultKey?: string;
}

/**
 * The current feature/template version. Bump when the KQL builders or feature
 * derivation change in a way that affects reproducibility.
 */
export const FEATURE_VERSION = '1';

/** Build a Provenance descriptor, filling generatedAt with the current time. */
export function buildProvenance(input: Provenance): Provenance {
  return { generatedAt: new Date(), ...input };
}

/** Format a Provenance into a compact one-line label for tooltips/exports. */
export function describeProvenance(p: Provenance): string {
  const gen = (p.generatedAt ?? new Date()).toISOString();
  return (
    `${p.modelName}@${p.modelVersion} · features v${p.featureVersion} · ` +
    `window ${p.sourceWindowStart.toISOString()}→${p.sourceWindowEnd.toISOString()} · ` +
    `generated ${gen}`
  );
}

/**
 * Persist a provenance record to `model_outputs`. Best-effort: when no Fabric
 * session is available (e.g. local dev without SSO) the write is skipped and
 * `undefined` is returned rather than throwing, so read-only analysis still
 * works. Returns the created record id when written.
 */
export async function writeModelOutput(p: Provenance): Promise<string | undefined> {
  const userId = getFabricAccountId();
  if (!userId) return undefined;
  const now = p.generatedAt ?? new Date();
  const created = await client.data.ModelOutput.create({
    user_id: userId,
    output_type: p.outputType,
    tag_id: p.tagId,
    model_name: p.modelName,
    model_version: p.modelVersion,
    feature_version: p.featureVersion,
    source_window_start: p.sourceWindowStart,
    source_window_end: p.sourceWindowEnd,
    event_time: p.eventTime,
    generated_at: now,
    summary_json: p.summary ? JSON.stringify(p.summary) : undefined,
    result_key: p.resultKey,
  });
  return (created as { id?: string })?.id;
}
