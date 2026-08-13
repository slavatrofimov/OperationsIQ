---
id: index
title: Developer Guide
slug: /
sidebar_position: 1
---

# Operations IQ — Developer Guide

This guide is for engineers working **on** Operations IQ — understanding the
architecture, the data model, and the KQL/SAX function library, and extending the
app with new modules, Matrix Profile recipes, and agent tools.

## Stack at a glance

- **Frontend:** React 18 + TypeScript + Vite + Fluent UI, charts via ECharts.
- **Persistence:** Rayfin (Fabric Apps) — TypeScript `@entity` decorators →
  Fabric SQL + generated GraphQL.
- **Data reads:** Eventhouse (KQL) via a read-only executor, using a delegated
  Kusto token (MSAL).
- **Compute:** PySpark Matrix Profile core, submitted to Fabric Livy.
- **Assistant:** "Operations Advisor" agent (Azure AI Foundry) with client-side
  tools in `src/lib/agent/`.

## Where to start

<ModuleCards items={[
  {title: 'Repo layout', to: '/dev/repo-layout', desc: 'Directory map and what lives where.'},
  {title: 'Frontend architecture', to: '/dev/frontend-architecture', desc: 'Pages, wizard state machine, KQL builders, clients.'},
  {title: 'Data model', to: '/dev/data-model', desc: 'Rayfin entities and persisted schema.'},
  {title: 'KQL & SAX library', to: '/dev/kql-functions', desc: 'Eventhouse schema and SAX function library.'},
  {title: 'Extending modules', to: '/dev/extending-modules', desc: 'Add a page or a Matrix Profile recipe.'},
  {title: 'Agent design', to: '/dev/agent-design', desc: 'The Operations Advisor agent and its tools.'},
  {title: 'Design spec', to: '/dev/design-spec', desc: 'Problem statement, constraints, and design decisions.'},
  {title: 'Testing & CI', to: '/dev/testing-ci', desc: 'How to build, type-check, and test.'},
]} />

:::info
The in-repo docs (`OperationsIQApp/docs/design-spec.md`,
`agent-instructions.md`, `agent-tool-design.md`, `runbook.md`) are the
authoritative, code-versioned references. This guide orients you and links to them.
:::
