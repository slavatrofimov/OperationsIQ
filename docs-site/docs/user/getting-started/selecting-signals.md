---
id: selecting-signals
title: Selecting signals
sidebar_position: 5
---

# Selecting signals (tags)

A **signal** (or **tag**) is a single time-series measurement — for example a
temperature, pressure, flow, or vibration reading from a piece of equipment.
Nearly every module begins by choosing one or more signals and a time range.

## The tag browser

Use the tag browser / picker to find signals by name, description, or hierarchy.
Depending on your deployment, tags may be organized by asset hierarchy (site →
area → unit → equipment) so you can drill down to the measurement you need. On the
Explore and Live view pages, the tags you pick are also shown as an always-visible,
comma-delimited summary above the tree so you can see your current selection at a
glance.

How many tags you can select at once is governed by the **Max tags per
multi-select** setting (see [Settings → Display](/user/getting-started/settings#display));
a picker asks you to narrow your selection when that limit would be exceeded.

## Governed metadata

Signals can carry governed **metadata** — operating and spec limits, setpoints,
rate limits, plausible ranges, and monitoring defaults. When present, these
values are overlaid automatically across the app (for example as limit lines on
charts and defaults in monitoring). Administrators and analysts curate this in
[Signal metadata](/user/diagnose/signal-metadata).

## Choosing a time range

Pick the period you want to analyze. Some guidance:

- Start **wide** to see context, then brush to zoom into the interesting window.
- Very long ranges are automatically binned (see [Reading charts](./reading-charts)),
  so you can safely start broad.
- Modules that compute over windows (forecasting, pattern discovery) may take
  longer on very large ranges.

## Multivariate selection

Several modules accept **two or more** signals at once — for example multivariate
[Similarity search](/user/explore/similarity-search),
[Compare](/user/explore/compare), and multi-sensor
[Patterns](/user/patterns/matrix-profile). Select each signal you want included
in the analysis.
