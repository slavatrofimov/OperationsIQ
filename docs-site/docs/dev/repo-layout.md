---
id: repo-layout
title: Repo layout
sidebar_position: 2
---

# Repo layout

Everything for the app lives under `OperationsIQApp/`.

```
OperationsIQApp/
  eventhouse/
    schema/00_tables.kql          # Timeseries, TagMetadata, TagHierarchy, Events
    schema/10_app_functions.kql   # segment + search-space builders for similarity search
    schema/20_mp_result_tables.kql# Matrix Profile result tables
    schema/30_sax_core.kql        # SAX core helpers (znorm, alphabet, breakpoints, PAA, symbolize)
    schema/40_sax_similarity_1d.kql        # 1-D SAX similarity search
    schema/50_sax_similarity_multidim.kql  # multivariate SAX similarity search
    schema/60_sax_discords.kql    # SAX-guided discord discovery
    schema/70_sax_vsm.kql         # SAX-VSM interpretable classification
    sample-data/contoso_sample.kql
    deploy/Deploy-Eventhouse.ps1  # deploys schema + SAX library (+ optional sample data)
  rayfin/
    data/*.ts                     # @entity classes + schema.ts (see Data model)
  spark/                          # PySpark Matrix Profile compute core (MOMP, DAMP, PAN-MP)
  orchestration/                  # Optional async dispatcher for Spark submissions
  src/
    lib/env.ts                    # typed env config (assertEnv)
    lib/rayfinClient.ts           # Fabric SSO + GraphQL persistence client
    lib/msal.ts                   # Kusto-token acquisition (MSAL public client)
    lib/eventhouse.ts             # read-only KQL executor (v2 response parsing)
    lib/binning.ts                # f_bin_timespan port (adaptive bin selection)
    lib/kql.ts                    # safe KQL builders (explore / similarity / discords / VSM)
    lib/mp/                       # Matrix Profile helpers (interpret, recipes, labeling, livy...)
    lib/agent/                    # Operations Advisor agent tools
    state/wizardState.ts          # Analysis wizard state machine + reducer
    components/                   # Fluent UI + ECharts components
    components/mp/                # Matrix Profile components (+ wizard/)
    pages/*.tsx                   # one file per module (Explore, Diagnose, Patterns, ...)
  docs/                           # design spec, runbook, agent docs (source of truth)
  .env.example                    # copy to .env.local and fill in
```

## Modules (pages)

Each user-facing module is a page under `src/pages/`. Navigation and persona
grouping is defined in `src/lib/personas.ts`, and page keys in `src/lib/pages.ts`.

## Related

- [Frontend architecture](./frontend-architecture)
- [Data model](./data-model)
- [KQL & SAX library](./kql-functions)
