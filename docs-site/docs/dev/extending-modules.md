---
id: extending-modules
title: Extending the app
sidebar_position: 6
---

# Extending the app

## Add a new module (page)

1. **Create the page** — add `src/pages/YourPage.tsx`. Reuse shared components
   (`PageIntro`, `ChartFrame`/`EChart`, `TagSelect`/`TagPicker`,
   `TimeRangePicker`, `ResultsTable`, `AddToInvestigationButton`).
2. **Register the page key** — add it to the `PageKey` union and labels in
   `src/lib/pages.ts`.
3. **Add navigation** — place it in the right group/section (and persona) in
   `src/lib/personas.ts`. Single-item groups render as a tab; multi-item groups
   render as a dropdown, optionally with section headers.
4. **Query data safely** — add any new KQL through the builders in
   `src/lib/kql.ts` (validate numbers, escape strings). Execute via
   `src/lib/eventhouse.ts`.
5. **Persist results** — write user output (labels, saved config) through
   `RayfinClient`; add entities in `rayfin/data/` if you need new persisted shapes,
   then `rayfin up db apply`.
6. **Support investigations** — include `AddToInvestigationButton` so users can
   capture the page (Markdown + chart PNG/CSV + annotation).

## Add a Matrix Profile recipe

Recipes are goal-based presets for the Patterns wizard.

1. Define the recipe in `src/lib/mp/` (the recipes module) — goal, default
   parameters, and the plain-language interpretation.
2. Surface it in navigation via a preset in `src/lib/personas.ts` (e.g.
   `{ page: 'patterns', preset: { recipeId: 'your-recipe' } }`).
3. If it needs new compute behavior, extend the PySpark core in `spark/tsmp/` and
   keep `spark/tests` green.

## Add an agent tool

The Operations Advisor agent's client-side tools live in `src/lib/agent/`. When
you add, rename, or change a tool, update `docs/agent-instructions.md` and
`docs/agent-tool-design.md` in the same change — treat drift between the tools and
those docs as a bug. See [Agent design](./agent-design).

## Conventions

- Route **all** KQL through `src/lib/kql.ts`.
- Keep the browser read-only against the Eventhouse; writes go to Rayfin.
- Add required config to `src/lib/env.ts` + `vite-env.d.ts` so `assertEnv()`
  guards it.
- Keep `npm run typecheck`, `npm test`, and `pytest spark/tests` green.
