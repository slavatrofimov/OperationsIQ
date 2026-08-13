---
id: entra-app-registration
title: Entra app registration
sidebar_position: 5
---

# Entra app registration (Eventhouse access)

The browser queries the Eventhouse directly, so it needs its own **public SPA**
(PKCE, no secret) Entra app registration that mints a **Kusto-audience** token.
Because the token is delegated, the user's own identity is used — Eventhouse RLS
and database roles are honored. This registration is **separate** from the
Rayfin / Fabric SSO session.

## 1. Register the application

1. Open the [Entra admin center](https://entra.microsoft.com) → **Applications →
   App registrations → New registration**.
2. **Name:** e.g. `Operations IQ – Eventhouse SPA`.
3. **Supported account types:** single tenant.
4. **Redirect URI:** platform = **Single-page application (SPA)**, value =
   `http://localhost:5173/blank.html` (the local dev origin **+ `/blank.html`** —
   see step 2 for why the path is required).
5. **Register**, then copy the **Application (client) ID** → `VITE_MSAL_CLIENT_ID`
   and **Directory (tenant) ID** → `VITE_MSAL_TENANT_ID`.

## 2. Add every serving origin as a redirect URI

`redirectUri` is `${window.location.origin}/blank.html` — a dedicated blank page
(`public/blank.html`) that silent token-renewal iframes and popups navigate to,
so they don't reload the whole SPA (which otherwise throws MSAL
`block_iframe_reload`, especially inside the Fabric portal iframe). So under
**Authentication → Single-page application**, add a **`/blank.html`** URI for
**every** origin the app is served from:

- `http://localhost:5173/blank.html` — local dev
- the Rayfin-hosted public URL + `/blank.html`, e.g.
  `https://<your-app>.webapp.fabricapps.net/blank.html`
- `https://app.fabric.microsoft.com/blank.html` — only if embedding in the Fabric
  portal

Leave **Implicit grant** unchecked (PKCE is used), then **Save**.

## 3. Grant delegated permission to Kusto

The app requests `${VITE_EVENTHOUSE_QUERY_URI}/.default` (the Eventhouse cluster's
own audience):

1. **API permissions → Add a permission → APIs my organization uses**.
2. Search **Azure Data Explorer** (app id
   `2746ea77-4702-4b45-80ca-3c97e680e8b7`) and select it.
3. **Delegated permissions → user_impersonation → Add permissions**.
4. (Recommended) **Grant admin consent** so users aren't prompted individually.

## 4. Grant Eventhouse read access

The Entra grant only lets the token be *issued*; the Eventhouse enforces its own
roles. In the Fabric portal open the **Eventhouse / KQL Database → Manage →
Permissions** and give signing-in users at least the **Viewer** role (plus any
applicable RLS policy).

## Incremental (dynamic) consent scopes

Some features request extra Fabric scopes on first use, via a user gesture
(so they don't have to be pre-added — though admins can pre-consent):

- **Discover from Fabric** (list workspaces + Eventhouses):
  `Workspace.Read.All`, `Item.Read.All`.
- **Run an analysis** (Patterns / Livy): `Lakehouse.Execute.All`,
  `Lakehouse.Read.All`, `Code.AccessFabric.All`, `Code.AccessStorage.All`,
  `Code.AccessAzureDataExplorer.All`.

:::warning
The authenticated user must be a **Contributor** on the workspace hosting both the
Livy lakehouse and the Eventhouse, and the tenant **Livy API** setting must be
enabled. If submitting an analysis errors on consent, the account hasn't consented
to (or been admin-consented for) the Livy scopes above.
:::

## Next

Provision the [Rayfin backend](./rayfin-backend).
