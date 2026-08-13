---
id: forecast
title: Forecast
sidebar_position: 1
---

# Forecast

**Forecast** projects a signal into the future based on its historical behavior,
typically with an uncertainty band around the expected path.

## When to use it

- You want an estimate of where a measurement is heading.
- You're planning capacity, maintenance, or resource needs.
- You want early warning that a signal is trending toward a limit.

## How to use it

1. Select the signal to forecast.
2. Choose the history window to learn from and the horizon to project.
3. Review the forecast and its uncertainty band.

## Reading the results

- The central line is the expected path; the band shows the range of likely
  outcomes — wider bands mean more uncertainty.
- Forecasts assume the future resembles the learned history; structural changes
  (see [Change points](/user/diagnose/change-points)) can invalidate them.

## Related

- [What-if](./what-if) to explore how changing drivers shifts the outlook.
- [Decomposition](/user/diagnose/decomposition) to understand the trend and
  seasonality behind a forecast.
