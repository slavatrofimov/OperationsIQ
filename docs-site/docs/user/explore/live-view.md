---
id: live-view
title: Live view
sidebar_position: 2
---

# Live view

**Live view** streams one or more signals over a rolling window that always ends
at "now" and refreshes on an interval you choose — like an operations wall-board.
Use it to watch current behavior without picking fixed start and end times.

## When to use it

- You want to watch a signal update automatically as new data arrives.
- You're keeping an eye on current conditions during a run, test, or shift.
- You want a quick, always-current readout rather than a fixed historical window.

## How to use it

1. Select one or more [signals](/user/getting-started/selecting-signals). The
   selected tags are listed as a comma-delimited summary above the tag tree.
2. Set the **trailing window** length (for example, last 15 minutes). It is
   re-anchored to the current time on every refresh, so the view always tracks the
   latest data.
3. Choose how often it should **refresh**. The header shows a live indicator with a
   countdown to the next refresh and a "Last updated" readout that ticks every
   second.
4. If your data is very high-frequency, use the aggregation and resolution controls
   to pre-aggregate it into a readable trace.

## Reading the results

- The **live chart** redraws each cycle with freshly queried data for the current
  trailing window.
- The **descriptive statistics** panel (count, min, max, mean, median, standard
  deviation, and 5th/95th percentiles) is recomputed for each signal on every
  refresh.

## How it works

On every refresh the whole trailing window is re-queried from the Eventhouse and
the chart series are replaced wholesale — there is no incremental "tailing". The
window length comes from the relative selector; the absolute start/end is
re-anchored to the current time each cycle.

## Related

- [Overview](./overview) for exploring a fixed historical range.
- [Reading charts](/user/getting-started/reading-charts) for adaptive binning and
  resolution.
