---
id: frontend-architecture
title: Frontend architecture
sidebar_position: 3
---

# Frontend architecture

The SPA is React 18 + TypeScript + Vite, styled with Fluent UI, charting with
ECharts.

## Two clients, two auth contexts

| Client | File | Purpose |
| --- | --- | --- |
| `RayfinClient` | `src/lib/rayfinClient.ts` | Fabric SSO + GraphQL persistence (all writes) |
| Eventhouse executor | `src/lib/eventhouse.ts` | Read-only KQL queries (v2 response parsing) |
| MSAL public client | `src/lib/msal.ts` | Acquires the Kusto-audience delegated token |

The browser is **read-only** against the Eventhouse; **all writes go to Rayfin**.
See [Architecture](/admin/architecture) for the rationale.

## Configuration

`src/lib/env.ts` provides typed access to `VITE_*` config and an `assertEnv()`
that fails fast at startup (rendering the "Configuration incomplete" gate). Add
new required settings here and in `src/lib/vite-env.d.ts`.

## KQL builders

`src/lib/kql.ts` contains **safe** KQL builders for explore, similarity,
discords, and VSM queries. Numeric parameters are validated and string parameters
escaped **before** interpolation to prevent KQL injection — always route new
queries through these builders rather than string-concatenating KQL.

`src/lib/binning.ts` is a TypeScript port of the `f_bin_timespan` adaptive
bin-selection logic so the client can choose a resolution consistent with the
Eventhouse helpers.

## Pages and navigation

- `src/pages/*.tsx` — one page per module.
- `src/lib/pages.ts` — the `PageKey` union and page labels.
- `src/lib/personas.ts` — navigation groups/sections and persona presets.

## The analysis wizard

`src/state/wizardState.ts` is a state machine + reducer driving the Patterns
wizard (Goal → Signal → Length → Review → Results). Wizard UI lives in
`src/components/mp/wizard/`.

## Matrix Profile helpers

`src/lib/mp/` holds the client logic for pattern discovery: recipe definitions,
result interpretation (plain-language explanations), labeling/propagation, signal
handling, and the Livy client/dispatch (`livyClient.ts`, `livyDispatch.ts`,
`livyStatus.ts`).

## Charts

Components under `src/components/` wrap ECharts (`EChart.tsx`, `ChartFrame.tsx`)
and provide reusable analysis visuals. Investigations capture these as PNG + CSV.

## Related

- [Extending modules](./extending-modules)
- [Agent design](./agent-design)
