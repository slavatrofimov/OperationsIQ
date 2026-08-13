---
id: signal-metadata
title: Signal metadata
sidebar_position: 10
---

# Signal metadata

**Signal metadata** is where governed per-tag information lives: operating and
spec limits, setpoints, rate limits, plausible ranges, SPC bindings, and
monitoring defaults. These values are curated once and then applied across the
whole app.

## When to use it

- You're an analyst or administrator responsible for how signals are interpreted.
- You want charts, monitoring, and validation to reflect real engineering limits.

## How to use it

1. Select a signal to edit its metadata.
2. Set the governed values — limits, setpoint, rate limit, plausible range, SPC
   baseline binding, and monitoring defaults.
3. Save. The values are persisted to the backend and **overlaid automatically**
   onto the tag catalog, every analysis page, and the assistant.

## Why it matters

Governed metadata makes "expected behavior" concrete and consistent. It powers:

- Limit lines and setpoints on charts.
- Plausibility checks in [Signal validation](./signal-validation).
- Baselines and limits in the [Control chart](./control-chart).
- Defaults for [Deviations](./deviations) and [Findings](./diagnostic-findings).

:::note
Administrators can also surface this governed metadata into the Eventhouse for
KQL-based queries. See
[Admin Guide → Configuration](/admin/configuration).
:::
