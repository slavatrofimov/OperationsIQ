/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Rayfin managed backend (GraphQL + auth + hosting)
  readonly VITE_RAYFIN_API_URL: string;
  readonly VITE_RAYFIN_PUBLISHABLE_KEY: string;
  // Fabric SSO target (the deployed Fabric App item)
  readonly VITE_FABRIC_WORKSPACE_ID: string;
  readonly VITE_FABRIC_ITEM_ID: string;
  readonly VITE_FABRIC_PORTAL_URL: string;
  // Eventhouse (read-only, reached directly via MSAL Kusto token)
  readonly VITE_EVENTHOUSE_QUERY_URI: string;
  readonly VITE_EVENTHOUSE_DB: string;
  // Entra SPA app registration used to mint the Kusto-audience token
  readonly VITE_MSAL_CLIENT_ID: string;
  readonly VITE_MSAL_TENANT_ID: string;
  // Operations Advisor (Microsoft Foundry agent) — optional
  readonly VITE_FOUNDRY_ENDPOINT?: string;
  readonly VITE_FOUNDRY_AGENT_NAME?: string;
  readonly VITE_FOUNDRY_AGENT_VERSION?: string;
  readonly VITE_FOUNDRY_SCOPE?: string;
  readonly VITE_OPERATIONS_ADVISOR_VISION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
