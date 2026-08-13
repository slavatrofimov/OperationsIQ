---
id: glossary
title: Glossary
sidebar_position: 10
---

# Glossary

Key terms used across Operations IQ.

**Signal / Tag** — a single time-series measurement (e.g. a temperature or
pressure reading) from a piece of equipment.

**Eventhouse** — the Fabric KQL database holding your raw time-series data.
Operations IQ reads from it; it never writes to it.

**Rayfin** — the Fabric Apps backend-as-a-service where your work (labels, saved
searches, models, investigations) is persisted.

**Adaptive binning** — automatically choosing a data resolution appropriate to the
current zoom level so long ranges stay fast and readable.

**Spectrogram** — a Short-Time Fourier Transform (STFT) heatmap showing how a
signal's frequency content changes over time (time on the x-axis, frequency on the
y-axis, magnitude as color); see [Spectrum](/user/explore/spectrum).

**Live view** — an auto-refreshing chart of one or more signals over a rolling
window that always ends at "now"; see [Live view](/user/explore/live-view).

**Subsequence** — a contiguous window of a signal; the unit used for similarity
search and pattern discovery.

**SAX (Symbolic Aggregate approXimation)** — a method that converts a numeric
subsequence into a short symbolic "word", enabling fast shape comparison.

**Motif** — a shape that recurs frequently in a signal (the process "vocabulary").

**Discord** — the opposite of a motif: a rare, unusual subsequence; used for
anomaly discovery.

**Matrix Profile** — a computation that, for every subsequence, records its
distance to its nearest neighbor; the basis for finding motifs and discords.

**MOMP / DAMP / PAN-MP** — Spark algorithms used for scalable matrix-profile
motif and discord discovery over long windows.

**SAX-VSM** — an interpretable classification method combining SAX with a Vector
Space Model of term weights.

**SPC (Statistical Process Control)** — the statistics behind the
[Control chart](/user/diagnose/control-chart): a baseline mean and control limits
with rule-based violation detection.

**z-normalization (znorm)** — rescaling a subsequence to zero mean and unit
variance so shapes are compared regardless of absolute level.

**Regime** — a contiguous period of internally-consistent behavior; the output of
[Segmentation](/user/patterns/segmentation).

**Change point** — a moment where a signal's statistical behavior shifts.

**Persona** — a role-based configuration (Production engineer, Operations analyst,
Field technician) that tailors navigation to how you work.
