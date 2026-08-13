---
id: derived-metrics
title: Derived metrics
sidebar_position: 8
---

# Derived metrics

**Derived metrics** let you compute new signals from existing ones — for example
a ratio, a difference, a rolling average, or a rate of change — and then analyze
the result like any other signal.

## When to use it

- The measurement you actually care about isn't stored directly, but can be
  computed (e.g. efficiency = output ÷ input).
- You want a smoothed or rate-of-change version of a noisy signal.
- You want to combine several tags into a single indicator.

## How to use it

1. Choose the source signal(s).
2. Define the derivation (the transformation or combination to apply).
3. The derived signal becomes available to explore, chart, and analyze.

## Reading the results

- Treat the derived signal like any other: chart it, compare it, monitor it, or
  feed it into pattern discovery.

## Related

- [Signal metadata](/user/diagnose/signal-metadata) to govern limits on the
  signals you derive from.
- [Compare](./compare) to view a derived metric alongside its sources.
