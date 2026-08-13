---
id: signing-in
title: Signing in
sidebar_position: 2
---

# Signing in

Operations IQ runs inside Microsoft Fabric and uses your own organizational
identity. There are two sign-in contexts working behind the scenes, but as a
user you typically authenticate once.

## What happens when you sign in

| Context | Purpose |
| --- | --- |
| **Fabric SSO** (Rayfin) | Identity and saving your work — labels, saved searches, models, and investigations. |
| **Eventhouse token** (MSAL) | Reading time-series data and running analytics directly against the Eventhouse. |

Because reads run under **your** identity, the Eventhouse honors any row-level
security (RLS) and database roles assigned to you. You will only see the data
you are permitted to see.

## First-time consent

On first sign-in you may be prompted to consent to the app accessing Azure Data
Explorer (the Eventhouse) on your behalf. If your administrator has already
granted tenant-wide consent, you won't see this prompt.

## Access requirements

To use the app you need at least the **Viewer** role on the target Eventhouse /
KQL database. If you can sign in but see no data, contact your administrator —
see the [Admin Guide → Permissions & governance](/admin/permissions-governance).

## Troubleshooting

- **"Configuration incomplete" screen** — the app is missing required settings.
  This is an administrator/deployment issue; see
  [Admin Guide → Configuration](/admin/configuration).
- **No signals appear** — you may lack Eventhouse read access, or your selected
  time range has no data. Try widening the range first.
- **Operations Advisor says "Access denied … invalid subscription key or wrong
  API endpoint" (401)** — this is almost always a stale sign-in token rather than
  a permissions problem. The app now automatically refreshes the token and
  retries once when this happens, so it should self-correct. If it persists,
  sign out and back in (or close and reopen the browser window) to clear the
  cached token. If it still fails, your account may be missing the Foundry data
  role — contact your administrator.
