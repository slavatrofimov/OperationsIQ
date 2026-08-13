---
id: signal-validation
title: Signal validation
sidebar_position: 8
---

# Signal validation

**Signal validation** checks the **quality and plausibility** of your data —
catching frozen sensors, out-of-range values, gaps, and other data-integrity
issues before they mislead an analysis.

## When to use it

- Before trusting a signal for diagnosis, forecasting, or alerting.
- When results look strange and you suspect a data problem, not a process problem.
- As a routine data-quality sweep.

## How to use it

1. Select the signals to validate.
2. Review the validation findings (e.g. flatlines, spikes, out-of-range,
   missing data) against the signal's plausible range and rate limits.
3. When a result warrants follow-up, choose **Record Finding** to send the
   validation verdict (with its bias, max |z|, out-of-bounds fraction, fit R²,
   and reference signals) to [Diagnostic Findings](./diagnostic-findings) for triage and
   handoff.

## Reading the results

- Flagged issues point to data quality problems to resolve or exclude.
- Plausibility checks rely on governed [signal metadata](./signal-metadata) —
  keeping that metadata accurate improves validation.

## Related

- [Signal metadata](./signal-metadata) to define plausible ranges and rate limits.
- [Diagnostic Findings](./diagnostic-findings) to triage and hand off recorded findings.
