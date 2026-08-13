"""MOMP — Motif-Only Matrix Profile (motif discovery).

A single-node reference implementation adapted from the algorithm of
Shahcheraghi et al., *Matrix Profile XXXI: Motif-Only Matrix Profile* (ICKG 2024) and
the accompanying repository (maryam-shchgh/momp).

Core idea (``lbMP`` lower bound + refine + prune):

1. Downsample ``T`` by a rate ``dd`` (PAA) *after z-normalizing each window by its own
   full-window mean and std*, and scale the resulting distances by ``sqrt(dd)`` to
   obtain a provable *lower bound* on the true matrix profile. (Normalizing with the
   full-window statistics — not the shrunken std of the downsampled series — is what
   keeps the classic PAA bound valid for z-normalized distances.)
2. Evaluate the most promising candidate exactly to tighten the best-so-far (``bsf``)
   motif distance (an upper bound).
3. Prune every position whose lower bound already exceeds ``bsf`` — it cannot be a
   motif member.
4. Halve ``dd`` and repeat. At ``dd == 1`` every surviving candidate is evaluated
   exactly, so the surviving minimum is the **exact** top-1 motif.

Because the exact refinement uses MASS against the full series, the reported motif is
exact regardless of the pruning schedule — pruning only affects speed. The design is
"anytime": ``momp_anytime`` streams the improving ``bsf`` after each level, which the
UI surfaces as a best-so-far result with a convergence meter.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator

import numpy as np

from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone, moving_mean_std

__all__ = ["momp", "momp_anytime", "MompResult", "MompLevel"]


@dataclass
class MompResult:
    """Result of a completed MOMP run."""

    distance: float                 # exact z-normalized Euclidean distance of the motif pair
    pair: tuple[int, int]           # (start index a, start index b) in the original series
    m: int                          # subsequence length
    levels: int                     # number of refinement levels executed


@dataclass
class MompLevel:
    """Anytime snapshot emitted after each downsampling level."""

    dsr: int                        # current downsampling rate (dd)
    bsf: float                      # best-so-far motif distance (upper bound)
    pair: tuple[int, int] | None    # best-so-far motif pair
    alive: int                      # number of candidate positions still active
    pruned_fraction: float          # fraction of positions pruned so far
    exact: bool                     # True once dd == 1 (result is exact)


def _exact_nn(t: np.ndarray, m: int, i: int, excl: int) -> tuple[float, int]:
    """Exact nearest-neighbor distance/index of window ``i`` against the full series."""
    dp = mass(t[i : i + m], t)
    lo = max(0, i - excl)
    hi = min(len(dp), i + excl + 1)
    dp[lo:hi] = np.inf
    j = int(np.argmin(dp))
    return float(dp[j]), j


def _schedule(m: int) -> list[int]:
    """Downsampling schedule ``[dd, dd/2, ..., 2, 1]`` with ``dd = m // 4``."""
    start = max(1, m // 4)
    sched: list[int] = []
    d = start
    while d > 1:
        sched.append(d)
        d //= 2
    sched.append(1)
    return sched


def _znorm_paa_vectors(t: np.ndarray, m: int, dd: int) -> np.ndarray:
    """Per-window z-normalized PAA vectors, shape ``(profile_len, w)`` with ``w = m // dd``.

    Each length-``m`` window is z-normalized by *its own full-window* mean and std,
    then reduced to ``w`` segment averages (PAA over the first ``w * dd`` samples).
    Normalizing with full-window statistics — rather than the downsampled series'
    shrunken std — is what makes ``sqrt(dd) * ||PAA(x_hat) - PAA(y_hat)||`` a
    *provable lower bound* on the true z-normalized distance (classic PAA bound
    applied to the normalized subsequences).
    """
    n = t.shape[0]
    pl = n - m + 1
    w = m // dd
    mu, sig = moving_mean_std(t, m)
    sig = np.where(sig > 0, sig, 1.0)  # zero-std windows become zero vectors and are never pruned
    cs = np.concatenate(([0.0], np.cumsum(t)))
    idx = np.arange(pl)
    p = np.empty((pl, w), dtype=np.float64)
    for k in range(w):
        a, b = k * dd, (k + 1) * dd
        p[:, k] = (cs[idx + b] - cs[idx + a]) / dd
    return (p - mu[:, None]) / sig[:, None]


def _lower_bound(t: np.ndarray, m: int, dd: int, profile_len: int, alive: np.ndarray) -> np.ndarray:
    """Valid lower bound on the matrix profile at downsampling rate ``dd``.

    Only computed for currently-alive positions (already-pruned positions keep
    ``-inf`` so they are never re-pruned). For each alive window ``i`` the bound is
    ``sqrt(dd) * min_j ||p_i - p_j||`` over all non-trivial neighbors ``j``.
    """
    p = _znorm_paa_vectors(t, m, dd)
    excl = exclusion_zone(m)
    scale = np.sqrt(dd)
    sq = np.einsum("ij,ij->i", p, p)
    lb = np.full(profile_len, -np.inf)
    for i in np.flatnonzero(alive):
        d2 = sq + sq[i] - 2.0 * (p @ p[i])
        np.maximum(d2, 0.0, out=d2)
        d = np.sqrt(d2) * scale
        lo, hi = max(0, i - excl), min(profile_len, i + excl + 1)
        d[lo:hi] = np.inf
        lb[i] = d.min()
    return lb


def momp_anytime(t: np.ndarray, m: int) -> Iterator[MompLevel]:
    """Run MOMP, yielding a :class:`MompLevel` snapshot after every level.

    The final yielded snapshot has ``exact=True`` and carries the exact motif.
    """
    t = np.asarray(t, dtype=np.float64)
    n = t.shape[0]
    if m < 4:
        raise ValueError("subsequence length m must be >= 4")
    if n < 2 * m:
        raise ValueError("series too short for a motif of this length")

    profile_len = n - m + 1
    excl = exclusion_zone(m)
    alive = np.ones(profile_len, dtype=bool)
    bsf = np.inf
    best_pair: tuple[int, int] | None = None

    for dd in _schedule(m):
        if dd == 1:
            # Exact level: evaluate every surviving candidate against the full series.
            for i in np.flatnonzero(alive):
                d, j = _exact_nn(t, m, int(i), excl)
                if d < bsf:
                    bsf = d
                    best_pair = (int(i), j)
            yield MompLevel(
                dsr=1,
                bsf=float(bsf),
                pair=best_pair,
                alive=int(alive.sum()),
                pruned_fraction=1.0 - alive.sum() / profile_len,
                exact=True,
            )
            break

        lb = _lower_bound(t, m, dd, profile_len, alive)
        # Refine the single most promising alive candidate to tighten bsf.
        masked = np.where(alive, lb, np.inf)
        cand = int(np.argmin(masked))
        if np.isfinite(masked[cand]):
            d, j = _exact_nn(t, m, cand, excl)
            if d < bsf:
                bsf = d
                best_pair = (cand, j)

        # Prune: a position whose lower bound already exceeds bsf cannot be a motif.
        prunable = alive & (lb > bsf)
        alive &= ~prunable

        yield MompLevel(
            dsr=dd,
            bsf=float(bsf),
            pair=best_pair,
            alive=int(alive.sum()),
            pruned_fraction=1.0 - alive.sum() / profile_len,
            exact=False,
        )


def momp(t: np.ndarray, m: int) -> MompResult:
    """Return the exact top-1 motif of ``t`` for subsequence length ``m``."""
    last: MompLevel | None = None
    n_levels = 0
    for level in momp_anytime(t, m):
        last = level
        n_levels += 1
    assert last is not None and last.pair is not None
    a, b = sorted(last.pair)
    return MompResult(distance=last.bsf, pair=(a, b), m=m, levels=n_levels)
