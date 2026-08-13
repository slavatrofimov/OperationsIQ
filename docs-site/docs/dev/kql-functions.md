---
id: kql-functions
title: KQL & SAX library
sidebar_position: 5
---

# KQL & SAX function library

The Eventhouse hosts both the app's data tables and an in-repo **SAX function
library** that powers similarity search, discord discovery, and interpretable
classification. Everything is defined under `OperationsIQApp/eventhouse/schema/`
and deployed by `deploy/Deploy-Eventhouse.ps1`.

## Tables (`00_tables.kql`)

- `Timeseries` — the raw sensor series.
- `TagMetadata` — per-tag descriptive metadata.
- `TagHierarchy` — asset hierarchy for the tag browser.
- `Events` — discrete events used for overlays and process mining.

## App helper functions (`10_app_functions.kql`)

Two read-only helpers that build the `(series_id, series)` shape the SAX
similarity functions expect:

- `app_extract_segment` — a single avg-binned, gap-filled row for one signal over
  a range (the *query* side of a similarity search).
- `app_search_space` — the multi-signal `(series_id, series)` table over a range
  (the *search space* side).

Both land in the `OperationsIQ/Search` folder. Adaptive bin selection is **not** a
KQL function — the app computes it client-side in `src/lib/binning.ts` and passes
the chosen `bin` timespan into these helpers.

## Matrix Profile result tables (`20_mp_result_tables.kql`)

`mp_result`, `motif_pairs`, `motif_occurrences`, `discords`, `overview` (keyed by `jobId`),
plus `job_progress` — the best-so-far progress stream the anytime Patterns UI polls.
`motif_occurrences` holds *every* stretch that matches each motif's shape (not just the
matched pair): one row per occurrence, tied to its `motif_pairs` row by `rank`, with a
`seriesId` (0/1) for AB-join runs and null for single-series / multidimensional runs.
These tables live under the Kusto `OperationsIQ/Pattern Analysis` folder (subfolders
`Core`, `Segmentation`, `Chains`, `Multidimensional`, `Consensus`, `Progress`).

## SAX library (`30`–`70`)

| File | Folder | Functions |
| --- | --- | --- |
| `30_sax_core.kql` | `SAX/Core` | 13 SAX primitives and distance helpers: `sax_alphabet`, `sax_breakpoints_gaussian`, `sax_breakpoints_query`, `sax_znorm`, `sax_paa`, `sax_symbolize_values`, `sax_word`, `sax_euclidean_arrays`, `sax_paa_distance`, `sax_symbol_distance`, `sax_symbol_distance_max`, `sax_tolerance_regex`, `sax_similarity_from_distance`. |
| `40_sax_similarity_1d.kql` | `SAX/Search` | 1-D SAX similarity search (`sax_similarity_search_1d`). |
| `50_sax_similarity_multidim.kql` | `SAX/Search` | Multivariate similarity (`sax_similarity_search_multidim`). |
| `60_sax_discords.kql` | `SAX/Discords` | SAX-guided discord discovery (`sax_discords`). |
| `70_sax_vsm.kql` | `SAX/VSM` | SAX-VSM interpretable classification (wordbag / train / classify). |

These land in the Kusto `SAX/` folder (`Core`, `Search`, `Discords`, `VSM`),
while the app helpers from `10_app_functions.kql` land in `OperationsIQ/Search`.

## Verify a deployment

```kql
.show functions
| where Folder startswith "OperationsIQ/" or Folder startswith "SAX/"
| project Name, Folder
| order by Folder asc, Name asc
```

## Calling from the client

The client builds these calls via the safe builders in `src/lib/kql.ts`, which
validate/escape parameters to avoid KQL injection. Queries always run under the
user's delegated token, so Eventhouse RLS applies.

## Related

- [Admin → Eventhouse deployment](/admin/eventhouse-deployment)
- [Frontend architecture → KQL builders](./frontend-architecture)
