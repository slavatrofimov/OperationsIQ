---
id: rayfin-backend
title: Rayfin backend
sidebar_position: 6
---

# Rayfin backend

Rayfin (Fabric Apps) is the control plane: it provides Fabric SSO, a Fabric SQL
database, a generated GraphQL API, and static hosting for the SPA. User work
(labels, saved searches, models, signal metadata, investigations, evidence) is
persisted here.

## Scaffold (if needed)

If you don't already have a scaffolded Rayfin project, create one and copy the
`rayfin/data` entities and `src/lib` client into it:

```powershell
npm create @microsoft/rayfin@latest
```

## Configure, build, and provision

1. Fill in `rayfin/.env` from `rayfin/.env.example` (auth, data connection).
2. Type-check, test, and build the SPA:
   ```powershell
   npm install
   npm run typecheck; npm test; npm run build
   ```
3. Provision the SQL database + GraphQL API + static hosting and apply the schema:
   ```powershell
   npm run rayfin:up          # rayfin up
   npm run rayfin:db:apply    # apply @entity schema to the Fabric SQL DB (rayfin up db apply)
   ```
4. Verify SSO: sign in through `/auth` and confirm the SPA loads from static
   hosting.

## Entities

The `rayfin/data/*.ts` entity classes define the persisted model — **21 entities**
assembled in `schema.ts`, including:

`DataSource`, `Signal`, `SignalMetadata`, `SpcBaseline`, `AnalysisJob`,
`ResultArtifact`, `ModelOutput`, `Label`, `LabelCategory`, `Investigation`,
`Evidence`, `EvidenceArtifact`, `ConnectionProfile`, `SavedView`,
`SavedDerivedMetric`, `Annotation`, `ScenarioRun`, `VsmModel`, `VsmModelTerm`,
`AlertRule`, and `AlertEvent`.

`rayfin up db apply` generates the Fabric SQL schema + GraphQL from these
entities. See [Developer Guide → Data model](/dev/data-model) for per-entity
detail.

:::note
The Rayfin packages are pinned to a patch range (`~1.33.2`) in `package.json` and
resolved exactly by `package-lock.json`. Use `npm ci` in CI/deploys for a
reproducible install; bump the pin deliberately when adopting a new Rayfin
release.
:::

## Next

Deploy the [Spark compute plane](./spark-compute).
