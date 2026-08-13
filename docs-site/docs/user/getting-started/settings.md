---
id: settings
title: Settings
sidebar_position: 7
---

# Settings

Open the **Settings** pane from the gear icon in the top bar. It gathers the
personal, per-browser preferences that shape how the app displays data and how much
it queries. These settings are saved locally in your browser, so they persist across
sessions on the same machine but are not shared between users.

## Display

- **Explanations** — show or hide the inline "what am I looking at" explainer panels
  on each analysis page.
- **Chart tooltip decimal places** — how many decimals chart tooltips show.
- **Tag label format** — choose how tags are labelled across the app: **Tag name**,
  **Tag ID**, or **Tag name with ID** (shown as "Name (Id)" so tags that share a name
  stay distinguishable).
- **Max tags per multi-select** — caps how many tags can be selected at once in a
  multi-select picker. Pickers ask you to narrow your selection when this limit
  would be exceeded. This applies app-wide, including the Heatmaps page.
- **Analysis timezone** — aligns time bins, day/hour breakdowns, and chart times to
  the chosen zone. A **fixed offset** is used, so daylight-saving shifts are not
  auto-adjusted.

## Data

- **Connections** — open the connection-profile chooser to switch or manage the
  Eventhouse connection used for queries (see
  [Navigation & personas → Connections](./navigation-and-personas#connections)).
- **Visualization max points** — the ceiling on how many points (bins) charts and
  analysis pages render. It drives the [adaptive bin width](./reading-charts#adaptive-binning):
  a higher value shows more detail but can slow the browser on large ranges.
  Default **50,000**; allowed range **1,000 – 1,000,000**.
- **Pattern search max points** — the (much larger) ceiling for the
  [Matrix Profile / pattern-search wizard](/user/patterns/matrix-profile), whose
  Spark jobs can process far more points than charts render.
  Default **1,000,000**; allowed range **10,000 – 1,000,000**.

:::note
Both data-point limits are clamped to their allowed ranges. Lowering them reduces
query cost and keeps the browser responsive; raising the visualization limit lets
charts resolve finer detail on long ranges.
:::
