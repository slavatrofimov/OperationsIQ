import { RayfinClient } from '@microsoft/rayfin-client';
import { ensureSignedInWithFabric } from '@microsoft/rayfin-auth-provider-fabric';
import type { OperationsIqAppSchema } from '../../rayfin/data/schema.js';
import { env } from './env';

/**
 * The Rayfin data + auth client. Handles Fabric SSO identity and all GraphQL
 * persistence (SavedView, VsmModel, Investigation, ...). This client is scoped
 * to the app's own backend only — it does NOT reach the Eventhouse. Kusto
 * access goes through msal.ts instead (see architecture note in README).
 *
 * Note: adjust the generic/constructor to match the exact RayfinClient signature
 * pinned by your scaffolded project version if the compiler flags a mismatch.
 */
export const client = new RayfinClient<OperationsIqAppSchema>({
  baseUrl: env.rayfinApiUrl,
  publishableKey: env.rayfinPublishableKey,
});

/** Options identifying the deployed Fabric App item for the SSO handoff. */
export const fabricAuthOptions = {
  workspaceId: env.fabricWorkspaceId,
  projectId: env.fabricItemId,
  fabricPortalUrl: env.fabricPortalUrl,
  returnOrigin: window.location.origin,
};

/**
 * Sign the user in with Fabric SSO. MUST be called from a user-gesture handler
 * (e.g. a button click) so the browser allows the auth popup.
 */
export async function signInWithFabric(): Promise<void> {
  await ensureSignedInWithFabric(client.auth, fabricAuthOptions);
}

/**
 * Best-effort establishment of the Fabric SSO session for the data/persistence
 * client. When the app runs hosted inside Fabric this completes silently, so
 * saved-views features can light up without an extra sign-in gesture. Any
 * failure (e.g. a blocked popup in local dev) is swallowed; the caller should
 * fall back to reading {@link getFabricAccountId}. Returns whether a session is
 * active afterwards.
 */
export async function ensureFabricSession(): Promise<boolean> {
  try {
    await ensureSignedInWithFabric(client.auth, fabricAuthOptions);
  } catch {
    // Silent SSO unavailable; leave it to an explicit gesture elsewhere.
  }
  return !!getFabricAccountId();
}

/**
 * The email of the current Fabric-SSO account, when a session is active. Used as
 * a `loginHint` for the separate Eventhouse (Kusto) MSAL sign-in so the user is
 * pre-selected on the correct identity instead of the wrong signed-in account.
 * Returns `undefined` when no Rayfin session is available.
 */
export function getFabricAccountEmail(): string | undefined {
  try {
    return client.auth.getSession().user?.email ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The id of the current Fabric-SSO user, when a session is active. Used to stamp
 * ownership on records the app creates (e.g. SavedView.user_id) so the backend
 * row-level security policy scopes them to the signing-in user. Returns
 * `undefined` when no Rayfin session is available.
 */
export function getFabricAccountId(): string | undefined {
  try {
    return client.auth.getSession().user?.id ?? undefined;
  } catch {
    return undefined;
  }
}

export async function signOut(): Promise<void> {
  await client.auth.signOut();
}
