---
id: segmentation
title: Segmentation
sidebar_position: 3
---

# Segmentation

**Segmentation** breaks a signal into distinct **regimes** — contiguous stretches
where behavior is internally consistent but differs from neighboring stretches.

## When to use it

- You want to divide operation into meaningful phases (idle, ramp, steady, shutdown).
- You're preparing to analyze each regime separately.
- You want to see how often and when the process switches modes.

## How to use it

1. Select a signal and time range.
2. Review the detected segments/regimes on the timeline.

## Reading the results

- Each segment represents a period of consistent behavior.
- Frequent switching may indicate instability; long stable segments indicate
  steady operation.

## Related

- [Change points](/user/diagnose/change-points) for detecting individual shifts.
- [Matrix Profile](./matrix-profile) multi-sensor segmentation across signals.
