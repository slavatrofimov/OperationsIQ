---
id: classifiers
title: Classifiers
sidebar_position: 2
---

# Classifiers (SAX-VSM)

The **Classifiers** view lets you **train** an interpretable classifier from
labeled examples and then **apply** it to classify and annotate new data. It uses
**SAX-VSM** (Symbolic Aggregate approXimation + Vector Space Model), which
produces human-readable term weights rather than a black box.

:::note
Classifiers is its own page under **Patterns → Quick interactive discovery**,
alongside the separate [Anomalies](./anomalies) page.
:::

## When to use it

- You have examples of known conditions (e.g. "startup", "fault A", "normal") and
  want to automatically recognize them elsewhere.
- You want an *interpretable* model you can inspect and trust.

## How to use it

1. **Label** representative examples of each class.
2. **Train** the model — it learns the characteristic symbolic patterns per class.
3. **Classify** new windows; review predictions and refine labels as needed.

## Reading the results

- Predictions come with interpretable evidence (which symbolic patterns drove the
  classification).
- More and cleaner labeled examples improve accuracy.

:::note
Models are trained against the Eventhouse (read-only) and their term weights are
saved to the backend. Classification passes the model back inline, so no
Eventhouse write access is required.
:::

## Related

- [Anomalies](./anomalies) to discover candidates worth labeling.
- [Matrix Profile](./matrix-profile) for label propagation across many occurrences.
