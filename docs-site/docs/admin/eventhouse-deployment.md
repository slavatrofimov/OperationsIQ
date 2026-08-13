---
id: eventhouse-deployment
title: Eventhouse deployment
sidebar_position: 4
---

# Eventhouse deployment

The Eventhouse (KQL database) is the data plane. Deploying it installs the table
schema, the in-repo **SAX function library**, and (optionally) sample data.

## Deploy the schema + SAX library

From the repo, run the deploy script against your Eventhouse cluster:

```powershell
cd OperationsIQApp/eventhouse/deploy
./Deploy-Eventhouse.ps1 `
  -ClusterUri "https://<guid>.<region>.kusto.fabric.microsoft.com" `
  -Database "<eventhouse-db>" `
  -IncludeSampleData
```

The SAX functions ship inside the repo (`eventhouse/schema/{30..70}_sax_*.kql` —
`30_sax_core`, `40_sax_similarity_1d`, `50_sax_similarity_multidim`,
`60_sax_discords`, `70_sax_vsm`) and deploy automatically with the schema. They
land in the Kusto `SAX/` folder (`Core`, `Search`, `Discords`, `VSM`); the app
helper functions land in `OperationsIQ/Search` and the data tables in
`OperationsIQ/Data`. The Matrix Profile result tables land under
`OperationsIQ/Pattern Analysis` (with `Core`, `Segmentation`, `Chains`,
`Multidimensional`, `Consensus`, and `Progress` subfolders).

## What gets created

| File | Contents |
| --- | --- |
| `schema/00_tables.kql` | `Timeseries`, `TagMetadata`, `TagHierarchy`, `Events` |
| `schema/10_app_functions.kql` | Segment (`app_extract_segment`) + search-space (`app_search_space`) builders for similarity search |
| `schema/20_mp_result_tables.kql` | Matrix Profile result tables (`mp_result`, `motif_pairs`, `discords`, `overview`) |
| `schema/30_sax_core.kql` | SAX core helpers (znorm, alphabet, breakpoints, PAA, symbolize) |
| `schema/40_sax_similarity_1d.kql` | 1-D SAX similarity search |
| `schema/50_sax_similarity_multidim.kql` | Multivariate SAX similarity search |
| `schema/60_sax_discords.kql` | SAX-guided discord discovery |
| `schema/70_sax_vsm.kql` | SAX-VSM interpretable classification |

The result-table schema also creates `job_progress`, the best-so-far progress
stream the anytime Patterns UI polls while a Spark job runs. The app degrades
gracefully if it's absent, but the live convergence meter needs it — apply the
current schema.

## Verify

```kql
.show functions
| where Folder startswith "OperationsIQ/" or Folder startswith "SAX/"
| project Name, Folder
| order by Folder asc, Name asc
```

## Ingestion policies

The result-table schema sets batching so results land within ~10 s of a job
finishing, and `job_progress` is batched at ~5 s so live convergence feels
responsive.

## Next

Set up identity in [Entra app registration](./entra-app-registration).
