"""Exact self-join Matrix Profile via the MPX algorithm.

Vectorized NumPy port of ``mpx.m`` from the reference MOMP repository
(maryam-shchgh/momp). MPX computes the z-normalized Euclidean-distance matrix profile
using a streaming cross-correlation update along each diagonal — O(n^2) time, O(n)
space, and **exact**. Diagonals are independent, which is exactly the axis the P2
Spark implementation parallelizes over.

Results are validated against STUMPY (``stumpy.stump``) in the test suite.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from tsmp.common.stats import muinvn, exclusion_zone

__all__ = [
    "mpx",
    "matrix_profile",
    "MatrixProfile",
    "mpx_prep",
    "mpx_accumulate",
    "corr_to_distance",
    "MpxPrep",
    "LRMatrixProfile",
    "mpx_lr",
    "mpx_accumulate_lr",
]


@dataclass
class MatrixProfile:
    """Matrix profile and companion index array."""

    mp: np.ndarray   # nearest-neighbor z-normalized Euclidean distance per window
    mpi: np.ndarray  # index of that nearest neighbor (-1 if none)
    m: int           # subsequence length
    minlag: int      # exclusion radius used


@dataclass
class LRMatrixProfile:
    """Directional (left / right) matrix profile.

    The *left* profile at index ``i`` describes the nearest neighbor found strictly to the
    left (``j < i``); the *right* profile describes the nearest neighbor strictly to the
    right (``j > i``). These directional indices are the input to Time-Series Chains: a
    subsequence ``i`` links forward to ``ir[i]`` and the link is confirmed when
    ``il[ir[i]] == i`` (the two are mutual left/right nearest neighbors).
    """

    mp_left: np.ndarray   # distance to nearest left neighbor (inf if none)
    il: np.ndarray        # index of nearest left neighbor (-1 if none)
    mp_right: np.ndarray  # distance to nearest right neighbor (inf if none)
    ir: np.ndarray        # index of nearest right neighbor (-1 if none)
    m: int
    minlag: int


@dataclass
class MpxPrep:
    """Precomputed, broadcast-friendly state shared by every diagonal block.

    These arrays depend only on the (broadcast) series and window length, so the P2
    Spark implementation computes them once on the driver and ships them to every
    task; each task then processes a disjoint range of diagonals.
    """

    a: np.ndarray
    w: int
    minlag: int
    profile_len: int
    mu: np.ndarray
    sig: np.ndarray
    df: np.ndarray
    dg: np.ndarray
    first_centered: np.ndarray


def mpx_prep(a: np.ndarray, w: int, minlag: int | None = None) -> MpxPrep:
    """Precompute the diagonal-update state used by :func:`mpx_accumulate`."""
    a = np.asarray(a, dtype=np.float64)
    n = a.shape[0]
    if w < 4:
        raise ValueError("subsequence length w must be >= 4")
    if n < w:
        raise ValueError("series shorter than subsequence length")
    if minlag is None:
        minlag = exclusion_zone(w)

    profile_len = n - w + 1
    mu, sig = muinvn(a, w)

    df = np.zeros(profile_len)
    dg = np.zeros(profile_len)
    df[1:] = 0.5 * (a[w:n] - a[: n - w])
    dg[1:] = (a[w:n] - mu[1:profile_len]) + (a[: n - w] - mu[: profile_len - 1])

    first_centered = a[:w] - mu[0]
    return MpxPrep(
        a=a, w=w, minlag=minlag, profile_len=profile_len,
        mu=mu, sig=sig, df=df, dg=dg, first_centered=first_centered,
    )


def mpx_accumulate(
    prep: MpxPrep,
    k_lo: int,
    k_hi: int,
    corr_mp: np.ndarray | None = None,
    mpi: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Accumulate the correlation profile over diagonals ``k in [k_lo, k_hi)``.

    Returns ``(corr_mp, mpi)`` in the *correlation* domain (higher == closer). Passing
    a disjoint ``[k_lo, k_hi)`` per task and reducing the partials with an element-wise
    argmax yields exactly the same result as the monolithic loop — this is the P2
    parallelization contract.
    """
    profile_len = prep.profile_len
    if corr_mp is None:
        corr_mp = np.full(profile_len, -np.inf)
    if mpi is None:
        mpi = np.full(profile_len, -1, dtype=np.int64)

    a, w, mu, sig = prep.a, prep.w, prep.mu, prep.sig
    df, dg, first_centered = prep.df, prep.dg, prep.first_centered

    lo = max(k_lo, prep.minlag + 1)
    hi = min(k_hi, profile_len)
    for k in range(lo, hi):
        length = profile_len - k
        offs = np.arange(length)
        c_init = np.dot(a[k : k + w] - mu[k], first_centered)
        incr = df[offs] * dg[offs + k] + df[offs + k] * dg[offs]
        incr[0] = 0.0
        c = c_init + np.cumsum(incr)
        corr = c * sig[offs] * sig[offs + k]

        better = corr > corr_mp[offs]
        sel = offs[better]
        corr_mp[sel] = corr[better]
        mpi[sel] = sel + k

        right = offs + k
        better2 = corr > corr_mp[right]
        selr = right[better2]
        corr_mp[selr] = corr[better2]
        mpi[selr] = selr - k

    return corr_mp, mpi


def corr_to_distance(corr_mp: np.ndarray, w: int) -> np.ndarray:
    """Convert a correlation-domain profile to z-normalized Euclidean distance."""
    corr_clipped = np.minimum(corr_mp, 1.0)
    mp = np.sqrt(np.maximum(2.0 * w * (1.0 - corr_clipped), 0.0))
    mp[np.isneginf(corr_mp)] = np.inf
    return mp


def mpx(a: np.ndarray, w: int, minlag: int | None = None) -> MatrixProfile:
    """Compute the exact self-join matrix profile of ``a`` for window length ``w``.

    Parameters
    ----------
    a : 1-D time series.
    w : subsequence (window) length, ``w >= 4``.
    minlag : trivial-match exclusion radius; subsequences within ``minlag`` index
        positions of each other are ignored. Defaults to ``ceil(w / 4)`` to match
        STUMPY.
    """
    prep = mpx_prep(a, w, minlag)
    corr_mp, mpi = mpx_accumulate(prep, prep.minlag + 1, prep.profile_len)
    mp = corr_to_distance(corr_mp, prep.w)
    return MatrixProfile(mp=mp, mpi=mpi, m=prep.w, minlag=prep.minlag)


def matrix_profile(a: np.ndarray, w: int, minlag: int | None = None) -> np.ndarray:
    """Convenience wrapper returning just the matrix-profile distance array."""
    return mpx(a, w, minlag).mp


def mpx_accumulate_lr(
    prep: MpxPrep,
    k_lo: int,
    k_hi: int,
    corr_left: np.ndarray | None = None,
    il: np.ndarray | None = None,
    corr_right: np.ndarray | None = None,
    ir: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Accumulate *directional* correlation profiles over diagonals ``k in [k_lo, k_hi)``.

    Along diagonal ``k > 0`` the window at ``offs`` is compared with the window at
    ``offs + k``, which lies to its right. So ``offs`` gains a candidate *right* neighbor
    (``offs + k``) and ``offs + k`` gains a candidate *left* neighbor (``offs``). Keeping
    those two updates in separate arrays yields, after reducing over all diagonals, the
    exact nearest left / right neighbor of every window. Returned in the *correlation*
    domain (higher == closer); reduce disjoint diagonal ranges with an element-wise argmax
    per side, exactly like :func:`mpx_accumulate`.
    """
    profile_len = prep.profile_len
    if corr_left is None:
        corr_left = np.full(profile_len, -np.inf)
    if il is None:
        il = np.full(profile_len, -1, dtype=np.int64)
    if corr_right is None:
        corr_right = np.full(profile_len, -np.inf)
    if ir is None:
        ir = np.full(profile_len, -1, dtype=np.int64)

    a, w, mu, sig = prep.a, prep.w, prep.mu, prep.sig
    df, dg, first_centered = prep.df, prep.dg, prep.first_centered

    lo = max(k_lo, prep.minlag + 1)
    hi = min(k_hi, profile_len)
    for k in range(lo, hi):
        length = profile_len - k
        offs = np.arange(length)
        c_init = np.dot(a[k : k + w] - mu[k], first_centered)
        incr = df[offs] * dg[offs + k] + df[offs + k] * dg[offs]
        incr[0] = 0.0
        c = c_init + np.cumsum(incr)
        corr = c * sig[offs] * sig[offs + k]

        right = offs + k
        # offs sees a neighbor to its right (offs + k).
        better_r = corr > corr_right[offs]
        selr = offs[better_r]
        corr_right[selr] = corr[better_r]
        ir[selr] = selr + k
        # offs + k sees a neighbor to its left (offs).
        better_l = corr > corr_left[right]
        sell = right[better_l]
        corr_left[sell] = corr[better_l]
        il[sell] = sell - k

    return corr_left, il, corr_right, ir


def mpx_lr(a: np.ndarray, w: int, minlag: int | None = None) -> LRMatrixProfile:
    """Compute the exact directional (left / right) self-join matrix profile.

    Same O(n^2) diagonal sweep as :func:`mpx`, but the nearest neighbor is tracked
    separately for the left (``j < i``) and right (``j > i``) directions. The directional
    indices ``il`` / ``ir`` are the substrate for Time-Series Chains.
    """
    prep = mpx_prep(a, w, minlag)
    corr_left, il, corr_right, ir = mpx_accumulate_lr(prep, prep.minlag + 1, prep.profile_len)
    return LRMatrixProfile(
        mp_left=corr_to_distance(corr_left, prep.w),
        il=il,
        mp_right=corr_to_distance(corr_right, prep.w),
        ir=ir,
        m=prep.w,
        minlag=prep.minlag,
    )
