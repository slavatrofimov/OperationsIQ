"""Discord (anomaly) discovery.

Two entry points:

* :func:`discords` — **exact** top-k discords via the full self-join matrix profile.
  A discord is the subsequence whose nearest neighbor is farthest away (the local
  maximum of the matrix profile). This is the canonical definition and validates
  directly against STUMPY.

* :func:`damp` — a DAMP-style finder that returns the **same exact** top discord(s)
  but uses expanding-window search with *early abandoning*: as soon as a candidate is
  shown to have a neighbor closer than the best-so-far discord distance, its evaluation
  is abandoned. This is the single-node seed of the segment-parallel DAMP described in
  the design spec (P2 distributes the candidate scan across Spark executors).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone
from tsmp.momp.mpx import mpx

__all__ = ["discords", "damp", "DiscordResult"]


@dataclass
class DiscordResult:
    """A single discord (anomaly)."""

    index: int          # start index of the discord subsequence
    nn_distance: float  # distance to its nearest neighbor (higher == more anomalous)
    nn_index: int       # index of that nearest neighbor (-1 if unknown)


def discords(t: np.ndarray, m: int, k: int = 1, minlag: int | None = None) -> list[DiscordResult]:
    """Exact top-``k`` discords via the full matrix profile.

    Successive discords are separated by an exclusion zone so they do not overlap.
    """
    t = np.asarray(t, dtype=np.float64)
    if minlag is None:
        minlag = exclusion_zone(m)
    profile = mpx(t, m, minlag)
    mp = profile.mp.copy()
    mpi = profile.mpi
    excl = minlag

    results: list[DiscordResult] = []
    finite = np.isfinite(mp)
    for _ in range(k):
        if not finite.any():
            break
        i = int(np.argmax(np.where(finite, mp, -np.inf)))
        if not np.isfinite(mp[i]):
            break
        results.append(DiscordResult(index=i, nn_distance=float(mp[i]), nn_index=int(mpi[i])))
        lo = max(0, i - excl)
        hi = min(len(mp), i + excl + 1)
        mp[lo:hi] = -np.inf
        finite[lo:hi] = False
    return results


def _nn_with_abandon(
    t: np.ndarray, m: int, i: int, excl: int, bsf: float
) -> tuple[float, int]:
    """Nearest-neighbor distance of window ``i`` with early abandoning.

    Searches outward from ``i`` in geometrically growing chunks. Returns as soon as a
    neighbor closer than ``bsf`` is found (the returned distance is then <= ``bsf`` and
    signals "not a discord"); otherwise returns the exact NN distance and index.
    """
    q = t[i : i + m]
    profile_len = t.shape[0] - m + 1
    nnd = np.inf
    nn_idx = -1

    left = i - excl - 1
    right = i + excl + 1
    radius = max(m, 1)

    while True:
        progressed = False
        if left >= 0:
            a = max(0, left - radius + 1)
            dp = mass(q, t[a : left + m])
            j = int(np.argmin(dp))
            if dp[j] < nnd:
                nnd = float(dp[j])
                nn_idx = a + j
            left = a - 1
            progressed = True
        if right <= profile_len - 1:
            b = min(profile_len - 1, right + radius - 1)
            dp = mass(q, t[right : b + m])
            j = int(np.argmin(dp))
            if dp[j] < nnd:
                nnd = float(dp[j])
                nn_idx = right + j
            right = b + 1
            progressed = True

        if nnd <= bsf:
            return nnd, nn_idx  # abandoned — cannot be the discord
        if not progressed:
            break
        radius *= 2

    return nnd, nn_idx


def damp(t: np.ndarray, m: int, k: int = 1, minlag: int | None = None) -> list[DiscordResult]:
    """DAMP-style exact top-``k`` discord discovery with early abandoning.

    Produces identical results to :func:`discords` but avoids fully evaluating the
    nearest neighbor of candidates that are clearly not anomalous.
    """
    t = np.asarray(t, dtype=np.float64)
    n = t.shape[0]
    if minlag is None:
        minlag = exclusion_zone(m)
    excl = minlag
    profile_len = n - m + 1

    excluded = np.zeros(profile_len, dtype=bool)
    results: list[DiscordResult] = []

    for _ in range(k):
        bsf = -np.inf
        loc = -1
        nn_at_loc = -1
        for i in range(profile_len):
            if excluded[i]:
                continue
            nnd, j = _nn_with_abandon(t, m, i, excl, bsf)
            if nnd > bsf:
                bsf = nnd
                loc = i
                nn_at_loc = j
        if loc < 0 or not np.isfinite(bsf):
            break
        results.append(DiscordResult(index=loc, nn_distance=float(bsf), nn_index=int(nn_at_loc)))
        lo = max(0, loc - excl)
        hi = min(profile_len, loc + excl + 1)
        excluded[lo:hi] = True

    return results
