/**
 * Persistence for saved Derived-metric definitions via the Rayfin data API
 * (client.data.SavedDerivedMetric). A definition captures the base tags (in
 * alias order A, B, C…), the arithmetic formula, the post-transform, and the
 * binning budget so the user can reload an analysis on the Derived tab.
 *
 * Derived metrics reference tags that only exist within a given Eventhouse
 * schema, so every definition is scoped to a Connection Profile (`profile_id`)
 * in addition to being owned by the signing-in user (RLS policy).
 */

import { client, getFabricAccountId } from './rayfinClient';

const DEFINITION_VERSION = 1;

/** The post-transform applied to a derived series (mirrors DerivedPage). */
export type DerivedTransform = 'none' | 'roc' | 'rollmean';

/** Serialized derived-metric definition stored in `definition_json`. */
export interface DerivedMetricDefinition {
  version: number;
  /** Base tag ids, in alias order: index 0 → A, 1 → B, … */
  tagIds: string[];
  /** Arithmetic formula referencing the aliases (e.g. "A - B"). */
  formula: string;
  transform: DerivedTransform;
  /** Rolling-mean window in bins (only meaningful when transform === 'rollmean'). */
  window: number;
  /** Bin budget used when fetching the base series. */
  maxBins: number;
}

/** A saved derived metric as surfaced to the UI. */
export interface SavedDerivedMetricSummary {
  id: string;
  name: string;
  createdAt: Date;
  definition: DerivedMetricDefinition;
}

const TRANSFORMS: readonly DerivedTransform[] = ['none', 'roc', 'rollmean'];

/** Parse a stored definition, tolerating older/partial shapes. */
function parseDefinition(json: string): DerivedMetricDefinition | null {
  try {
    const raw = JSON.parse(json) as Partial<DerivedMetricDefinition>;
    if (!raw || !Array.isArray(raw.tagIds) || typeof raw.formula !== 'string') return null;
    const transform = TRANSFORMS.includes(raw.transform as DerivedTransform)
      ? (raw.transform as DerivedTransform)
      : 'none';
    const window = Number.isFinite(raw.window) && (raw.window as number) >= 1 ? Math.floor(raw.window as number) : 5;
    const maxBins =
      Number.isFinite(raw.maxBins) && (raw.maxBins as number) >= 100 ? Math.floor(raw.maxBins as number) : 1500;
    return {
      version: raw.version ?? DEFINITION_VERSION,
      tagIds: raw.tagIds.filter((t): t is string => typeof t === 'string'),
      formula: raw.formula,
      transform,
      window,
      maxBins,
    };
  } catch {
    return null;
  }
}

/**
 * List the current user's saved derived metrics for one Connection Profile,
 * newest first.
 */
export async function listDerivedMetrics(profileId: string): Promise<SavedDerivedMetricSummary[]> {
  if (!profileId) return [];
  const rows = await client.data.SavedDerivedMetric.select([
    'id',
    'name',
    'definition_json',
    'created_at',
  ])
    .where({ profile_id: { eq: profileId } })
    .execute();
  return rows
    .map((r) => {
      const definition = parseDefinition(r.definition_json);
      if (!definition) return null;
      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
        definition,
      } satisfies SavedDerivedMetricSummary;
    })
    .filter((v): v is SavedDerivedMetricSummary => v != null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Save a derived-metric definition under a user-chosen name for a Connection
 * Profile. If a metric with the same (case-insensitive) name already exists for
 * that profile, its definition is overwritten; otherwise a new row is created.
 * Returns the id of the created/updated row.
 */
export async function saveDerivedMetric(
  profileId: string,
  name: string,
  definition: Omit<DerivedMetricDefinition, 'version'>,
): Promise<string> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before saving a derived metric.');
  if (!profileId) throw new Error('Select a connection profile before saving a derived metric.');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Enter a name for the derived metric.');

  const definition_json = JSON.stringify({ version: DEFINITION_VERSION, ...definition });

  const existing = await listDerivedMetrics(profileId);
  const match = existing.find((m) => m.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (match) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.data.SavedDerivedMetric.update({ id: match.id } as any, {
      name: trimmed,
      definition_json,
    } as any);
    return match.id;
  }

  const id = crypto.randomUUID();
  await client.data.SavedDerivedMetric.create({
    id,
    user_id: userId,
    profile_id: profileId,
    name: trimmed,
    definition_json,
    created_at: new Date(),
  });
  return id;
}

/** Delete a saved derived metric by id. */
export async function deleteDerivedMetric(id: string): Promise<void> {
  await client.data.SavedDerivedMetric.delete({ id });
}
