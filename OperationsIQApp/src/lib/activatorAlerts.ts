/**
 * Activator Alert pointer CRUD, backed by the Rayfin data API
 * (client.data.ActivatorAlert). These rows are POINTERS only: they record
 * enough to list an alert and deep-link into the Fabric portal. Deleting a
 * pointer removes ONLY the app record — it never deletes the Fabric Reflex
 * item, its rule, or its schedule.
 */

import { client, getFabricAccountId } from './rayfinClient';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Snapshot of the search settings that produced an alert, for reproducibility. */
export interface ActivatorAlertParamsSnapshot {
  mode: 'single' | 'multidim' | 'anomaly';
  binLabel: string;
  frequency: string;
  lookbackSeconds: number;
  minSimilarity?: number;
  sax?: Record<string, unknown>;
  algorithm?: string;
  detectionBins?: number;
  /** MVAD severity gate (ratio; 1 = every detected anomaly). */
  minSeverity?: number;
}

/** An Activator alert pointer as used throughout the client code. */
export interface ActivatorAlert {
  id: string;
  userId: string;
  workspaceId: string;
  reflexItemId: string;
  displayName: string;
  webUrl: string;
  connectionProfileName: string;
  tags: string[];
  frequency: string;
  searchParams?: ActivatorAlertParamsSnapshot;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  user_id: string;
  workspace_id: string;
  reflex_item_id: string;
  display_name: string;
  web_url: string;
  connection_profile_name: string;
  tags_json: string;
  frequency: string;
  search_params_json?: string | null;
  created_at: Date | string;
}

function parseTags(json: string): string[] {
  try {
    const raw = JSON.parse(json);
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

function parseParams(json?: string | null): ActivatorAlertParamsSnapshot | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ActivatorAlertParamsSnapshot;
  } catch {
    return undefined;
  }
}

function fromRow(r: DbRow): ActivatorAlert {
  return {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    reflexItemId: r.reflex_item_id,
    displayName: r.display_name,
    webUrl: r.web_url,
    connectionProfileName: r.connection_profile_name,
    tags: parseTags(r.tags_json),
    frequency: r.frequency,
    searchParams: parseParams(r.search_params_json),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
  };
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/** List all Activator alert pointers for the current user, newest first. */
export async function listActivatorAlerts(): Promise<ActivatorAlert[]> {
  const rows = await client.data.ActivatorAlert.select([
    'id',
    'user_id',
    'workspace_id',
    'reflex_item_id',
    'display_name',
    'web_url',
    'connection_profile_name',
    'tags_json',
    'frequency',
    'search_params_json',
    'created_at',
  ]).execute();

  return (rows as DbRow[])
    .map(fromRow)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Persist a new Activator alert pointer. Returns the created row's id. */
export async function saveActivatorAlert(
  data: Omit<ActivatorAlert, 'id' | 'userId' | 'createdAt'>,
): Promise<string> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before saving an Activator alert.');
  const id = crypto.randomUUID();
  await client.data.ActivatorAlert.create({
    id,
    user_id: userId,
    workspace_id: data.workspaceId,
    reflex_item_id: data.reflexItemId,
    display_name: data.displayName,
    web_url: data.webUrl,
    connection_profile_name: data.connectionProfileName,
    tags_json: JSON.stringify(data.tags),
    frequency: data.frequency,
    search_params_json: data.searchParams ? JSON.stringify(data.searchParams) : undefined,
    created_at: new Date(),
  });
  return id;
}

/**
 * Delete an Activator alert POINTER by id. This removes ONLY the app-side
 * record — the Fabric Reflex item and its rule are left untouched.
 */
export async function deleteActivatorAlert(id: string): Promise<void> {
  await client.data.ActivatorAlert.delete({ id });
}
