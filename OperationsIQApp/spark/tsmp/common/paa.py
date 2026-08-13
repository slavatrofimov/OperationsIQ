"""Piecewise Aggregate Approximation (PAA) downsampling.

Faithful port of the reference ``paa.py`` from the MOMP repository
(maryam-shchgh/momp), used by MOMP to build lower-bound approximate matrix profiles.
"""
from __future__ import annotations

import numpy as np

__all__ = ["paa"]


def paa(s: np.ndarray, nseg: int) -> np.ndarray:
    """Reduce series ``s`` to ``nseg`` piecewise-constant segment averages.

    Blocks of length ``len(s) // nseg`` are averaged. Any trailing samples that do
    not fill a whole segment are dropped, matching the reference implementation.

    Parameters
    ----------
    s : 1-D array (the time series)
    nseg : number of PAA segments (must be >= 1 and <= len(s))

    Returns
    -------
    1-D array of length ``nseg`` with the per-segment means.
    """
    s = np.asarray(s, dtype=np.float64)
    n = s.shape[0]
    if nseg < 1:
        raise ValueError("nseg must be >= 1")
    seg_len = n // nseg
    if seg_len < 1:
        raise ValueError(f"nseg={nseg} too large for series length {n}")
    trimmed = s[: nseg * seg_len].reshape(nseg, seg_len)
    return trimmed.mean(axis=1)
