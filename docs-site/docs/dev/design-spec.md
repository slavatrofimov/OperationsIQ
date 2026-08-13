---
id: design-spec
title: Design spec
sidebar_position: 8
---

# Design spec

The authoritative design specification lives in the repo at
`OperationsIQApp/docs/design-spec.md`. This page summarizes it so newcomers have
context; read the full document before making architectural changes.

## Problem

Industrial sensor time series contain recurring patterns (**motifs**) that signal
normal operating regimes and rare anomalies (**discords**) that signal faults,
wear, or process upsets. The **Matrix Profile (MP)** is the state-of-the-art
primitive for finding both, but it is (a) computationally expensive at scale and
(b) inaccessible to non-technical users.

**Goal:** democratize Matrix Profile analytics — let non-technical users connect
to sensor data in a KQL database, run **motif discovery (MOMP)** and **discord
discovery (DAMP-style)** as managed **Spark jobs**, and explore and **label**
results through a highly interactive UI.

**Design priorities (in order):** performance, accuracy, user experience.

## Key platform realities

- **Fabric Apps (Rayfin) is opinionated** — TypeScript data-model decorators
  generate a Fabric SQL database and an auto-generated GraphQL API; sessions are
  opaque (hence the separate MSAL client for Kusto).
- **Eventhouse is read-only from the browser**; writes go to Rayfin SQL.
- **Spark is the compute plane** for heavy MP work, submitted via Livy.

## Anytime computation

MP jobs are **anytime**: they stream best-so-far progress (`job_progress`) so the
UI shows a live convergence meter and supports stop-early "keep partial" behavior.

## Read the full spec

See `OperationsIQApp/docs/design-spec.md` for the complete problem statement,
constraints, data model, algorithms, and phasing (v1 = exploration + 1-D
similarity; v2 = multi-dim, discords, SAX-VSM).
