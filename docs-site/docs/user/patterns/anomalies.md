---
id: anomalies
title: Anomalies
sidebar_position: 1
---

# Anomalies

The **Anomalies** page finds abnormal behavior without needing a threshold. Pick
a detection **algorithm** from the selector at the top of the page — a
single-signal shape scan, or a multivariate detector that looks across several
signals at once:

- **Shape discords (one signal)** — SAX-based discord discovery ranks the rarest,
  most unusual subsequences in one signal: shapes that don't look like anything
  else in the series, even if they never breach a limit.
- **Multivariate anomaly detection (MVAD, two or more signals)** — pure-KQL
  detectors that find windows where the selected signals *jointly* deviate —
  coordinated multi-signal events a single-signal scan can miss.

:::note
Anomalies is its own page under **Patterns → Quick interactive discovery**,
alongside the separate [Classifiers](./classifiers) page.
:::

## Choosing an algorithm

The selector explains what each option is best for and when it is not ideal:

| Algorithm | Signals | Best for |
| --- | --- | --- |
| **SAX discords** | 1+ | The single most unusual repeated shape within individual signals. |
| **Residual magnitude voting** | 2+ | Coordinated point/level spikes in the residuals of several signals at the same time. |
| **Random projection ensemble** | 2+ | High-dimensional coordinated outliers across many signals; deterministic for a fixed seed. |
| **Change-point ensemble** | 2+ | Coordinated level or slope shifts (regime changes) across signals. |
| **Spectral aggregation** | 2+ | Changes in the periodic/spectral shape of the latest window vs. recent history (e.g. new vibration harmonics). |

The MVAD detectors need **at least two signals**; with a single signal selected
they're disabled and the shape-discord scan is used instead.

## Shared controls

Every algorithm shares the same signal selector, time range, and **adaptive
binning** (the bin size is chosen from the busiest selected signal, so adding
more signals doesn't over-coarsen the resolution).

For the MVAD detectors you also set a **detection window**, expressed as a whole
number of **bins** (its equivalent duration is shown beneath the field). An
**Advanced parameters** panel exposes per-algorithm tunables with sensible
defaults. Spectral aggregation needs a longer detection window (at least 32 bins)
and scores only the most recent window.

**SAX discords** has an *optional* detection window, controlled by the **Limit to
a detection window** switch:

- **Off (default) — explore mode:** the whole time range is scanned for the most
  unusual repeated shapes, wherever they occur. Use this to investigate history.
- **On — detection mode:** discords are searched for only within the most-recent
  *N* bins and scored against the earlier history, so a recent shape can be
  compared against what came before. The window must be at least the SAX **window
  size** so a full pattern fits. This mode is what an alert monitors, so you must
  enable and run it before you can create a SAX alert.

## How to use it

1. Select one or more signals and a time range.
2. Pick an **algorithm** — a single-signal shape scan, or an MVAD detector with
   two or more signals.
3. For MVAD, set the detection window (in bins) and adjust advanced parameters if
   needed. For SAX discords, leave the detection window off to explore the whole
   range, or turn it on to focus on the most-recent window (required for alerting).
4. Run the scan and review the results.

## Reading the results

- **Shape discords** — each discord is a window that is maximally different from
  the rest of the data; the top result is the most unusual shape. Inspect it in
  context and label it if it represents a meaningful event.
- **MVAD time-series detectors** (residual voting, random projection, change
  point) — a table of anomalous windows ranked by severity and score, with the
  event time, threshold, vote count, and the signals that contributed most, plus
  a line-per-signal chart that highlights the flagged windows.
- **Spectral aggregation** — a single card for the latest window (anomaly or
  normal), its score against the threshold, severity, and top contributors.
- When nothing scores as anomalous, the page says so rather than drawing an empty
  chart.

## Alerting on anomalies

After running an MVAD detector on the Anomalies page and reviewing the results,
select **Create an anomaly alert** to schedule that same detector as a Fabric
Activator (Reflex) alert. The alert re-runs the detector on a fixed schedule
entirely inside Fabric and emails you whenever a new *joint* anomaly is detected
across the selected signals — no app session needs to stay open.

In the MVAD alert dialog you set a **minimum severity** (a slider, default 1.0×).
Severity is a detector-agnostic ratio of how far an anomaly exceeds its detection
threshold, measured the same way across all MVAD detectors: 1.0× alerts on every
confirmed anomaly, while higher values alert only on progressively stronger ones,
so you can suppress marginal detections.

**SAX discords** supports alerting too, but only in detection mode: enable **Limit
to a detection window**, run the scan, then select **Create an anomaly alert**.
The button stays visible in explore mode but is disabled with a hint explaining
what to do, because an alert only makes sense against a recent window. In the SAX
alert dialog you set a **distance threshold** — a match fires when a recent
window's discord distance is at least that value. Use **Suggest threshold** to
sample the recent history and pre-fill a sensible value (for example the 90th
percentile of observed discord distances). The suggestion runs once, at authoring
time; the alert bakes in the resulting fixed number and does not recalibrate on
its own, so if the signal's normal behavior drifts you re-run the suggestion and
create an updated alert.

- The alert requires the active connection profile to be linked to a Fabric
  workspace and KQL database (set this up with **Discover from Fabric** when
  editing the profile in Settings).
- Manage the app-side pointers to these alerts on the
  [Activator Alerts](/user/activator-alerts) page. Deleting a pointer removes
  only the app record — the Fabric alert keeps running until you disable or
  delete it in Fabric.

## Related

- [Classifiers](./classifiers) to train a model once you've labeled examples.
- [Matrix Profile](./matrix-profile) for deep discord discovery over long windows.
- [Similarity search](/user/explore/similarity-search) to find recurrences of a
  discord you care about.
