"""Exact motif-occurrence extraction (design spec §7.3).

A motif search returns each motif as its single best matching *pair* — the two most-similar
stretches. This module finds **every** stretch across the window that matches a motif's
shape, so the UI can highlight all occurrences (not just the pair) on the chart and the
aligned shape inspector, and persist them alongside the pair.

The match test is exact: the z-normalized Euclidean distance profile (MASS) of the motif's
seed subsequence against the series, thresholded relative to the motif's *pair distance* and
spaced by an exclusion zone so overlapping / trivial windows are not double-counted. Pure and
testable — one FFT per motif, negligible next to the O(n^2) matrix profile already computed.

Three shapes of series are supported, matching the three motif families:

* single-series self-join — one query window matched against one series;
* AB-join — one query window (from series A) matched against A *and* B separately, so
  occurrences in both the baseline and comparison series are reported;
* multidimensional (mSTAMP) — the participating channels are matched *jointly*, scoring each
  window by the mean per-dimension MASS distance over the motif's dimension subset (the same
  cumulative-mean distance mSTAMP itself ranks on).
"""
from __future__ import annotations

import math
from typing import Iterable, Optional, Sequence

import numpy as np

from tsmp.common.mass import mass

__all__ = [
    "match_threshold",
    "find_matches",
    "occurrences_for_query",
    "multidim_occurrences",
]


def match_threshold(
    dp: np.ndarray,
    pair_dist: float,
    factor: float = 1.5,
    percentile: float = 1.0,
) -> float:
    """Distance cut-off for "this window matches the motif shape".

    The motif's *pair distance* is the yardstick: a window counts as an occurrence when it is
    at most ``factor`` times as far from the seed as the motif's two instances are from each
    other. This mirrors the frontend's ``suggestThreshold`` heuristic (a factor of the seed's
    nearest-neighbour distance) so exact backend occurrences stay consistent with the old
    client-side estimate they replace.

    When the pair is (near-)identical (``pair_dist`` ~ 0) that would yield a degenerate ~0
    cut-off, so we fall back to a low ``percentile`` of the finite distance profile, scaled by
    ``factor``.
    """
    pd = float(pair_dist)
    if math.isfinite(pd) and pd > 0:
        return pd * float(factor)
    finite = np.asarray(dp, dtype=np.float64)
    finite = finite[np.isfinite(finite) & (finite > 0)]
    if finite.size == 0:
        return float("inf")
    return float(np.percentile(finite, percentile) * float(factor))


def find_matches(
    dp: np.ndarray,
    threshold: float,
    exclusion_zone: int,
    seed_index: Optional[int] = None,
    max_results: int = 200,
) -> list[tuple[int, float]]:
    """Greedy, non-overlapping windows whose distance-profile value is within ``threshold``.

    Windows are accepted closest-first, keeping a gap of ``exclusion_zone`` samples between
    accepted starts so trivially-shifted windows are not double-counted. When ``seed_index`` is
    supplied it is always accepted first (regardless of threshold) so the motif's own location
    leads the list; every other accepted window is spaced away from it too.

    Returns ``[(idx, dist), ...]`` sorted by ``idx`` ascending. ``dist`` is the window's
    z-normalized distance to the seed (0 for the seed itself).
    """
    dp = np.asarray(dp, dtype=np.float64)
    n = dp.shape[0]
    if n == 0:
        return []
    excl = max(1, int(exclusion_zone))

    order = [int(i) for i in np.argsort(dp, kind="stable")]
    seed = int(seed_index) if seed_index is not None and 0 <= int(seed_index) < n else None
    if seed is not None:
        order = [seed] + [i for i in order if i != seed]

    used: list[int] = []
    chosen: list[tuple[int, float]] = []
    for i in order:
        d = dp[i]
        if i != seed and (not np.isfinite(d) or d > threshold):
            continue
        if any(abs(i - u) < excl for u in used):
            continue
        used.append(i)
        chosen.append((i, float(d) if np.isfinite(d) else 0.0))
        if len(chosen) >= max_results:
            break

    chosen.sort(key=lambda t: t[0])
    return chosen


def occurrences_for_query(
    query: np.ndarray,
    target: np.ndarray,
    pair_dist: float,
    seed_index: Optional[int] = None,
    factor: float = 1.5,
    max_results: int = 200,
) -> list[tuple[int, float]]:
    """All windows of ``target`` that match ``query`` within the pair-relative threshold.

    ``seed_index`` is the location in ``target`` that should always be reported first (the
    motif's own endpoint on that series). Returns ``[(idx, dist), ...]`` by ``idx`` ascending.
    """
    q = np.asarray(query, dtype=np.float64)
    t = np.asarray(target, dtype=np.float64)
    m = q.shape[0]
    if m < 1 or m > t.shape[0]:
        return []
    dp = mass(q, t)
    thr = match_threshold(dp, pair_dist, factor)
    excl = max(1, math.ceil(m / 2))
    return find_matches(dp, thr, excl, seed_index=seed_index, max_results=max_results)


def multidim_occurrences(
    series_2d: np.ndarray,
    idx_a: int,
    m: int,
    dims: Sequence[int] | Iterable[int],
    pair_dist: float,
    factor: float = 1.5,
    max_results: int = 200,
) -> list[tuple[int, float]]:
    """All occurrences of a multidimensional motif on the shared clock.

    A window matches when the motif's *participating* channels (``dims``) jointly resemble the
    seed window at ``idx_a``. Each window is scored by the mean per-dimension MASS distance over
    ``dims`` — the same cumulative-mean, ``n_dims``-dimensional distance mSTAMP ranks motifs on
    — and thresholded against the motif's k-dimensional ``pair_dist``. Non-participating
    channels are ignored, so the reported occurrences are exactly where *that subspace* repeats.
    """
    a = np.asarray(series_2d, dtype=np.float64)
    if a.ndim == 1:
        a = a.reshape(1, -1)
    d, n = a.shape
    valid_dims = [int(x) for x in dims if 0 <= int(x) < d]
    if m < 1 or idx_a < 0 or idx_a + m > n or not valid_dims:
        return []

    acc: Optional[np.ndarray] = None
    for dim in valid_dims:
        dpi = mass(a[dim, idx_a : idx_a + m], a[dim])
        acc = dpi if acc is None else acc + dpi
    assert acc is not None
    combined = acc / float(len(valid_dims))

    thr = match_threshold(combined, pair_dist, factor)
    excl = max(1, math.ceil(m / 2))
    return find_matches(combined, thr, excl, seed_index=idx_a, max_results=max_results)
