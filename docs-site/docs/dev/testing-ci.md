---
id: testing-ci
title: Testing & CI
sidebar_position: 9
---

# Testing & CI

## Frontend

From `OperationsIQApp/`:

```powershell
npm install
npm run typecheck   # tsc -b --noEmit
npm test            # vitest run
npm run build       # tsc -b && vite build
```

- **Type-checking:** `tsc -b`.
- **Unit tests:** Vitest (`vitest run`, or `npm run test:watch`). Tests run in
  **Node** by default (`environment: 'node'`); DOM-dependent suites opt in
  per-file with `// @vitest-environment jsdom`.
- **Build:** Vite. A `predev`/`prebuild` step bundles the tsmp package
  (`scripts/bundle-tsmp.mjs`) so the SPA can embed it in Livy statements.

## Spark core

The PySpark Matrix Profile core is pure Python and testable without a cluster:

```bash
pytest spark/tests
```

## Orchestration (optional dispatcher)

The `orchestration/` package has its own tests for the state machine and Livy
monitoring logic — the reference the TypeScript Livy client was ported from.

## Local dev server

```powershell
Copy-Item .env.example .env.local   # fill in values
npm run dev
```

The app runs against the remote Fabric backend. Missing required config triggers
the "Configuration incomplete" gate (`assertEnv()` in `src/lib/env.ts`).

## Before you push

Keep all of these green:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `pytest spark/tests`

## Docs site

This documentation site lives in `docs-site/` and is built and deployed to GitHub
Pages by a GitHub Actions workflow on pushes to `main`. To work on it locally:

```powershell
cd docs-site
npm install
npm run start   # dev server with live reload
npm run build   # production build; fails on broken links
```
