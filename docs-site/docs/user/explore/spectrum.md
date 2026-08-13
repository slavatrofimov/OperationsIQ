---
id: spectrum
title: Spectrum
sidebar_position: 4
---

# Spectrum

The **Spectrum** view moves from the time domain into the **frequency domain**,
helping you detect cycles and periodic behavior that are hard to see in a raw
time plot.

## When to use it

- You suspect a signal has a repeating cycle (daily, shift-based, rotational).
- You want to identify the dominant frequency or period in a measurement.
- You're diagnosing oscillations or resonance.

## How to use it

1. Select a signal and a representative time range.
2. Inspect the spectrum for peaks — each peak corresponds to a recurring cycle.

## Reading the results

- A strong peak indicates a dominant period; its position tells you *how often*
  the pattern repeats.
- Multiple peaks suggest several overlapping cycles.

## Spectrogram (how the spectrum changes over time)

Below the spectrum, Operations IQ also renders a **spectrogram** — a Short-Time
Fourier Transform (STFT) heatmap that shows how the frequency content evolves
across the selected window. Time runs along the horizontal axis, frequency up the
vertical axis, and color encodes magnitude, so you can see cycles start, stop, or
drift rather than just their average strength.

Two toolbar toggles control the scales:

- **Freq: Linear / Log** switches the frequency (vertical) axis between linear and
  logarithmic. Log is useful when meaningful frequencies span several orders of
  magnitude.
- **Mag: Linear / Log** switches the magnitude (color) scale between linear and
  `log10`. Log magnitude brings out weak bands that a linear scale would bury.

The toggles are display-only: tooltips and CSV/table exports keep the true linear
frequency and magnitude values regardless of the toggle state.

## Related

- [Heatmaps](./heatmaps) to visualize daily/weekly rhythms.
- [Patterns](/user/patterns/) to find the actual recurring shapes behind a cycle.
