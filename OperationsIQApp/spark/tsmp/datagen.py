"""Synthetic time-series generators with planted motifs and discords for testing."""
from __future__ import annotations

import numpy as np

__all__ = ["random_walk", "planted_motif", "planted_discord", "regime_series", "drifting_chain"]


def random_walk(n: int, seed: int | None = None, scale: float = 1.0) -> np.ndarray:
    """A length-``n`` random-walk (cumulative Gaussian) series."""
    rng = np.random.default_rng(seed)
    return np.cumsum(rng.standard_normal(n)) * scale


def planted_motif(
    n: int,
    m: int,
    loc_a: int,
    loc_b: int,
    seed: int | None = None,
    noise: float = 0.05,
    amplitude: float = 3.0,
) -> np.ndarray:
    """Random-walk background with a sinusoidal motif planted at two locations.

    The two inserted patterns are identical up to a small amount of noise, so the
    exact top-1 motif pair is ``(loc_a, loc_b)`` by construction.
    """
    rng = np.random.default_rng(seed)
    t = np.cumsum(rng.standard_normal(n))
    cycle = amplitude * np.sin(np.linspace(0, 2 * np.pi, m, endpoint=False))
    for loc in (loc_a, loc_b):
        seg = cycle + noise * rng.standard_normal(m)
        # Splice so the motif shape dominates while preserving local continuity.
        t[loc : loc + m] = t[loc] + (seg - seg[0])
    return t


def planted_discord(
    n: int,
    m: int,
    loc: int,
    seed: int | None = None,
    amplitude: float = 8.0,
) -> np.ndarray:
    """A smooth periodic series with a single anomalous burst planted at ``loc``.

    The burst is a high-frequency chirp unlike anything else in the series, so the
    exact top-1 discord is at ``loc``.
    """
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 40 * np.pi, n)
    t = np.sin(x) + 0.1 * rng.standard_normal(n)
    burst = amplitude * np.sin(np.linspace(0, 12 * np.pi, m))
    t[loc : loc + m] += burst
    return t


def regime_series(
    seg_len: int,
    cycles_a: int = 4,
    cycles_b: int = 12,
    seed: int | None = None,
    noise: float = 0.05,
) -> tuple[np.ndarray, int]:
    """Two concatenated regimes (different oscillation frequency) for segmentation tests.

    The first ``seg_len`` samples oscillate slowly (``cycles_a`` cycles); the second
    ``seg_len`` samples oscillate faster (``cycles_b`` cycles). The single true regime
    boundary is at index ``seg_len``. Returns ``(series, boundary_index)``.
    """
    rng = np.random.default_rng(seed)
    a = np.sin(np.linspace(0, 2 * np.pi * cycles_a, seg_len, endpoint=False))
    b = np.sin(np.linspace(0, 2 * np.pi * cycles_b, seg_len, endpoint=False))
    series = np.concatenate([a, b]) + noise * rng.standard_normal(2 * seg_len)
    return series, seg_len


def drifting_chain(
    n: int,
    m: int,
    period: int,
    seed: int | None = None,
    noise: float = 0.02,
    drift: float = 0.15,
    amp_growth: float = 0.1,
) -> tuple[np.ndarray, list[int]]:
    """A series with a motif that recurs every ``period`` samples while slowly drifting.

    Each recurrence keeps a sinusoidal base but a second harmonic grows linearly per link
    (``drift``), so the *shape* morphs gradually — the change survives z-normalization, so
    consecutive occurrences are each other's nearest neighbors and they link into a
    time-series chain. The raw amplitude also grows (``amp_growth``) so the head→tail
    "degradation" is measurable off the un-normalized signal. Head and tail look markedly
    different: the canonical slow-degradation signature. Returns
    ``(series, planted_link_indices)``.
    """
    rng = np.random.default_rng(seed)
    t = noise * rng.standard_normal(n)
    theta = np.linspace(0, 2 * np.pi, m, endpoint=False)
    base = np.sin(theta)
    harm = np.sin(2 * theta)
    locs: list[int] = []
    link = 0
    loc = period
    while loc + m <= n:
        c = drift * link
        amp = 1.0 + amp_growth * link
        seg = amp * (base + c * harm) + noise * rng.standard_normal(m)
        t[loc : loc + m] = seg
        locs.append(loc)
        link += 1
        loc += period
    return t, locs

