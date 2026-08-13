---
id: matrix-profile
title: Matrix Profile
sidebar_position: 5
---

# Matrix Profile (deep discovery)

The **Matrix Profile** module is the deepest pattern-discovery tool in Operations
IQ. It uses Spark-powered algorithms (MOMP / DAMP / PAN-MP) to find **motifs**
(recurring shapes) and **discords** (anomalies) over long time windows. It's
**wizard-driven**, explains results in plain language, supports **label
propagation**, and shows a **convergence meter** so you know when the answer has
stabilized.

## When to use it

- You need to search very long histories that interactive tools can't cover.
- You want both recurring patterns *and* anomalies from a single run.
- You want to find patterns **across multiple signals** (fleet-wide).

## Recipes

The wizard offers goal-based **recipes** so you don't have to tune algorithms.

**Across one signal**
- **Normal cycles** — find the typical repeating shapes.
- **Anomalies** — find the unusual subsequences.
- **Regime change** — find where behavior transitions.
- **Slow degradation** — find gradual drift over time.
- **Auto-discovery** — let the app choose the pattern length.

**Across multiple signals**
- **Compare two signals** — shared patterns between two tags.
- **Changes vs baseline** — novelty relative to a reference period.
- **Multi-sensor events / anomalies / segments** — patterns spanning several tags.
- **Fleet common shape** — the shape common across a fleet of assets.

## How to use it

1. Open the **Patterns** wizard (or pick a recipe from the navigation).
2. **Goal** — choose what you want to find.
3. **Signal** — select the tag(s) and time range.
4. **Length** — set the pattern timescale (or let auto-discovery choose). Lengths
   can be specified down to **milliseconds**, so sub-second patterns are
   expressible.
5. **Review** — confirm the plan and submit the Spark job. Because Spark sessions
   take time to start, runs typically take several minutes; a **Stop** control ends
   a long run early.
6. **Results** — review motifs, discords, regimes, and chains in a consistent
   master-detail layout (see below).

## Reviewing results

The review experience is consistent across every recipe family (repeating patterns,
anomalies, chains, segmentation, compare-two-signals, multi-sensor, and consensus):

- **Run history** lists your past runs with short IDs, names, run dates, durations,
  and result counts, so you can revisit and compare earlier analyses.
- A **methodology panel** shows the full submitted parameters (result count,
  sub-length/separation, bin width, aggregation, missing-data handling) and explains
  how to read the analysis.
- **Synchronized multi-panel charts** (overlay, stacked, or small-multiples, modeled
  on Explore > Overview) highlight each pattern consistently and align it to the
  underlying signal, with labeled tooltips.
- A **show all occurrences** toggle reveals every instance of a motif — not just the
  top pair — so you can inspect and highlight each one.

## Anytime results & convergence

Matrix Profile jobs run as **anytime** computations: they stream best-so-far
progress while running. The **convergence meter** shows how settled the result
is, and you can stop early and keep the partial answer once it has converged
enough for your needs.

## Labeling & annotations

When you label one occurrence of a pattern, the app can **propagate** that label
to the other occurrences it found, so you build a catalog quickly. Labels are
**categorized**, persist reliably in the backend, and render back in the UI; each
label is matched to its specific pattern (rather than to any overlapping neighbor)
and records the temporal resolution it was created at.

## Reading the results

- **Motifs** are the shapes that recur most — the process "vocabulary".
- **Discords** are the most anomalous windows.
- **Regimes / chains** show how patterns evolve over time.
- Plain-language explanations accompany each result so you don't need to
  interpret the raw matrix profile yourself.

## Related

- [Anomalies](./anomalies) and [Classifiers](./classifiers) for faster,
  interactive discovery.
- [Investigations](/user/investigations) to capture findings as evidence.
- Administrators: see [Admin Guide → Spark compute](/admin/spark-compute) for how
  these jobs run.
