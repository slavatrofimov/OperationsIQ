"""Time-Series Chains (TSC) — following a pattern that slowly drifts over time.

A *chain* is an ordered set of subsequences that are each other's directional nearest
neighbors and that evolve gradually: link ``a -> b -> c -> ...`` where consecutive links
are only slightly different, so the head and tail of the chain can look quite unlike each
other. Chains are the ideal primitive for **slow degradation** — bearing wear, fouling,
sensor drift — because they surface a pattern whose shape creeps in one direction across
the window (Zhu et al., "Matrix Profile VII: Time Series Chains").

Input is the directional matrix profile: ``il[i]`` (nearest neighbor to the *left* of
``i``) and ``ir[i]`` (nearest neighbor to the *right*), from
:func:`tsmp.momp.mpx.mpx_lr` / :func:`tsmp.parallel.decompose.parallel_lr_matrix_profile`.
A forward link ``i -> ir[i]`` is part of a chain only when it is *mutual*:
``il[ir[i]] == i``. The unanchored chain is the longest such path, found by an O(n) DP
because ``ir[i] > i`` always (links only ever go left-to-right in time).

Framework-free NumPy so it is unit-tested without Spark.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

__all__ = [
    "unanchored_chain",
    "top_k_chains",
    "chain_drift",
    "Chain",
]


@dataclass
class Chain:
    """One time-series chain."""

    indices: list[int] = field(default_factory=list)  # ordered subsequence start indices

    @property
    def length(self) -> int:
        return len(self.indices)


def _chain_lengths(il: np.ndarray, ir: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """DP over mutual links: ``length[i]`` = chain length ending at ``i``; ``prev[i]`` = its
    predecessor (or -1). Processing ascending is valid because ``ir[i] > i``."""
    il = np.asarray(il, dtype=np.int64)
    ir = np.asarray(ir, dtype=np.int64)
    n = ir.shape[0]
    length = np.ones(n, dtype=np.int64)
    prev = np.full(n, -1, dtype=np.int64)
    for i in range(n):
        j = int(ir[i])
        if 0 <= j < n and int(il[j]) == i and length[i] + 1 > length[j]:
            length[j] = length[i] + 1
            prev[j] = i
    return length, prev


def _reconstruct(end: int, prev: np.ndarray) -> list[int]:
    chain: list[int] = []
    cur = int(end)
    while cur != -1:
        chain.append(cur)
        cur = int(prev[cur])
    chain.reverse()
    return chain


def unanchored_chain(il: np.ndarray, ir: np.ndarray) -> list[int]:
    """The single longest time-series chain, as ordered subsequence start indices."""
    ir = np.asarray(ir, dtype=np.int64)
    if ir.shape[0] == 0:
        return []
    length, prev = _chain_lengths(il, ir)
    end = int(np.argmax(length))
    if length[end] <= 1:
        # No mutual links: return the trivial single-element chain at the best anchor so
        # callers always get a well-formed (possibly length-1) result.
        return [end]
    return _reconstruct(end, prev)


def top_k_chains(il: np.ndarray, ir: np.ndarray, k: int = 1) -> list[Chain]:
    """Up to ``k`` longest, **index-disjoint** chains, longest first.

    After extracting the longest chain, its members are removed from contention so the
    next chain covers a different stretch of the window (rank-2+ chains are only reported
    when they are genuine, non-overlapping evolving patterns).
    """
    ir = np.asarray(ir, dtype=np.int64)
    n = ir.shape[0]
    k = max(1, int(k))
    if n == 0:
        return []

    length, prev = _chain_lengths(il, ir)
    order = np.argsort(-length, kind="stable")  # longest ends first
    used = np.zeros(n, dtype=bool)
    chains: list[Chain] = []
    for end in order:
        if len(chains) >= k:
            break
        end = int(end)
        if used[end]:
            continue
        chain = _reconstruct(end, prev)
        if any(used[i] for i in chain):
            continue
        if len(chain) <= 1 and chains:
            # Only surface trivial length-1 chains when nothing longer exists at all.
            break
        for i in chain:
            used[i] = True
        chains.append(Chain(indices=chain))
    return chains


def chain_drift(series: np.ndarray, chain: list[int], m: int) -> dict:
    """Quantify how the chain evolves head→tail (the "degradation" signal).

    Returns per-link summary statistics and a simple monotone drift estimate over the
    chain's subsequence means and amplitudes (peak-to-peak). Positive ``meanSlope`` means
    the level is rising along the chain; ``amplitudeSlope`` tracks a growing/shrinking
    swing — both common wear/fouling signatures.
    """
    series = np.asarray(series, dtype=np.float64)
    idxs = [int(i) for i in chain if 0 <= int(i) and int(i) + m <= series.shape[0]]
    means: list[float] = []
    amplitudes: list[float] = []
    for i in idxs:
        seg = series[i : i + m]
        means.append(float(np.mean(seg)))
        amplitudes.append(float(np.ptp(seg)))

    def _slope(ys: list[float]) -> float:
        if len(ys) < 2:
            return 0.0
        xs = np.arange(len(ys), dtype=np.float64)
        # Least-squares slope per link.
        return float(np.polyfit(xs, np.asarray(ys, dtype=np.float64), 1)[0])

    return {
        "links": len(idxs),
        "meanStart": means[0] if means else None,
        "meanEnd": means[-1] if means else None,
        "meanSlope": _slope(means),
        "amplitudeStart": amplitudes[0] if amplitudes else None,
        "amplitudeEnd": amplitudes[-1] if amplitudes else None,
        "amplitudeSlope": _slope(amplitudes),
    }
