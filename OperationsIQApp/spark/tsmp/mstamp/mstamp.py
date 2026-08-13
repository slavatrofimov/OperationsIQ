"""mSTAMP — the multidimensional matrix profile (design spec: P2 multi-series).

Given ``d`` time-aligned sensor channels of a *single* asset (all resampled onto a common
clock, so column ``t`` of every channel is the same instant) and a subsequence length
``m``, mSTAMP computes the ``d``-dimensional matrix profile (Yeh et al., "Matrix Profile
VI: Meaningful Multidimensional Motif Discovery").

The key idea: for a query window ``i`` and a candidate neighbour ``j`` there are ``d``
per-dimension z-normalized distances (one MASS distance per channel). Sorting those ``d``
distances ascending and taking the *mean of the k smallest* gives the ``k``-dimensional
distance of the pair — the cost of the best ``k``-of-``d`` channel subset that agrees on
this match. Minimising over ``j`` yields, for every ``k`` in ``1..d``:

* ``mp[k-1]``  — the ``k``-dimensional matrix profile (nearest-neighbour distance per window),
* ``mpi[k-1]`` — the index of that nearest neighbour.

``mp[0]`` is the single best channel at each location; ``mp[d-1]`` requires *all* channels
to agree. A **motif** at dimensionality ``k`` is the strongest repeat that ``k`` channels
share, and the *participating* channels are the ``k`` with the smallest per-dimension
distance for that matched pair — this is the "which sensors took part" answer.

The heavy O(d·n^2) work fans out across the injected ``mapper`` by blocking over query
windows ``i`` (mirroring :mod:`tsmp.abjoin.abjoin`); the block split only affects task
granularity, never the result.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Optional

import numpy as np

from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone

__all__ = [
    "MStampProfile",
    "MDimMotif",
    "MDimDiscord",
    "mstamp",
    "mstamp_motifs",
    "mstamp_discords",
    "participating_dims",
]

Mapper = Callable[[Callable, Iterable], Iterable]


@dataclass
class MStampProfile:
    """The multidimensional matrix profile over ``d`` aligned channels.

    ``mp`` and ``mpi`` are both shaped ``(d, profile_len)``: row ``k-1`` is the
    ``k``-dimensional matrix profile / nearest-neighbour index (``k`` channels agreeing).
    """

    mp: np.ndarray    # (d, profile_len) k-dimensional nearest-neighbour distance
    mpi: np.ndarray   # (d, profile_len) index of that neighbour (-1 if none)
    m: int            # subsequence length
    minlag: int       # trivial-match exclusion radius used


@dataclass
class MDimMotif:
    """A multi-sensor repeating pattern (rank 1 = strongest).

    ``idx_a`` / ``idx_b`` are the two matched window starts on the common clock;
    ``n_dims`` is how many channels participate and ``dims`` lists them (best-agreeing
    first); ``dist`` is the ``n_dims``-dimensional distance of the pair.
    """

    idx_a: int
    idx_b: int
    dist: float
    n_dims: int
    dims: list[int]
    dim_dists: list[float]


@dataclass
class MDimDiscord:
    """A multi-sensor novelty: a window unlike anything else across ``n_dims`` channels."""

    index: int
    nn_distance: float
    nn_index: int
    n_dims: int
    dims: list[int]
    dim_dists: list[float]


def _profile_len(n: int, m: int) -> int:
    return max(0, n - m + 1)


def _as_2d(series: np.ndarray) -> np.ndarray:
    arr = np.asarray(series, dtype=np.float64)
    if arr.ndim != 2:
        raise ValueError("series must be 2-D (d channels x n samples)")
    if arr.shape[0] < 1:
        raise ValueError("series must have at least one channel")
    return arr


def _row_blocks(plen: int, n_blocks: int) -> list[tuple[int, int, int]]:
    """Split query range ``[0, plen)`` into ``n_blocks`` contiguous ``(bid, lo, hi)`` tasks."""
    n_blocks = max(1, min(n_blocks, plen))
    bounds = np.linspace(0, plen, num=n_blocks + 1).astype(int)
    blocks: list[tuple[int, int, int]] = []
    for b in range(n_blocks):
        lo, hi = int(bounds[b]), int(bounds[b + 1])
        if hi > lo:
            blocks.append((len(blocks), lo, hi))
    return blocks


def mstamp(
    series: np.ndarray,
    m: int,
    minlag: Optional[int] = None,
    n_blocks: int = 1,
    mapper: Mapper = map,
) -> MStampProfile:
    """Compute the multidimensional matrix profile of ``d`` aligned channels.

    ``series`` is a ``(d, n)`` array whose columns are aligned in time. Exact and identical
    for any ``n_blocks`` (block count only changes task granularity). Requires ``m`` to fit
    inside the series length.
    """
    a = _as_2d(series)
    d, n = a.shape
    m = int(m)
    if m < 1:
        raise ValueError("m must be >= 1")
    if m > n:
        raise ValueError("m must be <= the series length")
    excl = exclusion_zone(m) if minlag is None else int(minlag)

    plen = _profile_len(n, m)
    if plen == 0:
        empty_mp = np.full((d, 0), np.inf)
        empty_mpi = np.full((d, 0), -1, dtype=np.int64)
        return MStampProfile(mp=empty_mp, mpi=empty_mpi, m=m, minlag=excl)

    ks = np.arange(1, d + 1, dtype=np.float64)[:, None]  # (d, 1) divisors for the running mean

    def _task(block: tuple[int, int, int]):
        bid, i_lo, i_hi = block
        width = i_hi - i_lo
        p_block = np.full((d, width), np.inf)
        i_block = np.full((d, width), -1, dtype=np.int64)
        for col, i in enumerate(range(i_lo, i_hi)):
            # Per-dimension z-normalized distance profiles for query window i.
            dmat = np.empty((d, plen), dtype=np.float64)
            for dim in range(d):
                dmat[dim] = mass(a[dim, i : i + m], a[dim])
            # Suppress trivial self-matches on the shared clock (same window across dims).
            lo = max(0, i - excl)
            hi = min(plen, i + excl + 1)
            dmat[:, lo:hi] = np.inf
            # k-dimensional distance at each neighbour j = mean of the k smallest
            # per-dimension distances → cumulative mean over sorted dims.
            dsorted = np.sort(dmat, axis=0)
            kdist = np.cumsum(dsorted, axis=0) / ks  # (d, plen); row k-1 is the k-dim profile
            jstar = np.argmin(kdist, axis=1)          # best neighbour per dimensionality
            rows = np.arange(d)
            p_block[:, col] = kdist[rows, jstar]
            i_block[:, col] = jstar.astype(np.int64)
        return bid, i_lo, p_block, i_block

    partials = list(mapper(_task, _row_blocks(plen, n_blocks)))
    partials.sort(key=lambda p: p[0])

    mp = np.full((d, plen), np.inf)
    mpi = np.full((d, plen), -1, dtype=np.int64)
    for _, i_lo, p_block, i_block in partials:
        w = p_block.shape[1]
        mp[:, i_lo : i_lo + w] = p_block
        mpi[:, i_lo : i_lo + w] = i_block
    return MStampProfile(mp=mp, mpi=mpi, m=m, minlag=excl)


def participating_dims(
    series: np.ndarray, m: int, idx_a: int, idx_b: int, n_dims: int
) -> tuple[list[int], list[float]]:
    """The ``n_dims`` channels whose windows at ``idx_a`` / ``idx_b`` agree most closely.

    Returns ``(dims, dists)`` where ``dims`` are the channel indices ordered by ascending
    per-dimension z-normalized distance (best-agreeing first) and ``dists`` the matching
    distances. Uses the same MASS distance as :func:`mstamp`, so the selected subset matches
    the one that produced the profile's k-dimensional value for the pair.
    """
    a = _as_2d(series)
    d = a.shape[0]
    n_dims = max(1, min(int(n_dims), d))
    per_dim = np.empty(d, dtype=np.float64)
    for dim in range(d):
        per_dim[dim] = mass(a[dim, idx_a : idx_a + m], a[dim])[idx_b]
    order = np.argsort(per_dim, kind="stable")[:n_dims]
    return [int(x) for x in order], [float(per_dim[x]) for x in order]


def mstamp_motifs(
    profile: MStampProfile,
    series: np.ndarray,
    k: int = 1,
    n_dims: Optional[int] = None,
    exclusion: Optional[int] = None,
) -> list[MDimMotif]:
    """Top-``k`` non-overlapping multi-sensor motifs at dimensionality ``n_dims``.

    ``n_dims`` fixes how many channels must jointly repeat (default: all ``d`` channels).
    Candidates are read from the ``n_dims``-dimensional profile row; they are ranked by
    distance ascending and greedily spaced by ``exclusion`` (default ``exclusion_zone(m)``)
    so reported motifs don't overlap. Each result carries the participating channels.
    """
    a = _as_2d(series)
    d = a.shape[0]
    nd = d if n_dims is None else max(1, min(int(n_dims), d))
    excl = exclusion_zone(profile.m) if exclusion is None else int(exclusion)

    mp = np.asarray(profile.mp[nd - 1], dtype=np.float64)
    mpi = np.asarray(profile.mpi[nd - 1], dtype=np.int64)
    order = np.argsort(mp, kind="stable")

    chosen: list[MDimMotif] = []
    used: list[int] = []
    for i in order:
        dist = mp[i]
        j = int(mpi[i])
        if not np.isfinite(dist) or j < 0:
            continue
        lo, hi = sorted((int(i), j))
        if any(abs(lo - u) < excl or abs(hi - u) < excl for u in used):
            continue
        dims, dim_dists = participating_dims(a, profile.m, lo, hi, nd)
        chosen.append(
            MDimMotif(idx_a=lo, idx_b=hi, dist=float(dist), n_dims=nd, dims=dims, dim_dists=dim_dists)
        )
        used.extend((lo, hi))
        if len(chosen) >= k:
            break
    return chosen


def mstamp_discords(
    profile: MStampProfile,
    series: np.ndarray,
    k: int = 1,
    n_dims: Optional[int] = None,
    exclusion: Optional[int] = None,
) -> list[MDimDiscord]:
    """Top-``k`` multi-sensor novelties at dimensionality ``n_dims`` (most novel first).

    Ranks windows by their ``n_dims``-dimensional nearest-neighbour distance (large = novel
    across those channels) and returns the largest, spaced by ``exclusion`` so they don't
    overlap. Each result carries the channels that make it stand out.
    """
    a = _as_2d(series)
    d = a.shape[0]
    nd = d if n_dims is None else max(1, min(int(n_dims), d))
    excl = exclusion_zone(profile.m) if exclusion is None else int(exclusion)

    mp = np.asarray(profile.mp[nd - 1], dtype=np.float64).copy()
    mpi = np.asarray(profile.mpi[nd - 1], dtype=np.int64)

    results: list[MDimDiscord] = []
    finite = np.isfinite(mp)
    for _ in range(max(1, k)):
        if not finite.any():
            break
        i = int(np.argmax(np.where(finite, mp, -np.inf)))
        if not np.isfinite(mp[i]):
            break
        j = int(mpi[i])
        dims, dim_dists = participating_dims(a, profile.m, i, j, nd) if j >= 0 else ([], [])
        results.append(
            MDimDiscord(
                index=i,
                nn_distance=float(mp[i]),
                nn_index=j,
                n_dims=nd,
                dims=dims,
                dim_dists=dim_dists,
            )
        )
        lo = max(0, i - excl)
        hi = min(mp.shape[0], i + excl + 1)
        mp[lo:hi] = -np.inf
        finite[lo:hi] = False
    return results
