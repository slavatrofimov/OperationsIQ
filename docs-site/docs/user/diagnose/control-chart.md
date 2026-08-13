---
id: control-chart
title: Control chart
sidebar_position: 7
---

# Control chart

The **Control chart** applies Statistical Process Control (SPC) to a signal:
it plots the measurement against a baseline mean and control limits, and flags
points or runs that violate SPC rules.

## When to use it

- You want to know whether a process is "in control" statistically.
- You need early warning of drift before values breach hard limits.
- You want defensible, rule-based flagging rather than eyeballing.

## How to use it

1. Select a signal.
2. Establish or select a **baseline** period that represents normal operation.
3. Review the chart: the center line is the baseline mean; the upper/lower
   control limits bound expected variation.

## Reading the results

- Points outside the control limits, or runs/trends on one side of the center
  line, indicate the process may be out of control.
- A baseline drawn from an unrepresentative period will produce misleading limits
  — choose it carefully.

## Related

- [Signal metadata](./signal-metadata) to bind SPC baselines and limits to a tag.
- [Deviations](./deviations) for a broader health view.
