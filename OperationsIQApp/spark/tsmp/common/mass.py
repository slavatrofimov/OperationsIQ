"""MASS — Mueen's Algorithm for Similarity Search.

Computes the z-normalized Euclidean **distance profile** between a query subsequence
``Q`` and every length-``len(Q)`` window of a series ``T`` in O(n log n) via an
FFT-based sliding dot product. This is the parallel unit of work for DAMP and the
AB-join refinement in MOMP.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import fftconvolve

from tsmp.common.stats import moving_mean_std

__all__ = ["mass", "sliding_dot_product"]


def sliding_dot_product(q: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Return ``QT[i] = sum_k q[k] * t[i+k]`` for every valid window ``i``.

    Length of the result is ``len(t) - len(q) + 1``.
    """
    q = np.asarray(q, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    m = q.shape[0]
    n = t.shape[0]
    conv = fftconvolve(t, q[::-1])
    return conv[m - 1 : n]


def mass(q: np.ndarray, t: np.ndarray) -> np.ndarray:
    """z-normalized Euclidean distance profile of ``q`` against ``t``.

    Constant windows (zero standard deviation) are handled gracefully: a distance of
    0 when both query and window are constant, otherwise ``sqrt(2m)`` (the maximum
    z-normalized distance), instead of producing NaNs.
    """
    q = np.asarray(q, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    m = q.shape[0]
    if m < 1 or m > t.shape[0]:
        raise ValueError("query length out of range for series")

    mu_q = q.mean()
    sig_q = q.std()
    mu_t, sig_t = moving_mean_std(t, m)
    qt = sliding_dot_product(q, t)

    dist = np.empty_like(qt)
    denom = m * sig_q * sig_t
    valid = denom > 0
    corr = np.zeros_like(qt)
    corr[valid] = (qt[valid] - m * mu_q * mu_t[valid]) / denom[valid]
    corr = np.clip(corr, -1.0, 1.0)
    dist = np.sqrt(np.maximum(2.0 * m * (1.0 - corr), 0.0))

    # Degenerate cases where the standard formula is undefined.
    if sig_q == 0:
        both_const = ~valid & (sig_t == 0)
        one_const = ~valid & (sig_t > 0)
        dist[both_const] = 0.0
        dist[one_const] = np.sqrt(2.0 * m)
    else:
        dist[~valid] = np.sqrt(2.0 * m)
    return dist
