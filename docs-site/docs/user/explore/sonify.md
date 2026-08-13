---
id: sonify
title: Sonify
sidebar_position: 9
---

# Sonify

**Sonify** turns a single signal into sound so you can *hear* its shape — trends,
cycles, and anomalies — as a short melody. It extends the app's SAX (Symbolic
Aggregate approXimation) idea from letters into music: instead of binning a
value's amplitude into a letter, Sonify maps it to a musical pitch.

The mapping is:

- **Value → pitch** — normalized, centered on middle C, and snapped to a musical
  scale.
- **A feature → loudness** — by default the deviation from the signal's baseline,
  so anomalies get louder.
- **Time → note onset** — a fixed notes-per-second tempo.

Consecutive samples that map to the same note are merged into one **sustained**
note; a change re-articulates a new, distinct note. Gaps in the data become
**rests** (silence).

## When to use it

- You want an accessible, hands-free channel to review a signal — listen while
  watching something else.
- You're looking for structure the eye skims past: a slow drift, a repeating
  cycle, or an isolated spike that "sounds wrong."
- You want a complementary confirmation of what a chart shows.

## How to use it

1. Pick a signal and a time range (the first selected signal is played).
2. Choose **Load** to fetch and render the series.
3. Press **Play**. Use **Pause** and **Stop** to control playback.
4. Adjust the controls and the melody re-renders:
   - **Scale** — pentatonic (default, always consonant), major, chromatic (most
     literal), or continuous (no snapping).
   - **Octave span** — how wide a pitch range the values map across.
   - **Tempo** — notes per second.
   - **Timbre** — the oscillator waveform (sine, triangle, square, sawtooth).
   - **Loudness** — deviation from baseline (default), rate of change, magnitude,
     or fixed.
   - **Max notes** — long series are aggregated down to this many notes so
     playback stays short and clear.

## Reading (and hearing) the results

- **Rising pitch** means a rising value; a **flat stretch** holds one sustained
  note; a **jump** starts a new note.
- With the default loudness source, notes grow **louder where the signal deviates
  from its baseline**, so anomalies pop out audibly.
- A **line chart** of the signal is shown alongside the player. A moving
  **playhead**, a glowing **"now playing" dot** on the curve, and a live **note
  name** (e.g. `C4`) stay in sync with the audio, so what you hear always lines up
  with a point in time.

## Notes

- Playback uses your browser's built-in Web Audio engine; no plugin or download
  is required. If your browser doesn't support it, the chart still works.
- Sonify plays one signal at a time today; the design leaves room to add more
  voices later.
