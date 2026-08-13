/**
 * Centralized, typed access to build-time environment configuration.
 * All values are injected by Vite from `.env` (see .env.example).
 */
export const env = {
  rayfinApiUrl: import.meta.env.VITE_RAYFIN_API_URL ?? 'http://localhost:5168',
  rayfinPublishableKey: import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY,
  fabricWorkspaceId: import.meta.env.VITE_FABRIC_WORKSPACE_ID,
  fabricItemId: import.meta.env.VITE_FABRIC_ITEM_ID,
  fabricPortalUrl: import.meta.env.VITE_FABRIC_PORTAL_URL ?? 'https://app.fabric.microsoft.com',
  eventhouseQueryUri: (import.meta.env.VITE_EVENTHOUSE_QUERY_URI ?? '').replace(/\/+$/, ''),
  eventhouseDb: import.meta.env.VITE_EVENTHOUSE_DB,
  msalClientId: import.meta.env.VITE_MSAL_CLIENT_ID,
  msalTenantId: import.meta.env.VITE_MSAL_TENANT_ID,
  // --- Livy (direct SPA -> Fabric Livy REST) ---------------------------------
  // The lakehouse whose Livy endpoint runs the Spark analyses. Required to submit
  // and monitor jobs from the browser; other tabs work without it.
  fabricLakehouseId: import.meta.env.VITE_FABRIC_LAKEHOUSE_ID,
  // Optional Fabric Spark Environment for *extra* Spark libraries/config. NOT
  // required for tsmp: the SPA ships the tsmp package inside each Livy statement
  // (see buildLivyCode / scripts/bundle-tsmp.mjs), so run_payload imports with no
  // wheel or Environment. Set only if analyses need additional cluster libraries.
  fabricEnvironmentId: import.meta.env.VITE_FABRIC_ENVIRONMENT_ID,
  // Space-separated pip requirements the Livy statement installs on the Spark
  // *driver* before running (only if not already importable). The analysis reads
  // and ingests the Eventhouse via the azure-kusto SDKs, which are not guaranteed
  // to be present on a bare Fabric Spark pool. Override to pin versions or to ''
  // (empty) to skip installing when your Fabric Environment already provides them.
  tsmpPipPackages:
    import.meta.env.VITE_TSMP_PIP_PACKAGES ?? 'azure-kusto-data azure-kusto-ingest',
  // How the Spark job authenticates to the Eventhouse (Kusto). Default
  // 'fabric_token' uses notebookutils.credentials.getToken on the driver, because
  // Fabric Spark has no IMDS endpoint so 'managed_identity' fails. Other values:
  // 'managed_identity' (non-Fabric MSI), 'az_cli' (local dev).
  tsmpKustoAuth: import.meta.env.VITE_TSMP_KUSTO_AUTH ?? 'fabric_token',
  // --- Operations Advisor (Microsoft Foundry agent) --------------------------
  // The Operations Advisor is optional: when these are unset the header button is
  // hidden and no agent calls are made. `foundryEndpoint` is the project endpoint
  // base URL (up to and including the /api/projects/<project> path, no trailing
  // slash); the client appends `/openai/v1/...`. `foundryAgentName` +
  // `foundryAgentVersion` reference the persisted versioned agent to run, and
  // `foundryScope` is the OAuth scope whose token audience matches that endpoint.
  foundryEndpoint: (import.meta.env.VITE_FOUNDRY_ENDPOINT ?? '').replace(/\/+$/, ''),
  foundryAgentName: import.meta.env.VITE_FOUNDRY_AGENT_NAME,
  foundryAgentVersion: import.meta.env.VITE_FOUNDRY_AGENT_VERSION,
  foundryScope:
    import.meta.env.VITE_FOUNDRY_SCOPE ?? 'https://ai.azure.com/.default',
  operationsAdvisorVision: (import.meta.env.VITE_OPERATIONS_ADVISOR_VISION ?? 'true') !== 'false',
} as const;

/** True when the Operations Advisor agent is fully configured. */
export function operationsAdvisorConfigReady(): boolean {
  return Boolean(env.foundryEndpoint && env.foundryAgentName && env.foundryScope);
}

/**
 * Required configuration: each internal `env` key paired with the `VITE_*`
 * variable name shown to operators when it is missing. Keep this in sync with
 * the "required" rows in `.env.example` / the README config table.
 */
export const REQUIRED_ENV: ReadonlyArray<readonly [keyof typeof env, string]> = [
  ['rayfinPublishableKey', 'VITE_RAYFIN_PUBLISHABLE_KEY'],
  ['fabricWorkspaceId', 'VITE_FABRIC_WORKSPACE_ID'],
  ['fabricItemId', 'VITE_FABRIC_ITEM_ID'],
  ['eventhouseQueryUri', 'VITE_EVENTHOUSE_QUERY_URI'],
  ['eventhouseDb', 'VITE_EVENTHOUSE_DB'],
  ['msalClientId', 'VITE_MSAL_CLIENT_ID'],
  ['msalTenantId', 'VITE_MSAL_TENANT_ID'],
];

/**
 * Returns the `VITE_*` variable names that are required but missing/empty.
 * `source` defaults to the live `env`; it is injectable for testing.
 */
export function missingRequiredEnv(
  source: Record<string, unknown> = env,
): string[] {
  return REQUIRED_ENV.filter(([key]) => !source[key as string]).map(([, name]) => name);
}

/** Throws if any required env var is missing (call once at app startup). */
export function assertEnv(source: Record<string, unknown> = env): void {
  const missing = missingRequiredEnv(source);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
