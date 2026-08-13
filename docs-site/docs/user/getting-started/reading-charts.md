---
id: reading-charts
title: Reading charts
sidebar_position: 4
---

# Reading charts

Most modules render interactive charts (built on ECharts). A few conventions
apply across the app.

## Adaptive binning

When you view a long time range, Operations IQ automatically **bins** the data
to a sensible resolution so the chart stays fast and readable. As you zoom in,
the binning adapts to show more detail. This means the number of points you see
is optimized for the current view rather than dumping every raw sample.

How fine the binning can get is bounded by the **Visualization max points**
setting (see [Settings → Data](/user/getting-started/settings#data)); raising it
lets charts resolve more detail on long ranges, at some cost to browser
responsiveness. Bin widths can go all the way down to **millisecond** resolution
for very high-frequency signals.

When you pick a time range with the **Select visually** overlay, choosing a date
beyond the preview chart's current bounds automatically widens and re-queries the
preview so your selection stays visible.

## Time brushing (brush-to-zoom)

Click and drag horizontally across a chart to **brush** a time window. Depending
on the module this will:

- Zoom the view to that window, or
- Select a **subsequence** to use as a query (for example in
  [Similarity search](/user/explore/similarity-search)).

## Overlays

Charts can overlay additional context on top of the raw signal, such as:

- **Anomaly / event markers** highlighting notable points.
- **Control limits and baselines** (in the [Control chart](/user/diagnose/control-chart)).
- **Aligned tracks** when comparing multiple signals.

## Exporting

Where supported, you can add the current view to an
[Investigation](/user/investigations), which saves each chart as a PNG plus its
underlying data as CSV so your evidence is preserved and searchable later.

## Tips

- Hover any series to see exact values in the tooltip.
- Use the chart's zoom/reset controls to return to the full range.
- If a chart looks empty, widen the time range or check your signal selection.
