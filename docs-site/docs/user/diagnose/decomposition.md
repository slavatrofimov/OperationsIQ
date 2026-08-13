---
id: decomposition
title: Decomposition
sidebar_position: 4
---

# Decomposition

**Decomposition** splits a signal into interpretable components — typically a
**trend**, a **seasonal / cyclic** part, and a **residual** (what's left over).

## When to use it

- You want to separate a long-term trend from repeating cycles and noise.
- You're trying to understand whether a change is seasonal or a real shift.
- You want a cleaner residual to feed into anomaly detection.

## How to use it

1. Select a signal and a range long enough to capture the cycle you expect.
2. Review each component separately.

## Reading the results

- **Trend** shows the underlying direction with cycles removed.
- **Seasonal** shows the repeating pattern.
- **Residual** shows deviations from the expected structure — spikes here are
  good anomaly candidates.

## Related

- [Change points](./change-points) to locate structural shifts in the trend.
- [Forecast](/user/planning/forecast), which uses similar structure to project ahead.
