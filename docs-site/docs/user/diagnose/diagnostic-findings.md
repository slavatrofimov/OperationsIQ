---
id: diagnostic-findings
title: Diagnostic Findings
sidebar_position: 9
---

# Diagnostic Findings

**Diagnostic Findings** is the human-curated review queue where diagnostics you
record from other pages are triaged and handed off, so follow-up work is tracked
in one place. It lives under **Diagnose → Health monitoring**, between
**Signal validation** and **Signal metadata**. Health-monitoring tools such as
[Deviations](./deviations), the [control chart](./control-chart), and
[Signal validation](./signal-validation) can each **Record Finding** into this
queue.

## When to use it

- You recorded a diagnostic from [Deviations](./deviations),
  [Signal validation](./signal-validation), or the control chart and need to
  triage or hand it off.
- You're managing a set of open findings across assets.

## How to use it

1. Open **Diagnose → Diagnostic Findings**.
2. Review active findings and their status.
3. Acknowledge, suppress, or close a finding, and export an evidence bundle or
   work-order document for handoff. Recorded findings build on governed limits and
   monitoring defaults from [Signal metadata](./signal-metadata).

## Reading the results

- Active findings show what was recorded, when, and against which signal.
- Use them as an entry point into [Root cause](./root-cause) or an
  [Investigation](/user/investigations).

## Related

- [Deviations](./deviations) for on-demand health checks.
- [Signal metadata](./signal-metadata) to define the limits findings build on.
- [Activator Alerts](/user/activator-alerts) for scheduled, server-side alerts
  (distinct from these human-curated findings).
