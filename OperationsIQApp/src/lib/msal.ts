import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
} from '@azure/msal-browser';
import { env } from './env';
import { selectEventhouseAccount, sameIdentity } from './msalIdentity';

export { selectEventhouseAccount, sameIdentity };

/**
 * Second auth context: a public SPA client (its own Entra app registration, no
 * secret, PKCE) used ONLY to acquire a Kusto-audience access token so the
 * browser can query the Eventhouse directly. The user's delegated token means
 * Eventhouse RLS / database roles are honored. Keep this separate from the
 * Rayfin/Fabric SSO session (rayfinClient.ts).
 */
const msalInstance = new PublicClientApplication({
  auth: {
    clientId: env.msalClientId,
    authority: `https://login.microsoftonline.com/${env.msalTenantId}`,
    // Dedicated blank page (public/blank.html) as the redirect target. Silent
    // token renewal runs in a hidden iframe that navigates to redirectUri; if
    // that were the SPA origin, the full app would reload inside the iframe and
    // MSAL would throw `block_iframe_reload` (worse when embedded in the Fabric
    // portal iframe). A lightweight blank page avoids the reload. This URI must
    // be registered as a redirect URI on the SPA app registration.
    redirectUri: `${window.location.origin}/blank.html`,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
});

// Fabric REST API delegated scopes acquired for workspace/Eventhouse discovery
// ("Discover from Fabric"). Explicit resource scopes (rather than `.default`)
// let the SPA use incremental / dynamic consent: on first use the user is
// prompted to consent to just these read scopes, without the permissions having
// to be pre-added to the app registration or admin-consented ahead of time.
// `.default` would instead fail silently for any user who has not already had
// the (statically configured) permissions consented, which is the common case.
export const FABRIC_API_READ_SCOPES = [
  'https://api.fabric.microsoft.com/Workspace.Read.All',
  'https://api.fabric.microsoft.com/Item.Read.All',
];

// Fabric REST API delegated WRITE scope. Required to create Activator (Reflex)
// items via `POST /workspaces/{id}/reflexes`. Requested via the same
// incremental / dynamic consent flow as the read scopes: the user is prompted to
// approve it the first time they create an alert, so it never has to be
// pre-added to the app registration or admin-consented ahead of time (unless the
// tenant requires admin consent). The read scopes are kept alongside it so a
// single consent covers discovery + create.
export const FABRIC_API_WRITE_SCOPES = [
  ...FABRIC_API_READ_SCOPES,
  'https://api.fabric.microsoft.com/Item.ReadWrite.All',
];

// Fabric Livy API delegated scopes. The SPA submits Spark session jobs and
// polls their status directly against the Fabric Livy endpoint, so the user's
// delegated token must carry these. Requested separately from the read/write
// scopes above (least privilege) via the same incremental/dynamic consent: the
// user is prompted to approve them the first time they submit an analysis, so
// they never have to be pre-added to the app registration or admin-consented
// ahead of time (unless the tenant requires admin consent).
//
// Required for every Livy API operation
// (https://learn.microsoft.com/fabric/data-engineering/get-started-api-livy):
//   Lakehouse.Execute.All            - execute operations in the lakehouse
//                                       (create Livy sessions, submit statements)
//   Lakehouse.Read.All               - read lakehouse metadata (discover the
//                                       Livy endpoint)
//   Code.AccessFabric.All            - required for ALL Livy API operations
//   Code.AccessStorage.All           - read/write lakehouse (OneLake) data
//   Code.AccessAzureDataExplorer.All - the pattern-finding Spark job ingests its
//                                       results into the Eventhouse (Kusto / Azure
//                                       Data Explorer), so the runtime needs an
//                                       ADX token on the user's behalf
export const FABRIC_LIVY_SCOPES = [
  'https://api.fabric.microsoft.com/Lakehouse.Execute.All',
  'https://api.fabric.microsoft.com/Lakehouse.Read.All',
  'https://api.fabric.microsoft.com/Code.AccessFabric.All',
  'https://api.fabric.microsoft.com/Code.AccessStorage.All',
  'https://api.fabric.microsoft.com/Code.AccessAzureDataExplorer.All',
];

/**
 * Thrown when a Kusto token cannot be obtained without user interaction. An
 * interactive sign-in opens a popup, which browsers block unless it is started
 * from a user gesture — and which is also blocked when the app is embedded in
 * the Fabric portal iframe. Callers must catch this and surface a "Sign in"
 * button that calls {@link signInForEventhouse} from the click handler.
 */
export class EventhouseSignInRequiredError extends Error {
  constructor() {
    super('Eventhouse sign-in required');
    this.name = 'EventhouseSignInRequiredError';
  }
}

// Listeners notified when an interactive sign-in becomes necessary (silent
// token acquisition failed, or a query returned 401/403). The AuthContext
// subscribes so a mid-session token expiry re-shows the sign-in gate instead of
// surfacing an opaque error or triggering a blocked auto-popup.
type SignInRequiredListener = () => void;
const signInRequiredListeners = new Set<SignInRequiredListener>();

/** Subscribe to sign-in-required events. Returns an unsubscribe function. */
export function onEventhouseSignInRequired(listener: SignInRequiredListener): () => void {
  signInRequiredListeners.add(listener);
  return () => {
    signInRequiredListeners.delete(listener);
  };
}

/** Notify subscribers that an interactive Eventhouse sign-in is required. */
export function notifyEventhouseSignInRequired(): void {
  signInRequiredListeners.forEach((l) => l());
}

let initPromise: Promise<void> | null = null;
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = msalInstance.initialize();
  }
  return initPromise;
}

// --- Identity alignment with the Fabric/Rayfin SSO session ------------------
// The Eventhouse (Kusto) MSAL session is deliberately separate from the
// Fabric/Rayfin SSO session (rayfinClient.ts). In a multi-account browser MSAL
// could therefore cache a *different* identity than the one Rayfin/Fabric writes
// run under, so Eventhouse reads would happen under the wrong user (RLS still
// applies, but to the wrong account) — an audit and data-governance hazard.
//
// To prevent that divergence, account selection is gated on the Fabric identity:
// when it is known, only a cached account that matches it is used silently;
// otherwise we fail closed (no silent token -> the sign-in gate re-prompts, with
// the Fabric email as the login hint) so reads and writes share one identity.

let fabricIdentityProvider: (() => string | undefined) | null = null;

/**
 * Wire the source of the Fabric/Rayfin SSO identity (email / UPN) that the
 * Eventhouse account must match. Called once at app startup. Read lazily on
 * every token acquisition so a changed Fabric session is picked up immediately
 * (a now-divergent cached account stops being used without extra bookkeeping).
 */
export function setFabricIdentityProvider(
  getter: (() => string | undefined) | null,
): void {
  fabricIdentityProvider = getter;
}

function expectedIdentity(): string | undefined {
  return fabricIdentityProvider?.()?.trim() || undefined;
}

/** The raw cached account, ignoring identity alignment (used for sign-out). */
function rawActiveAccount(): AccountInfo | undefined {
  return msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
}

function activeAccount(): AccountInfo | undefined {
  return selectEventhouseAccount(
    msalInstance.getAllAccounts(),
    msalInstance.getActiveAccount(),
    expectedIdentity(),
  );
}

/**
 * Whether an Eventhouse (Kusto) account is already cached. Initializes MSAL but
 * never triggers interaction, so it is safe to call on app load to decide
 * whether to show the sign-in prompt.
 */
export async function hasEventhouseSession(): Promise<boolean> {
  await ensureInitialized();
  return !!activeAccount();
}

/**
 * Interactively sign the user in to the Kusto SPA app. MUST be called from a
 * user-gesture handler (e.g. a button click) so the auth popup is not blocked —
 * this is the only reliable interactive path when the app is embedded in the
 * Fabric portal iframe. `loginHint` (when known) pre-selects the correct
 * identity so the user is not shown the wrong account.
 */
export async function signInForEventhouse(loginHint?: string): Promise<void> {
  await getEventhouseToken({ interactive: true, loginHint });
}

/** Sign out of the Eventhouse (Kusto) SPA session. */
export async function signOutEventhouse(): Promise<void> {
  await ensureInitialized();
  const account = rawActiveAccount();
  if (account) {
    await msalInstance.logoutPopup({ account });
  }
}

/**
 * Interactively sign in to / consent for the Fabric REST API read scopes. MUST
 * be called from a user-gesture handler (button click) so the consent popup is
 * not blocked — this is the only reliable interactive path when the app is
 * embedded in the Fabric portal iframe. Used by "Discover from Fabric".
 */
export async function signInForFabricApi(loginHint?: string): Promise<void> {
  await getFabricApiToken({ interactive: true, loginHint });
}

/**
 * Acquire a Kusto access token.
 *
 * Silent by default: refreshes from the cached account and, when an interactive
 * prompt would be needed, notifies sign-in-required subscribers and throws
 * {@link EventhouseSignInRequiredError} instead of opening a popup (auto popups
 * are blocked outside a user gesture and inside the Fabric portal iframe). Pass
 * `{ interactive: true }` ONLY from a user-gesture handler — see
 * {@link signInForEventhouse}. Tokens are cached and reused by MSAL (~24h
 * lifetime) so the silent path is cheap to call before every query.
 *
 * Pass `clusterUri` to target a different Eventhouse than the one configured in
 * env vars — required when a Connection Profile overrides the endpoint.
 */
export async function getEventhouseToken(
  opts: { interactive?: boolean; loginHint?: string; clusterUri?: string } = {},
): Promise<string> {
  await ensureInitialized();
  const scope = `${opts.clusterUri || env.eventhouseQueryUri}/.default`;
  const account = activeAccount();
  try {
    if (!account) throw new InteractionRequiredAuthError();
    const result = await msalInstance.acquireTokenSilent({ scopes: [scope], account });
    return result.accessToken;
  } catch (e) {
    const needsInteraction = !account || e instanceof InteractionRequiredAuthError;
    if (!needsInteraction) throw e;
    if (!opts.interactive) {
      notifyEventhouseSignInRequired();
      throw new EventhouseSignInRequiredError();
    }
    // Always let the user pick: the identity that owns the Eventhouse
    // permissions often differs from other signed-in accounts, and the wrong
    // one yields a 401 at query time. Default the hint to the Fabric identity so
    // reads align with the account writes run under.
    const result = await msalInstance.acquireTokenPopup({
      scopes: [scope],
      loginHint: opts.loginHint ?? expectedIdentity(),
      prompt: 'select_account',
    });
    msalInstance.setActiveAccount(result.account);
    return result.accessToken;
  }
}

/**
 * Acquire a Fabric REST API access token for the delegated read scopes in
 * {@link FABRIC_API_SCOPES}. Used by fabricDiscovery.ts to enumerate workspaces
 * and Eventhouse items.
 *
 * Silent by default. When silent acquisition needs interaction (no cached
 * account, or the Fabric scopes have not been consented yet) it throws
 * {@link EventhouseSignInRequiredError} unless `{ interactive: true }` is
 * passed — in which case it opens a consent popup. Because auto popups are
 * blocked outside a user gesture (and inside the Fabric portal iframe), the
 * interactive path MUST be invoked from a click handler — see
 * {@link signInForFabricApi}. This is a Fabric-API-scope concern only and is
 * intentionally decoupled from the Eventhouse (Kusto) sign-in gate.
 *
 * Pass `{ forceRefresh: true }` to bypass MSAL's access-token cache and mint a
 * fresh token from the refresh token. Callers use this to recover from a
 * data-plane 401 caused by a stale cached access token: because the cache lives
 * in `sessionStorage` and silent hidden-iframe renewal can be blocked by
 * third-party-cookie policies, an expired/invalid token can otherwise be served
 * for the life of the browser session (only cleared by closing the window).
 * `forceRefresh` uses the refresh token directly, sidestepping the iframe.
 */
export async function getFabricApiToken(
  opts: {
    interactive?: boolean;
    loginHint?: string;
    scopes?: string[];
    forceRefresh?: boolean;
  } = {},
): Promise<string> {
  await ensureInitialized();
  const scopes = opts.scopes ?? FABRIC_API_READ_SCOPES;
  const account = activeAccount();
  try {
    if (!account) throw new InteractionRequiredAuthError();
    const result = await msalInstance.acquireTokenSilent({
      scopes,
      account,
      forceRefresh: opts.forceRefresh,
    });
    return result.accessToken;
  } catch (e) {
    const needsInteraction = !account || e instanceof InteractionRequiredAuthError;
    if (!needsInteraction) throw e;
    if (!opts.interactive) throw new EventhouseSignInRequiredError();
    // User gesture: prompt for account + consent to the requested scopes.
    // Default the hint to the Fabric identity so the Fabric-API account aligns
    // with the account writes run under.
    const result = await msalInstance.acquireTokenPopup({
      scopes,
      loginHint: opts.loginHint ?? expectedIdentity(),
      prompt: 'select_account',
    });
    msalInstance.setActiveAccount(result.account);
    return result.accessToken;
  }
}

/**
 * Acquire a Fabric access token carrying the Livy API scopes
 * ({@link FABRIC_LIVY_SCOPES}) so the SPA can call the Livy endpoint directly —
 * create a Spark session, submit a statement, and poll its status.
 *
 * Thin wrapper over {@link getFabricApiToken}: silent by default (reuses the
 * cached account and MSAL token cache), and throws
 * {@link EventhouseSignInRequiredError} when consent/interaction is required
 * unless `{ interactive: true }` is passed — in which case a consent popup is
 * opened. The interactive path MUST be invoked from a user gesture (auto popups
 * are blocked outside a gesture and inside the Fabric portal iframe) — see
 * {@link ensureLivyConsent}.
 */
export function getLivyToken(
  opts: { interactive?: boolean; loginHint?: string } = {},
): Promise<string> {
  return getFabricApiToken({ ...opts, scopes: FABRIC_LIVY_SCOPES });
}

/**
 * Acquire a Fabric REST API token carrying the WRITE scope
 * ({@link FABRIC_API_WRITE_SCOPES}) so the SPA can create Activator (Reflex)
 * items. Thin wrapper over {@link getFabricApiToken}: silent by default, and
 * throws {@link EventhouseSignInRequiredError} when consent/interaction is
 * required unless `{ interactive: true }` is passed — in which case a consent
 * popup is opened. The interactive path MUST be invoked from a user gesture (see
 * {@link ensureFabricWriteConsent}).
 */
export function getFabricWriteToken(
  opts: { interactive?: boolean; loginHint?: string } = {},
): Promise<string> {
  return getFabricApiToken({ ...opts, scopes: FABRIC_API_WRITE_SCOPES });
}

/**
 * Ensure the user has consented to the Fabric WRITE scope, prompting
 * interactively when they have not. Tries the silent path first (no popup when
 * already granted), then opens a consent popup. MUST be called from a
 * user-gesture handler (e.g. the "Create alert" button) so the popup is not
 * blocked — the only reliable interactive path inside the Fabric portal iframe.
 *
 * Resolves once a write token can be obtained; rejects (with the underlying MSAL
 * error, e.g. `user_cancelled`) if the user dismisses the consent prompt.
 */
export async function ensureFabricWriteConsent(loginHint?: string): Promise<void> {
  await getFabricWriteToken({ interactive: true, loginHint });
}

/**
 * Whether the Livy API scopes are already consented and a token can be obtained
 * silently. Never triggers interaction, so it is safe to call to decide whether
 * a consent prompt is needed before doing work.
 */
export async function hasLivyConsent(): Promise<boolean> {
  try {
    await getFabricApiToken({ scopes: FABRIC_LIVY_SCOPES });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the user has consented to the Livy API scopes, prompting interactively
 * when they have not. Tries the silent path first (no popup when the scopes are
 * already granted), then opens a consent popup. MUST be called from a
 * user-gesture handler (e.g. the analysis submit button) so the popup is not
 * blocked — the only reliable interactive path inside the Fabric portal iframe.
 *
 * Resolves once a Livy token can be obtained; rejects (with the underlying MSAL
 * error, e.g. `user_cancelled`) if the user dismisses the consent prompt.
 */
export async function ensureLivyConsent(loginHint?: string): Promise<void> {
  await getLivyToken({ interactive: true, loginHint });
}
