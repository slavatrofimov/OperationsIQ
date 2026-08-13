"""FLUSS / FLOSS semantic segmentation from a matrix-profile index.

Regime (operating-mode) changes are found from the *nearest-neighbor index* of the
self-join matrix profile — no extra distance computation is needed once the profile
exists. The idea (Gharghabi et al., "Domain Agnostic Online Semantic Segmentation",
FLUSS/FLOSS):

* Each subsequence ``i`` points to its nearest neighbor ``mpi[i]``. Draw an "arc" from
  ``i`` to ``mpi[i]``. Within a single operating regime, subsequences match other
  subsequences in the *same* regime, so many arcs span any interior point. Across a
  regime boundary, few arcs cross — because the behavior on either side is dissimilar.
* :func:`arc_counts` counts, for every location, how many arcs cross it. Boundaries show
  up as sharp valleys.
* Raw counts are biased (more arcs can cross the middle purely by geometry), so
  :func:`corrected_arc_curve` normalizes by the idealized count of a uniform-random arc
  distribution (an inverted parabola), giving the **Corrected Arc Curve (CAC)** in
  ``[0, 1]``. Low CAC == likely regime boundary.
* :func:`find_regimes` returns the ``k`` lowest CAC minima, kept apart by an exclusion
  zone so boundaries don't cluster on the same transition.

Framework-free NumPy so it is unit-tested without Spark; the caller supplies ``mpi``
from :func:`tsmp.parallel.decompose.parallel_matrix_profile`.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

__all__ = [
    "arc_counts",
    "corrected_arc_curve",
    "find_regimes",
    "RegimeBoundary",
]


@dataclass
class RegimeBoundary:
    """A detected operating-regime change point."""

    index: int   # subsequence index where behavior changes
    cac: float   # corrected-arc-curve value at the boundary (lower == stronger)


def arc_counts(mpi: np.ndarray) -> np.ndarray:
    """Number of nearest-neighbor arcs crossing each location.

    An arc joins ``i`` and ``mpi[i]``; it crosses every position strictly between them.
    Computed in O(n) with a difference array + cumulative sum: ``+1`` where an arc opens
    and ``-1`` where it closes.
    """
    mpi = np.asarray(mpi, dtype=np.int64)
    n = mpi.shape[0]
    diff = np.zeros(n + 1, dtype=np.float64)
    for i in range(n):
        j = int(mpi[i])
        if j < 0 or j >= n:
            continue
        lo, hi = (i, j) if i < j else (j, i)
        # The arc crosses locations lo+1 .. hi (exclusive of lo, inclusive up to hi).
        diff[lo + 1] += 1.0
        diff[hi + 1] -= 1.0
    return np.cumsum(diff[:-1])


def corrected_arc_curve(mpi: np.ndarray, exclusion: int = 0) -> np.ndarray:
    """Corrected Arc Curve (CAC) in ``[0, 1]``; low values mark regime boundaries.

    The raw arc count is normalized by the idealized arc count of a uniform-random arc
    distribution — the inverted parabola ``2 * i * (n - i) / n`` which peaks at the
    center. ``exclusion`` (typically the subsequence length) suppresses the first/last
    few positions to 1.0 so trivial edge minima aren't reported as boundaries.
    """
    mpi = np.asarray(mpi, dtype=np.int64)
    n = mpi.shape[0]
    if n == 0:
        return np.zeros(0)

    ac = arc_counts(mpi)
    idx = np.arange(n, dtype=np.float64)
    iac = 2.0 * idx * (n - idx) / n  # idealized (expected) arc count
    with np.errstate(divide="ignore", invalid="ignore"):
        cac = np.where(iac > 0, ac / iac, 1.0)
    cac = np.clip(cac, 0.0, 1.0)

    e = max(0, int(exclusion))
    if e > 0:
        cac[:e] = 1.0
        cac[n - e :] = 1.0
    return cac


def find_regimes(
    mpi: np.ndarray,
    num_regimes: int,
    exclusion: int = 0,
    cac: np.ndarray | None = None,
) -> list[RegimeBoundary]:
    """Return up to ``num_regimes`` regime **boundaries** (change points).

    ``num_regimes`` counts boundaries directly (a value of 2 splits the timeline into
    three segments). Boundaries are the lowest CAC minima, selected greedily and kept at
    least ``exclusion`` apart so a single transition is not reported multiple times. A
    location whose CAC is already ``>= 1`` (no dip) is never reported.
    """
    if cac is None:
        cac = corrected_arc_curve(mpi, exclusion)
    cac = np.asarray(cac, dtype=np.float64)
    n = cac.shape[0]
    k = max(0, int(num_regimes))
    if n == 0 or k == 0:
        return []

    excl = max(1, int(exclusion))
    work = cac.copy()
    boundaries: list[RegimeBoundary] = []
    for _ in range(k):
        i = int(np.argmin(work))
        if not np.isfinite(work[i]) or work[i] >= 1.0:
            break
        boundaries.append(RegimeBoundary(index=i, cac=float(cac[i])))
        lo = max(0, i - excl)
        hi = min(n, i + excl + 1)
        work[lo:hi] = np.inf
    return boundaries
