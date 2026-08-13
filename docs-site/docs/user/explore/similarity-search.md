---
id: similarity-search
title: Similarity search
sidebar_position: 5
---

# Similarity search

**Similarity search** lets you brush a shape you care about (a subsequence) and
find where that shape recurs — on the same signal, or across other assets.

## When to use it

- "I've seen this signature before — where else does it happen?"
- You want to find all occurrences of a startup ramp, a fault signature, or a
  characteristic cycle.
- You want to check whether a pattern on one asset also appears on another.

## Single-signal search

1. Brush a **subsequence** on the chart to define your query shape.
2. Pick a **search space** (the signal(s) and time range to scan).
3. Rank the matches. Each result shows how closely it matches your query and
   where it occurred, with aligned timelines for easy comparison.

## Find more like these (from a discovered pattern)

When automated [pattern discovery](/user/patterns/) surfaces a motif or anomaly
you care about, you don't have to re-brush it by hand. In the pattern results,
choose **Find more like these** to jump straight to a Similarity search that is
already seeded from that discovered shape:

- **Prefilled query.** The pattern's time window becomes the query pattern, and
  its signal(s) become the query tag(s).
- **Multidimensional patterns are fully supported.** For a multi-sensor event or
  anomaly, *every* participating sensor (track) is carried over as a query tag, so
  the follow-up search looks for the same joint shape across all of them — not just
  the one driving signal.
- **Granularity is locked.** The search is pinned to the exact temporal
  resolution (bin width) the pattern was discovered at, and the granularity control
  is locked with a note explaining why. This guarantees the follow-up search
  compares shapes at the same resolution the pattern was found — unlike a free-form
  search, where the resolution is derived from the width of the search window.
- **Stays performant.** If your search window is wide enough that the locked
  resolution would exceed the max-points budget, the app warns you and offers to
  shorten the window so the query stays fast without changing the locked bin. You
  can **Unlock** at any time to return to a normal free-form search.

Once the seeded search completes, everything else works exactly as a normal
search — including **Create an Activator Alert** (below), whose generated KQL
naturally inherits the locked granularity and, for a multidimensional seed, the
multi-track search.

## Multivariate search

Select **two or more** query signals to search for a combined pattern. There are
two modes:

- **Recurrence** — scan the *same* tags for their combined pattern recurring over
  time.
- **Explicit tag mapping** — map each query tag to a *different* search-space tag
  to find the pattern on another asset (for example, comparing two pumps).

Results include per-track shape comparison and aligned timelines so you can see
how each dimension of the pattern matches.

## Parameters: smart defaults

You don't need to understand the underlying SAX settings to get good results.
When you click **Review query pattern**, the app looks at the shape you selected —
how many samples it spans and how much it varies — and fills in sensible starting
values for you. A **Smart defaults applied** note lists what changed and why, and
a **Reset to suggested** button restores them at any time. Anything you edit by
hand is respected and never overwritten when you review again.

The parameters are split into two groups:

- **Basic** — the handful of controls most people touch: **Top K** (how many
  matches to return) and **Duration flexibility** (how much faster or slower a
  version of the shape still counts as a match). A read-only summary shows the
  auto-tuned encoding settings at a glance.
- **Advanced** — every raw knob, pre-filled from the smart defaults and fully
  overridable: the SAX word length, alphabet size, scale sweep, symbol tolerance,
  and the z-norm floor (plus the multivariate timing controls).

### Why the z-norm floor is scale-relative

The **z-norm threshold** decides when a window is "too flat to have a shape" and
is compared against your pattern's raw variability **in the signal's own units**.
A single fixed value (say `0.01`) means completely different things for a signal
that swings by thousands versus one that swings by fractions — so it isn't
scale-invariant. Smart defaults instead set it to a small fraction (~3%) of your
query's standard deviation, so the flatness floor always matches your data's
scale. For a nearly flat query it falls back to a tiny positive floor.

Two other defaults are worth knowing:

- **Query length (symbols)** is derived from your pattern's sample count so each
  symbol averages a few points, and is capped so it never exceeds the shortest
  window the search can match.
- **Symbol tolerance** defaults to **0**, which selects the fast, exact matcher.
  Raising it above 0 switches to a slower symbolic pre-filter that can occasionally
  prune true matches — use it only to deliberately allow looser near-misses.

## Create an Activator alert from a search

Once a search completes, choose **Create an Activator Alert** to turn it into a
scheduled [Fabric Activator](https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-introduction)
(Reflex) alert that re-runs entirely inside Fabric and emails you on each new
match. Nothing runs in the browser at alert time — the whole search executes
**server-side as KQL** on the schedule you pick.

How it works:

- **Self-contained query.** The reviewed query shape is captured and **embedded
  inline** in the generated KQL (as a datatable of the binned values), so the
  alert never depends on the original series still being available. The **search
  space stays live**: every run rebuilds it from the current data over a rolling
  window and re-runs the SAX similarity search, inheriting the exact time
  granularity (bin) of your search.
- **UTC, incremental lookback.** The generated query uses only relative
  `ago()/now()` bounds (all times are UTC). Each run looks back just far enough to
  cover the time since the previous run plus the length of your pattern —
  `lookback = frequency + (patternSamples − 1) × bin` — so a match that straddles
  a run boundary is still found without rescanning history.
- **Run frequency.** Pick how often the search runs — 1 minute up to 1 day.
- **Condition.** Always **On each event**: every match the scheduled search
  returns emails you once.
- **Action — Email.** The alert emails **you** (your signed-in account). You set
  the **subject** (the matched signal id(s) are appended automatically), the
  **headline**, and the **notes** — which are prefilled with the search method and
  a complete, reproducible parameter list (connection profile, signals, and all
  SAX + binning settings). The result **context columns** are preset. To switch
  the action to Teams or a pipeline, or change the context columns, open the
  Activator item in Fabric after creating it.
- **Save location.** The alert is created in the **same Fabric workspace** as your
  active connection profile, and the **source KQL database** is taken automatically
  from that profile — there are no workspace or database pickers. You only choose
  whether to create a **new** Activator or add the rule to an **existing** one.

:::important
The workspace and source KQL database are resolved from Fabric identifiers that
the connection profile captures during **Discover from Fabric** (Settings → edit
the profile → **Discover from Fabric**). A profile created by entering the
Eventhouse endpoint manually — or one created before this capability existed —
isn't linked to those identifiers, so the dialog can't create an alert. Re-open
the profile and run **Discover from Fabric** (selecting the workspace, Eventhouse,
and database) to enable Activator alerts.
:::

Created alerts are listed under the top-level **Activator Alerts** menu item, each
with a link that opens the Activator in Fabric.

:::note
Deleting an alert from the Activator Alerts list removes only the app-side
pointer. The Fabric Activator item, its rule, and its schedule keep running — stop
them from within Fabric.
:::

## Reading the results

- Matches are ranked by similarity — the top results are the closest shapes.
- Use the aligned comparison to confirm a match is meaningful, not coincidental.
- Save useful queries so you can re-run them later.

## Related

- [Compare](./compare) to line up signals you already know you want to see together.
- [Patterns](/user/patterns/) for automated discovery of recurring shapes without
  a seed query.
