"""Ostinato — the top-1 consensus motif across a fleet of series (design spec: P3).

Given ``N`` *independent* series (e.g. the same sensor on ``N`` assets of a fleet, with no
requirement that they be time-aligned or even the same length) and a subsequence length
``m``, Ostinato finds the single shape that best recurs across the fleet: the subsequence
whose *radius* — its nearest-neighbour distance in the other series — is smallest.

For a candidate window ``q`` taken from series ``s`` we measure, for every series ``s'``,
the z-normalized distance from ``q`` to its nearest window in ``s'`` (a MASS distance
profile followed by a min). Sorting those ``N`` distances ascending, the ``min_count``-th
smallest is the radius: the tightest ball that still captures ``min_count`` of the series
(``q``'s own series contributes distance 0). Strict all-fleet consensus is ``min_count = N``
(the radius is then the *max* over the other series); a smaller ``min_count`` yields a
"``>= m`` of ``N``" partial consensus. The consensus motif is the candidate that minimises
the radius; its members are, per series, the nearest window to that central shape.

The heavy O((sum of profile lengths)^2 * N) work fans out across the injected ``mapper`` by
blocking over candidate windows (mirroring :mod:`tsmp.abjoin.abjoin` and
:mod:`tsmp.mstamp.mstamp`). An early-abandon prunes a candidate as soon as more than
``N - min_count`` of its series exceed the best radius found so far, so it can never reach
``min_count`` neighbours within that radius. The block split only affects task granularity,
never the result.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Optional, Sequence

import numpy as np

from tsmp.common.mass import mass

__all__ = [
    "ConsensusMotif",
    "ConsensusMember",
    "ostinato",
]

Mapper = Callable[[Callable, Iterable], Iterable]


@dataclass
class ConsensusMember:
    """One series' participation in the consensus: where the shared shape occurs in it."""

    series_id: int
    index: int       # start of the nearest window to the central shape in this series
    distance: float  # z-normalized distance from the central shape (0 for the central series)
    is_central: bool


@dataclass
class ConsensusMotif:
    """The fleet-wide consensus motif (top-1).

    ``central_series`` / ``central_index`` locate the reference shape; ``radius`` is its
    ``min_count``-th smallest nearest-neighbour distance across the fleet. ``members`` holds
    one entry per series (the nearest window to the central shape), with ``is_central`` set
    on the reference series.
    """

    central_series: int
    central_index: int
    radius: float
    m: int
    min_count: int
    members: list[ConsensusMember]


def _profile_len(n: int, m: int) -> int:
    return max(0, n - m + 1)


def _prep_series(series_list: Sequence[np.ndarray], m: int) -> list[np.ndarray]:
    if len(series_list) < 2:
        raise ValueError("consensus needs at least 2 series")
    out: list[np.ndarray] = []
    for k, s in enumerate(series_list):
        arr = np.asarray(s, dtype=np.float64)
        if arr.ndim != 1:
            raise ValueError(f"series {k} must be 1-D")
        if m > arr.shape[0]:
            raise ValueError(f"m must be <= the length of series {k}")
        out.append(arr)
    return out


def _candidate_blocks(
    plens: Sequence[int], n_blocks: int
) -> list[tuple[int, list[tuple[int, int]]]]:
    """Split the flattened ``(series, window)`` candidate space into ``n_blocks`` tasks.

    Returns ``(block_id, [(series_index, window_index), ...])`` tuples; ``block_id`` fixes
    the deterministic reduce order so ties resolve identically regardless of block count.
    """
    candidates: list[tuple[int, int]] = []
    for s, plen in enumerate(plens):
        for i in range(plen):
            candidates.append((s, i))
    if not candidates:
        return []
    n_blocks = max(1, min(n_blocks, len(candidates)))
    bounds = np.linspace(0, len(candidates), num=n_blocks + 1).astype(int)
    blocks: list[tuple[int, list[tuple[int, int]]]] = []
    for b in range(n_blocks):
        lo, hi = int(bounds[b]), int(bounds[b + 1])
        if hi > lo:
            blocks.append((len(blocks), candidates[lo:hi]))
    return blocks


def ostinato(
    series_list: Sequence[np.ndarray],
    m: int,
    min_count: Optional[int] = None,
    n_blocks: int = 1,
    mapper: Mapper = map,
) -> Optional[ConsensusMotif]:
    """Top-1 consensus motif across ``series_list`` at subsequence length ``m``.

    ``min_count`` is how many series must contain the shape (default: all ``N`` — strict
    consensus). Exact and identical for any ``n_blocks``. Returns ``None`` only when no
    candidate window exists.
    """
    series = _prep_series(series_list, m)
    m = int(m)
    if m < 1:
        raise ValueError("m must be >= 1")
    n = len(series)
    mc = n if min_count is None else max(2, min(int(min_count), n))

    plens = [_profile_len(s.shape[0], m) for s in series]
    blocks = _candidate_blocks(plens, n_blocks)
    if not blocks:
        return None

    def _task(block: tuple[int, list[tuple[int, int]]]):
        bid, cands = block
        bsf = np.inf
        best: Optional[tuple[int, int, float, list[tuple[int, float]]]] = None
        max_exceed = n - mc  # how many series may exceed the radius before it's hopeless
        for (s, i) in cands:
            q = series[s][i : i + m]
            dists = np.empty(n, dtype=np.float64)
            idxs = np.empty(n, dtype=np.int64)
            dists[s] = 0.0
            idxs[s] = i
            exceed = 0
            abandoned = False
            for sp in range(n):
                if sp == s:
                    continue
                dp = mass(q, series[sp])
                j = int(np.argmin(dp))
                dists[sp] = dp[j]
                idxs[sp] = j
                # Early abandon: too many series already farther than the best radius.
                if dists[sp] > bsf:
                    exceed += 1
                    if exceed > max_exceed:
                        abandoned = True
                        break
            if abandoned:
                continue
            radius = float(np.sort(dists)[mc - 1])
            # Strict ``<`` keeps the earlier (lower series, lower index) candidate on ties.
            if radius < bsf:
                bsf = radius
                best = (s, i, radius, list(zip(idxs.tolist(), dists.tolist())))
        return bid, best

    partials = list(mapper(_task, blocks))
    partials.sort(key=lambda p: p[0])

    winner: Optional[tuple[int, int, float, list[tuple[int, float]]]] = None
    winner_radius = np.inf
    for _, cand in partials:
        if cand is None:
            continue
        if cand[2] < winner_radius:
            winner = cand
            winner_radius = cand[2]

    if winner is None:
        return None

    central_series, central_index, radius, per_series = winner
    members = [
        ConsensusMember(
            series_id=sp,
            index=int(per_series[sp][0]),
            distance=float(per_series[sp][1]),
            is_central=(sp == central_series),
        )
        for sp in range(n)
    ]
    return ConsensusMotif(
        central_series=central_series,
        central_index=central_index,
        radius=radius,
        m=m,
        min_count=mc,
        members=members,
    )
