---
id: permissions-governance
title: Permissions & governance
sidebar_position: 9
---

# Permissions & governance

Operations IQ relies on Fabric- and Eventhouse-native security. Because the
browser reads under each user's **delegated** identity, you govern data access
where the data lives.

## Eventhouse (data) access

- Grant signing-in users at least the **Viewer** role on the Eventhouse / KQL
  database (**Manage → Permissions**).
- Apply **Row-Level Security (RLS)** policies as needed — they are enforced
  automatically because reads use the user's own token.
- The Spark job's **managed identity** needs **read** on the source table and
  **ingest** on the Matrix Profile result tables.

## Fabric workspace access

- Users who run analyses (Patterns) must be **Contributor** on the workspace
  hosting the lakehouse (Livy) and the Eventhouse.
- The tenant **Livy API** admin setting must be enabled.

## Consent model

- Prefer **admin consent** for the Azure Data Explorer `user_impersonation` scope
  so users aren't prompted individually.
- Feature-specific Fabric scopes (Discover from Fabric, run analysis) use
  **incremental consent** on first use; admins can pre-consent them. See
  [Entra app registration](./entra-app-registration).

## Rayfin (control plane) data

User work is persisted to Rayfin SQL via GraphQL under the Fabric SSO identity:
labels, saved searches, models, signal metadata, investigations, and evidence.
Governance of this store follows your Fabric SQL / Rayfin access model.

## Governed signal metadata

The [Signal metadata](/user/diagnose/signal-metadata) capability is a governance
surface in its own right: operating/spec limits, setpoints, rate limits,
plausible ranges, SPC bindings, and monitoring defaults are curated centrally and
applied across the app (and optionally into KQL — see
[Configuration](./configuration)). Keeping this metadata accurate and reviewed is
key to trustworthy validation, monitoring, and alerting.

## Least privilege summary

| Identity | Needs |
| --- | --- |
| End user | Eventhouse **Viewer** (+ RLS); workspace **Contributor** to run analyses |
| Spark managed identity | **Read** on source table, **Ingest** on result tables |
| Service principal (legacy dispatcher) | Workspace **Contributor** + Livy scopes |
