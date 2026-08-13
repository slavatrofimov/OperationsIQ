/**
 * Persistence for saved Exploration views via the Rayfin data API
 * (client.data.SavedView). A view captures the selected tags, the time range,
 * and all visualization settings so the user can restore an analysis later.
 * Rows are owned by the signing-in user (SavedView RLS policy).
 */

import { client } from './rayfinClient';
import { getFabricAccountId } from './rayfinClient';
import { getActiveProfileId } from './activeConnection';
import { DEFAULT_SETTINGS, type ExploreSettings } from './exploreSettings';

const CONFIG_VERSION = 1;

/** Serialized Explore state stored in SavedView.config_json. */
export interface ExploreConfigSnapshot {
  version: number;
  tagIds: string[];
  /** ISO 8601, UTC. */
  start: string;
  /** ISO 8601, UTC. */
  end: string;
  settings: ExploreSettings;
}

/** A saved view as surfaced to the UI. */
export interface SavedViewSummary {
  id: string;
  name: string;
  createdAt: Date;
  config: ExploreConfigSnapshot;
}

export interface ExploreState {
  tagIds: string[];
  start: Date;
  end: Date;
  settings: ExploreSettings;
}

function toSnapshot(state: ExploreState): ExploreConfigSnapshot {
  return {
    version: CONFIG_VERSION,
    tagIds: state.tagIds,
    start: state.start.toISOString(),
    end: state.end.toISOString(),
    settings: state.settings,
  };
}

/** Parse a stored config, tolerating older/partial shapes. */
function parseConfig(json: string): ExploreConfigSnapshot | null {
  try {
    const raw = JSON.parse(json) as Partial<ExploreConfigSnapshot>;
    if (!raw || !Array.isArray(raw.tagIds) || !raw.start || !raw.end) return null;
    // Legacy migration: older snapshots stored preferred bin widths in whole
    // seconds (`preferredSeconds` / `detailPreferredSeconds`); convert to the
    // millisecond-canonical fields (×1000) so restored views keep their bins.
    const rawSettings = (raw.settings ?? {}) as Record<string, unknown>;
    const migrated: Record<string, unknown> = { ...rawSettings };
    if (migrated.preferredMillis == null && typeof rawSettings.preferredSeconds === 'number') {
      migrated.preferredMillis = rawSettings.preferredSeconds * 1000;
    }
    if (
      migrated.detailPreferredMillis == null &&
      typeof rawSettings.detailPreferredSeconds === 'number'
    ) {
      migrated.detailPreferredMillis = rawSettings.detailPreferredSeconds * 1000;
    }
    delete migrated.preferredSeconds;
    delete migrated.detailPreferredSeconds;
    return {
      version: raw.version ?? CONFIG_VERSION,
      tagIds: raw.tagIds,
      start: raw.start,
      end: raw.end,
      settings: { ...DEFAULT_SETTINGS, ...migrated },
    };
  } catch {
    return null;
  }
}

/** Persist the current Explore state under a user-chosen name. */
export async function saveView(name: string, state: ExploreState): Promise<void> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before saving a view.');
  await client.data.SavedView.create({
    user_id: userId,
    name,
    config_json: JSON.stringify(toSnapshot(state)),
    connection_profile_id: getActiveProfileId(),
    created_at: new Date(),
  });
}

/** List the current user's saved views, newest first. */
export async function listViews(): Promise<SavedViewSummary[]> {
  const rows = await client.data.SavedView.select([
    'id',
    'name',
    'config_json',
    'created_at',
    'connection_profile_id',
  ]).execute();
  const pid = getActiveProfileId();
  const scoped = pid ? rows.filter((r) => r.connection_profile_id === pid) : rows;
  return scoped
    .map((r) => {
      const config = parseConfig(r.config_json);
      if (!config) return null;
      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
        config,
      } satisfies SavedViewSummary;
    })
    .filter((v): v is SavedViewSummary => v != null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  await client.data.SavedView.delete({ id });
}
