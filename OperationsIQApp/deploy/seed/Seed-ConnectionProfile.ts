/**
 * M4 seed step: create (or update) a ConnectionProfile row via the RayFin data
 * API so a freshly deployed app opens ready-to-use against the sample /
 * retrofit Eventhouse.
 *
 * Runs headlessly in Node via vite-node with the provisioning stub config (so
 * the browser-only `rayfinClient`/`msal` leaves resolve to Node-safe stubs):
 *
 *   npx vite-node --config scripts/provision.vite.config.ts \
 *     deploy/seed/Seed-ConnectionProfile.ts
 *
 * It uses the server-oriented {@link RayfinServerClient} (token-based auth, no
 * browser MSAL). Because the `ConnectionProfile` row-level-security policy is
 * `claims.sub == item.user_id`, the row is owned by the identity behind the
 * supplied token — decode that identity from the JWT and stamp it as `user_id`
 * so the create satisfies the policy and the profile is visible to the operator.
 *
 * Inputs (environment variables; the M4 module sets these):
 *   SEED_RAYFIN_API_URL         (required) RayFin data API base url.
 *   SEED_RAYFIN_PUBLISHABLE_KEY (required) RayFin publishable key.
 *   SEED_EVENTHOUSE_QUERY_URI   (required) Eventhouse cluster query uri.
 *   SEED_COMPANION_DB           (required) Database the profile points at.
 *   SEED_SOURCE_DB              (retrofit) Source DB read cross-database.
 *   SEED_MODE                   'greenfield-sample' | 'retrofit' (default retrofit).
 *   SEED_PROFILE_NAME           Display name (default 'Sample (Contoso)').
 *   SEED_DESCRIPTION            Optional free-text description.
 *   SEED_FABRIC_WORKSPACE_ID / SEED_EVENTHOUSE_ID / SEED_KQL_DATABASE_ID  Optional ids.
 *   SEED_ACCESS_TOKEN           Bearer token for the RayFin API. If absent, the
 *                               script acquires one with `az account get-access-token
 *                               --resource $SEED_TOKEN_RESOURCE`.
 *   SEED_TOKEN_RESOURCE         Azure resource/audience for the az token fallback.
 *   SEED_DRY_RUN                '1'/'true' -> print the payload, do not write.
 */
import { execFileSync } from 'node:child_process';

import { RayfinServerClient } from '@microsoft/rayfin-client';
import type { OperationsIqAppSchema } from '../../rayfin/data/schema.js';
import {
  DEFAULT_LABELS,
  DEFAULT_HIERARCHY_QUERY,
  DEFAULT_METADATA_QUERY,
  DEFAULT_EVENTS_QUERY,
  DEFAULT_TIMESERIES_QUERY,
  buildRetrofitSourceQueries,
} from '../../src/lib/connectionProfile';

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${name}.`);
  return v.trim();
}

function opt(name: string, fallback = ''): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function truthy(v: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Build the four canonical queries for the chosen mode. */
export function buildQuerySet(mode: string, companionDb: string, sourceDb: string) {
  if (mode === 'retrofit') {
    const src = (sourceDb || companionDb).trim();
    // Cross-database retrofit templates read the raw tables from the source DB.
    return { ...buildRetrofitSourceQueries(src), timeseriesIsWide: false };
  }
  // greenfield-sample: base tables live directly in the companion/sample DB.
  return {
    hierarchyQuery: DEFAULT_HIERARCHY_QUERY,
    metadataQuery: DEFAULT_METADATA_QUERY,
    eventsQuery: DEFAULT_EVENTS_QUERY,
    timeseriesQuery: DEFAULT_TIMESERIES_QUERY,
    timeseriesIsWide: false,
  };
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

/** Acquire a bearer token: explicit env value, else `az account get-access-token`. */
function acquireToken(): string {
  const explicit = opt('SEED_ACCESS_TOKEN');
  if (explicit) return explicit;
  const resource = opt('SEED_TOKEN_RESOURCE');
  if (!resource) {
    throw new Error(
      'No token available: set SEED_ACCESS_TOKEN, or set SEED_TOKEN_RESOURCE so the ' +
        'script can run `az account get-access-token --resource <resource>`.',
    );
  }
  try {
    const out = execFileSync(
      'az',
      ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(out) as { accessToken?: string };
    if (!parsed.accessToken) throw new Error('az returned no accessToken.');
    return parsed.accessToken;
  } catch (err) {
    throw new Error(`Failed to acquire an access token via az CLI: ${(err as Error).message}`);
  }
}

/** Decode the `oid`/`sub` claim from a JWT to use as the owning user_id. */
export function subjectFromToken(token: string): string {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Access token is not a JWT (cannot read owner id).');
  const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
  const claims = JSON.parse(payloadJson) as { oid?: string; sub?: string };
  const id = claims.oid ?? claims.sub;
  if (!id) throw new Error('Token has neither an `oid` nor a `sub` claim to own the profile.');
  return id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dryRun = truthy(opt('SEED_DRY_RUN'));

  const apiUrl = req('SEED_RAYFIN_API_URL');
  const publishableKey = req('SEED_RAYFIN_PUBLISHABLE_KEY');
  const queryUri = req('SEED_EVENTHOUSE_QUERY_URI');
  const companionDb = req('SEED_COMPANION_DB');
  const sourceDb = opt('SEED_SOURCE_DB');
  const mode = opt('SEED_MODE', 'retrofit');
  const name = opt('SEED_PROFILE_NAME', 'Sample (Contoso)');
  const description = opt('SEED_DESCRIPTION');
  const fabricWorkspaceId = opt('SEED_FABRIC_WORKSPACE_ID');
  const eventhouseId = opt('SEED_EVENTHOUSE_ID');
  const kqlDatabaseId = opt('SEED_KQL_DATABASE_ID');

  const queries = buildQuerySet(mode, companionDb, sourceDb);

  // Build the DB row (snake_case, matching the RayFin entity fields).
  const nowIso = new Date().toISOString();
  const baseRow = {
    name,
    description: description || undefined,
    eventhouse_query_uri: queryUri,
    database_name: companionDb,
    fabric_workspace_id: fabricWorkspaceId || undefined,
    eventhouse_id: eventhouseId || undefined,
    kql_database_id: kqlDatabaseId || undefined,
    hierarchy_query: queries.hierarchyQuery,
    metadata_query: queries.metadataQuery,
    events_query: queries.eventsQuery,
    timeseries_query: queries.timeseriesQuery,
    timeseries_is_wide: queries.timeseriesIsWide,
    labels_json: JSON.stringify(DEFAULT_LABELS),
  };

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(
      `RESULT_JSON=${JSON.stringify({ mode, name, database: companionDb, dryRun: true, row: baseRow })}`,
    );
    return;
  }

  const token = acquireToken();
  const userId = subjectFromToken(token);

  const client = new RayfinServerClient<OperationsIqAppSchema>({
    baseUrl: apiUrl,
    publishableKey,
    accessToken: () => token,
  });

  // Idempotent upsert: match an existing profile by (user_id, name).
  const existing = (await client.data.ConnectionProfile.select(['id', 'name'])
    .where({ user_id: { eq: userId }, name: { eq: name } })
    .execute()) as Array<{ id: string; name: string }>;

  let id: string;
  let action: 'created' | 'updated';
  if (existing.length > 0) {
    id = existing[0].id;
    action = 'updated';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.data.ConnectionProfile.update({ id } as any, baseRow as any);
  } else {
    id = (globalThis.crypto?.randomUUID?.() ?? randomUuidFallback());
    action = 'created';
    await client.data.ConnectionProfile.create({
      id,
      user_id: userId,
      created_at: nowIso,
      ...baseRow,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  // eslint-disable-next-line no-console
  console.log(`RESULT_JSON=${JSON.stringify({ id, action, mode, name, database: companionDb })}`);
}

/** RFC4122 v4 fallback when crypto.randomUUID is unavailable. */
function randomUuidFallback(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Only run the deployment side-effect when invoked as a script (not when the
// module is imported by a test).
if (!process.env.VITEST) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`Seed-ConnectionProfile failed: ${(err as Error).message}`);
    process.exit(1);
  });
}