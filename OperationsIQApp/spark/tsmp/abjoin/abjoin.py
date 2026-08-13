"""AB-join matrix profile and its motif / discord extractors.

Given two series ``a`` and ``b`` and a subsequence length ``m``, the AB-join computes,
for every length-``m`` window of each series, its nearest neighbour in the *other* series:

* ``pab[i]`` / ``ipab[i]`` — distance & B-index of A-window ``i``'s nearest match in B.
* ``pba[j]`` / ``ipba[j]`` — distance & A-index of B-window ``j``'s nearest match in A.

Both directions are produced in a single pass: iterating over A-windows yields each row of
the (implicit) z-normalized distance matrix via one :func:`~tsmp.common.mass.mass` call;
row minima give ``pab`` and a running element-wise column minimum gives ``pba`` — so the
O(nA·nB) matrix is never materialised. The heavy per-A-window work fans out across the
injected ``mapper`` (``map`` by default, a Spark mapper on a cluster), mirroring the
decomposition style of :mod:`tsmp.parallel.decompose`.

No exclusion zone is applied to the join itself: ``a`` and ``b`` are distinct series, so
there is no trivial self-match to suppress. An exclusion zone *is* used when spacing out
top-``k`` motifs/discords so reported results don't overlap within a series.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Optional

import numpy as np

from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone

__all__ = [
    "ABMatrixProfile",
    "ABMotif",
    "ABDiscord",
    "ab_matrix_profile",
    "ab_motifs",
    "ab_discords",
]

Mapper = Callable[[Callable, Iterable], Iterable]


@dataclass
class ABMatrixProfile:
    """Bidirectional nearest-neighbour profile between two series ``a`` and ``b``."""

    pab: np.ndarray   # A→B: nearest-neighbour distance for each window of a
    ipab: np.ndarray  # A→B: index in b of that nearest neighbour (-1 if none)
    pba: np.ndarray   # B→A: nearest-neighbour distance for each window of b
    ipba: np.ndarray  # B→A: index in a of that nearest neighbour (-1 if none)
    m: int            # subsequence length


@dataclass
class ABMotif:
    """A most-similar pair spanning the two series (rank 1 = smallest distance)."""

    idx_a: int   # start index in series a
    idx_b: int   # start index in series b
    dist: float  # z-normalized Euclidean distance between the two windows


@dataclass
class ABDiscord:
    """A novelty: a ``target``-series window unlike anything in the reference series.

    ``idx`` is the window's start in the target series; ``nn_distance`` is how far it is
    from its nearest neighbour in the reference series (larger = more novel); ``nn_index``
    is that neighbour's start index in the reference series.
    """

    index: int
    nn_distance: float
    nn_index: int


def _profile_len(n: int, m: int) -> int:
    return max(0, n - m + 1)


def _empty_profile(m: int, plen_a: int, plen_b: int) -> ABMatrixProfile:
    return ABMatrixProfile(
        pab=np.full(plen_a, np.inf),
        ipab=np.full(plen_a, -1, dtype=np.int64),
        pba=np.full(plen_b, np.inf),
        ipba=np.full(plen_b, -1, dtype=np.int64),
        m=m,
    )


def _row_blocks(plen_a: int, n_blocks: int) -> list[tuple[int, int, int]]:
    """Split the A-window range ``[0, plen_a)`` into ``n_blocks`` contiguous tasks.

    Returns ``(block_id, i_lo, i_hi)`` tuples in ascending order; ``block_id`` fixes the
    deterministic reduce order so ties resolve to the lower A-index, matching a serial scan.
    """
    n_blocks = max(1, min(n_blocks, plen_a))
    bounds = np.linspace(0, plen_a, num=n_blocks + 1).astype(int)
    blocks: list[tuple[int, int, int]] = []
    for b in range(n_blocks):
        lo, hi = int(bounds[b]), int(bounds[b + 1])
        if hi > lo:
            blocks.append((len(blocks), lo, hi))
    return blocks


def ab_matrix_profile(
    a: np.ndarray,
    b: np.ndarray,
    m: int,
    n_blocks: int = 1,
    mapper: Mapper = map,
) -> ABMatrixProfile:
    """Compute the bidirectional AB-join matrix profile between ``a`` and ``b``.

    ``pab``/``ipab`` are exact for every window of ``a``; ``pba``/``ipba`` for every window
    of ``b``. Identical for any ``n_blocks`` (the block split only affects task granularity,
    not the result). Requires ``m`` to fit inside both series.
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    m = int(m)
    if m < 1:
        raise ValueError("m must be >= 1")
    if m > a.shape[0] or m > b.shape[0]:
        raise ValueError("m must be <= the length of both series")

    plen_a = _profile_len(a.shape[0], m)
    plen_b = _profile_len(b.shape[0], m)
    if plen_a == 0 or plen_b == 0:
        return _empty_profile(m, plen_a, plen_b)

    blocks = _row_blocks(plen_a, n_blocks)

    def _task(block: tuple[int, int, int]):
        bid, i_lo, i_hi = block
        row_min = np.full(i_hi - i_lo, np.inf)
        row_arg = np.full(i_hi - i_lo, -1, dtype=np.int64)
        col_min = np.full(plen_b, np.inf)
        col_arg = np.full(plen_b, -1, dtype=np.int64)
        for r, i in enumerate(range(i_lo, i_hi)):
            dp = mass(a[i : i + m], b)
            j = int(np.argmin(dp))
            row_min[r] = dp[j]
            row_arg[r] = j
            # Running element-wise column minimum → each B-window's nearest A-window.
            # Strict ``<`` keeps the lower A-index on ties (deterministic vs a serial scan).
            take = dp < col_min
            col_min = np.where(take, dp, col_min)
            col_arg = np.where(take, i, col_arg)
        return bid, i_lo, row_min, row_arg, col_min, col_arg

    partials = list(mapper(_task, blocks))
    partials.sort(key=lambda p: p[0])

    pab = np.full(plen_a, np.inf)
    ipab = np.full(plen_a, -1, dtype=np.int64)
    pba = np.full(plen_b, np.inf)
    ipba = np.full(plen_b, -1, dtype=np.int64)

    for _, i_lo, row_min, row_arg, col_min, col_arg in partials:
        pab[i_lo : i_lo + row_min.shape[0]] = row_min
        ipab[i_lo : i_lo + row_arg.shape[0]] = row_arg
        take = col_min < pba
        pba = np.where(take, col_min, pba)
        ipba = np.where(take, col_arg, ipba)

    return ABMatrixProfile(pab=pab, ipab=ipab, pba=pba, ipba=ipba, m=m)


def ab_motifs(
    profile: ABMatrixProfile,
    k: int = 1,
    exclusion: Optional[int] = None,
) -> list[ABMotif]:
    """Top-``k`` most-similar cross-series pairs, ordered smallest-distance first.

    Candidates are each A-window paired with its nearest B-window ``(i, ipab[i])``. They are
    sorted by distance ascending and greedily accepted only when both endpoints are at least
    ``exclusion`` away — *within their own series* — from every endpoint already accepted, so
    reported motifs don't overlap. ``exclusion`` defaults to ``exclusion_zone(m)``.
    """
    excl = exclusion_zone(profile.m) if exclusion is None else int(exclusion)
    pab = np.asarray(profile.pab, dtype=np.float64)
    ipab = np.asarray(profile.ipab, dtype=np.int64)
    order = np.argsort(pab, kind="stable")

    chosen: list[ABMotif] = []
    used_a: list[int] = []
    used_b: list[int] = []
    for i in order:
        d = pab[i]
        j = int(ipab[i])
        if not np.isfinite(d) or j < 0:
            continue
        ia = int(i)
        if any(abs(ia - u) < excl for u in used_a):
            continue
        if any(abs(j - u) < excl for u in used_b):
            continue
        chosen.append(ABMotif(idx_a=ia, idx_b=j, dist=float(d)))
        used_a.append(ia)
        used_b.append(j)
        if len(chosen) >= k:
            break
    return chosen


def ab_discords(
    profile: ABMatrixProfile,
    k: int = 1,
    exclusion: Optional[int] = None,
    target: str = "b",
) -> list[ABDiscord]:
    """Top-``k`` novelties: ``target``-series windows least like the reference series.

    With ``target="b"`` (the default) this ranks each window of ``b`` by its distance to the
    nearest window of ``a`` (``pba``) and returns the largest — the shapes present in ``b``
    that have no close analogue in the baseline ``a``. ``target="a"`` reverses the roles.
    Results are spaced by ``exclusion`` (default ``exclusion_zone(m)``) so they don't overlap.
    """
    excl = exclusion_zone(profile.m) if exclusion is None else int(exclusion)
    if target == "b":
        prof = np.asarray(profile.pba, dtype=np.float64)
        nn = np.asarray(profile.ipba, dtype=np.int64)
    elif target == "a":
        prof = np.asarray(profile.pab, dtype=np.float64)
        nn = np.asarray(profile.ipab, dtype=np.int64)
    else:
        raise ValueError("target must be 'a' or 'b'")

    scratch = prof.copy()
    results: list[ABDiscord] = []
    finite = np.isfinite(scratch)
    for _ in range(max(1, k)):
        if not finite.any():
            break
        i = int(np.argmax(np.where(finite, scratch, -np.inf)))
        if not np.isfinite(scratch[i]):
            break
        results.append(
            ABDiscord(index=i, nn_distance=float(scratch[i]), nn_index=int(nn[i]))
        )
        lo = max(0, i - excl)
        hi = min(scratch.shape[0], i + excl + 1)
        scratch[lo:hi] = -np.inf
        finite[lo:hi] = False
    return results
