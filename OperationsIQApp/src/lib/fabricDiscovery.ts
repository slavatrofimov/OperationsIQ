/**
 * Fabric workspace and Eventhouse discovery helpers. Uses the Fabric REST API
 * to enumerate workspaces, Eventhouse items, and KQL databases. All failures
 * are swallowed — callers fall back to
 * manual input when discovery is unavailable (e.g. token scopes not consented,
 * network unreachable, or app running outside Fabric).
 */

import { getFabricApiToken, getFabricWriteToken } from './msal';
import { env } from './env';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface FabricWorkspace {
  id: string;
  displayName: string;
}

export interface FabricEventhouse {
  id: string;
  displayName: string;
  queryServiceUri: string;
}

export interface FabricKqlDatabase {
  /** Fabric item id of the KQL database — used as eventhouseItem.itemId /
   *  metadata.querySetId in a Reflex kqlSource entity. */
  id: string;
  displayName: string;
}

export interface FabricReflex {
  id: string;
  displayName: string;
}

/** Result of creating a Reflex (Activator) item. */
export interface CreatedReflex {
  id: string;
  displayName: string;
  /** Deep link that opens the Activator item in the Fabric portal. */
  webUrl: string;
}

// ---------------------------------------------------------------------------
// Fabric REST helpers
// ---------------------------------------------------------------------------

async function fabricGet<T>(path: string, opts: { interactive?: boolean } = {}): Promise<T> {
  const token = await getFabricApiToken(opts);
  const response = await fetch(`https://api.fabric.microsoft.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Fabric API error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  }
  return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Discovery functions
// ---------------------------------------------------------------------------

/**
 * List all Fabric workspaces accessible to the current user.
 *
 * Pass `{ interactive: true }` from a user-gesture handler (the "Discover from
 * Fabric" button) to prompt for account selection + consent to the Fabric read
 * scopes. In interactive mode errors PROPAGATE so the UI can show the real
 * reason (consent declined, admin-consent required, no access, etc.); in silent
 * mode failures return `[]` for graceful degradation to manual entry.
 */
export async function listFabricWorkspaces(
  opts: { interactive?: boolean } = {},
): Promise<FabricWorkspace[]> {
  try {
    const data = await fabricGet<{ value: Array<{ id: string; displayName: string }> }>('/workspaces', opts);
    return (data.value ?? [])
      .map((w) => ({ id: w.id, displayName: w.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
  } catch (e) {
    if (opts.interactive) throw e;
    return [];
  }
}

/** List Eventhouse items in a Fabric workspace. Returns [] on error.
 *
 * Uses the dedicated `/eventhouses` endpoint (not the generic `/items?type=…`)
 * because only the dedicated endpoint returns `properties.queryServiceUri`,
 * which is the Kusto cluster URI the app queries against.
 */
export async function listEventhouses(
  workspaceId: string,
  opts: { interactive?: boolean } = {},
): Promise<FabricEventhouse[]> {
  try {
    const data = await fabricGet<{
      value: Array<{
        id: string;
        displayName: string;
        properties?: { queryServiceUri?: string };
      }>;
    }>(`/workspaces/${workspaceId}/eventhouses`, opts);

    return (data.value ?? [])
      .filter((item) => item.properties?.queryServiceUri)
      .map((item) => ({
        id: item.id,
        displayName: item.displayName,
        queryServiceUri: item.properties!.queryServiceUri!.replace(/\/+$/, ''),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
  } catch (e) {
    if (opts.interactive) throw e;
    return [];
  }
}

/**
 * List the KQL database names belonging to an Eventhouse.
 *
 * Uses only the Fabric `/kqlDatabases` REST endpoint, filtered to the parent
 * Eventhouse. This reuses the already-consented Fabric token and needs no Kusto
 * management-command access. Returns [] on error so the caller degrades to
 * manual entry.
 */
export async function listKqlDatabases(
  workspaceId: string,
  eventhouseId: string,
): Promise<string[]> {
  const items = await listKqlDatabaseItems(workspaceId, eventhouseId);
  return items.map((d) => d.displayName);
}

/**
 * List the KQL databases (id + displayName) belonging to an Eventhouse.
 *
 * Same source/endpoint as {@link listKqlDatabases}, but also surfaces the Fabric
 * item `id`, which is required to build a Reflex `kqlSource` entity
 * (eventhouseItem.itemId and metadata.querySetId both point at the KQL database
 * item id). Returns [] on error so callers degrade to manual entry.
 */
export async function listKqlDatabaseItems(
  workspaceId: string,
  eventhouseId: string,
): Promise<FabricKqlDatabase[]> {
  try {
    const data = await fabricGet<{
      value: Array<{
        id: string;
        displayName: string;
        properties?: { parentEventhouseItemId?: string };
      }>;
    }>(`/workspaces/${workspaceId}/kqlDatabases`);
    return (data.value ?? [])
      .filter((d) => d.properties?.parentEventhouseItemId === eventhouseId)
      .filter((d) => d.id && d.displayName)
      .map((d) => ({ id: d.id, displayName: d.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Activator (Reflex) write helpers
// ---------------------------------------------------------------------------

/**
 * Parse a fetch Response body as JSON, tolerating an EMPTY body. Several Fabric
 * write operations are "void" long-running operations — e.g. Reflex
 * `updateDefinition` (used when APPENDING a rule to an existing Activator) —
 * that return `200`/`202` (and a `/result` resource) with NO response body. A
 * bare `response.json()` on such a response runs `JSON.parse('')` and throws
 * `Unexpected end of JSON input`, which surfaced as an "add rule to an existing
 * Activator" failure even though the update actually succeeded. Returns an empty
 * object (cast to `T`) when the body is empty or whitespace-only.
 */
export async function readJsonBody<T>(response: Response): Promise<T> {
  const text = await response.text();
  return text.trim() ? (JSON.parse(text) as T) : ({} as T);
}

/**
 * POST to the Fabric REST API with a WRITE-scoped token and resolve the
 * long-running-operation (LRO) it may start.
 *
 * Fabric item-create endpoints return either:
 *  - `201 Created` with the finished item in the body (fast path), or
 *  - `202 Accepted` with a `Location` header (+ `x-ms-operation-id`) pointing at
 *    an operation resource that must be polled until it reaches a terminal
 *    state. On `Succeeded` the item is fetched from `Location/result`.
 *
 * Returns the created item body (`{ id, displayName, ... }`). Throws on any
 * non-2xx response or a `Failed`/timed-out operation. Interactive by default so
 * the consent popup can be shown from the triggering user gesture.
 */
async function fabricPostLro<T>(
  path: string,
  body: unknown,
  opts: { interactive?: boolean } = { interactive: true },
): Promise<T> {
  const token = await getFabricWriteToken(opts);
  const response = await fetch(`https://api.fabric.microsoft.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 201 || response.status === 200) {
    return readJsonBody<T>(response);
  }

  if (response.status === 202) {
    const location = response.headers.get('Location') ?? response.headers.get('location');
    if (!location) {
      // Some gateways return 202 with the body already populated.
      return response.json().catch(() => ({})) as Promise<T>;
    }
    const retryAfter = Number(response.headers.get('Retry-After')) || 2;
    return pollFabricOperation<T>(location, token, retryAfter);
  }

  throw new Error(
    `Fabric API error ${response.status}: ${await response.text().catch(() => response.statusText)}`,
  );
}

/** Poll a Fabric LRO `Location` URL until it reaches a terminal state. */
async function pollFabricOperation<T>(
  location: string,
  token: string,
  retryAfterSec: number,
): Promise<T> {
  const deadline = Date.now() + 5 * 60_000; // 5 minute cap
  let delay = Math.max(1, retryAfterSec) * 1000;
  // The operation URL may be absolute (Location header) — use it verbatim.
  const opUrl = location.startsWith('http')
    ? location
    : `https://api.fabric.microsoft.com${location}`;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(opUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Fabric operation poll error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
    }
    const op = (await res.json()) as { status?: string; error?: unknown };
    const status = (op.status ?? '').toLowerCase();
    if (status === 'succeeded') {
      // Fetch the operation result (the created item).
      const resultUrl = opUrl.replace(/\/?$/, '') + '/result';
      const resultRes = await fetch(resultUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resultRes.ok) {
        return readJsonBody<T>(resultRes);
      }
      // Fall back to the operation body if no /result is exposed.
      return op as unknown as T;
    }
    if (status === 'failed') {
      throw new Error(`Fabric operation failed: ${JSON.stringify(op.error ?? op)}`);
    }
    const nextRetry = Number(res.headers.get('Retry-After'));
    if (nextRetry) delay = nextRetry * 1000;
  }
  throw new Error('Fabric operation timed out waiting for completion.');
}

/**
 * List Activator (Reflex) items in a workspace so the user can save an alert
 * into an existing Activator. Returns [] on error (degrade to "create new").
 */
export async function listReflexes(
  workspaceId: string,
  opts: { interactive?: boolean } = {},
): Promise<FabricReflex[]> {
  try {
    const data = await fabricGet<{ value: Array<{ id: string; displayName: string }> }>(
      `/workspaces/${workspaceId}/reflexes`,
      opts,
    );
    return (data.value ?? [])
      .filter((r) => r.id && r.displayName)
      .map((r) => ({ id: r.id, displayName: r.displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
  } catch (e) {
    if (opts.interactive) throw e;
    return [];
  }
}

/**
 * Create a new Activator (Reflex) item carrying the supplied definition (two
 * base64-encoded parts: `ReflexEntities.json` and `.platform`). Resolves the
 * create LRO and returns the new item id + a portal deep link.
 */
export async function createReflex(
  workspaceId: string,
  input: {
    displayName: string;
    description?: string;
    definition: {
      parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }>;
    };
  },
): Promise<CreatedReflex> {
  const created = await fabricPostLro<{ id: string; displayName?: string }>(
    `/workspaces/${workspaceId}/reflexes`,
    {
      displayName: input.displayName,
      description: input.description,
      definition: input.definition,
    },
  );
  const id = created.id;
  return {
    id,
    displayName: created.displayName ?? input.displayName,
    webUrl: reflexWebUrl(workspaceId, id),
  };
}

/** Build a Fabric portal deep link that opens a Reflex (Activator) item. */
export function reflexWebUrl(workspaceId: string, itemId: string): string {
  const portal = (env.fabricPortalUrl ?? 'https://app.fabric.microsoft.com').replace(/\/+$/, '');
  return `${portal}/groups/${workspaceId}/reflexes/${itemId}`;
}

/** The base64 definition parts of a Reflex item, as returned by getDefinition. */
export interface ReflexDefinitionParts {
  parts: Array<{ path: string; payload: string; payloadType: string }>;
}

/**
 * Fetch an existing Reflex item's definition (the base64 `ReflexEntities.json` +
 * `.platform` parts). Used to APPEND a new rule to an existing Activator without
 * disturbing its current entities. Resolves the getDefinition LRO.
 */
export async function getReflexDefinition(
  workspaceId: string,
  itemId: string,
): Promise<ReflexDefinitionParts> {
  const res = await fabricPostLro<{ definition?: ReflexDefinitionParts } & ReflexDefinitionParts>(
    `/workspaces/${workspaceId}/reflexes/${itemId}/getDefinition`,
    {},
  );
  // getDefinition may nest under `definition` or return it at the top level.
  return res.definition ?? { parts: res.parts ?? [] };
}

/**
 * Replace an existing Reflex item's definition with `definition` (base64 parts).
 * Used together with {@link getReflexDefinition} to append a rule to an existing
 * Activator. Resolves the updateDefinition LRO.
 */
export async function updateReflexDefinition(
  workspaceId: string,
  itemId: string,
  definition: {
    parts: Array<{ path: string; payload: string; payloadType: 'InlineBase64' }>;
  },
): Promise<void> {
  await fabricPostLro<unknown>(
    `/workspaces/${workspaceId}/reflexes/${itemId}/updateDefinition`,
    { definition },
  );
}
