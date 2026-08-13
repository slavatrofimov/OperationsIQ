"""Common numerical primitives: moving statistics used by MPX / MASS / MOMP."""
from __future__ import annotations

import numpy as np

__all__ = ["moving_mean_std", "muinvn", "EXCL_ZONE_DENOM", "exclusion_zone"]

# Matches STUMPY's default trivial-match exclusion zone (m / 4).
EXCL_ZONE_DENOM = 4


def exclusion_zone(m: int) -> int:
    """Trivial-match exclusion radius for subsequence length ``m``.

    Two subsequences whose start indices differ by <= this value are considered
    trivial matches and ignored. Uses ``ceil(m / 4)`` to match STUMPY.
    """
    return int(np.ceil(m / EXCL_ZONE_DENOM))


def moving_mean_std(a: np.ndarray, w: int) -> tuple[np.ndarray, np.ndarray]:
    """Sliding-window mean and (population) standard deviation.

    Returns two arrays of length ``len(a) - w + 1``. Computed with cumulative sums
    for O(n) performance; a small negative-variance clamp guards against
    floating-point noise on near-constant windows.
    """
    a = np.asarray(a, dtype=np.float64)
    n = a.shape[0]
    if w < 1 or w > n:
        raise ValueError(f"window w={w} out of range for series length {n}")

    cs = np.concatenate(([0.0], np.cumsum(a)))
    cs2 = np.concatenate(([0.0], np.cumsum(a * a)))
    seg = cs[w:] - cs[:-w]
    seg2 = cs2[w:] - cs2[:-w]
    mu = seg / w
    var = seg2 / w - mu * mu
    var = np.maximum(var, 0.0)
    sig = np.sqrt(var)
    return mu, sig


def muinvn(a: np.ndarray, w: int) -> tuple[np.ndarray, np.ndarray]:
    """Sliding mean and *inverse centered L2 norm* used by MPX.

    ``sig[i] = 1 / ||a[i:i+w] - mu[i]||_2``. For constant windows (zero norm) the
    inverse is set to 0 so that correlations with them evaluate to 0 (max distance)
    rather than NaN/inf.
    """
    mu, std = moving_mean_std(a, w)
    norm = std * np.sqrt(w)  # ||x - mu||_2 = sqrt(w) * population_std
    siginv = np.zeros_like(norm)
    nz = norm > 0
    siginv[nz] = 1.0 / norm[nz]
    return mu, siginv
