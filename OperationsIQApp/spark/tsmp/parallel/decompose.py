"""Pure ``map`` / ``reduce`` decomposition of the Matrix Profile primitives.

Every function here takes a ``mapper`` argument that defaults to the builtin ``map``
(serial execution) so the decomposition can be unit-tested without Spark. The PySpark
wrappers in :mod:`tsmp.parallel.spark` pass a distributed mapper instead. The
decomposition is designed to reproduce the monolithic results in :mod:`tsmp` *exactly*.

Two parallel axes are exposed:

* **Diagonal-block MP** — the MPX self-join loop runs over diagonals ``k`` that are
  mutually independent and combine by an element-wise argmax on correlation. Splitting
  ``k`` into disjoint ranges and reducing the partials is exact.
* **Independent candidate scan** — nearest-neighbor distances for a set of query
  windows (used by the MOMP exact pass and DAMP) are embarrassingly parallel: each
  query is one task.
"""
from __future__ import annotations

from typing import Callable, Iterable

import numpy as np

from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone
from tsmp.momp.mpx import (
    MatrixProfile,
    LRMatrixProfile,
    mpx_prep,
    mpx_accumulate,
    mpx_accumulate_lr,
    corr_to_distance,
)
from tsmp.damp.damp import DiscordResult

__all__ = [
    "diagonal_blocks",
    "combine_corr",
    "combine_lr",
    "parallel_matrix_profile",
    "parallel_lr_matrix_profile",
    "parallel_nn_scan",
    "parallel_discords",
    "threaded_mapper",
    "should_distribute",
    "mp_work_units",
]

Mapper = Callable[[Callable, Iterable], Iterable]


def threaded_mapper(n_workers: int) -> Mapper:
    """A ``mapper`` backed by a thread pool.

    A portable stand-in for the Spark mapper: the heavy inner work (FFT dot products,
    vectorized NumPy) releases the GIL, so threads give real wall-clock speedup without
    a Spark/JVM runtime. Handy for local benchmarking and for the adaptive
    "driver-only" path on modest inputs.
    """
    from concurrent.futures import ThreadPoolExecutor

    def mapper(fn, items):
        items = list(items)
        if not items:
            return []
        with ThreadPoolExecutor(max_workers=n_workers) as ex:
            return list(ex.map(fn, items))

    return mapper


def mp_work_units(n: int, m: int) -> int:
    """Approximate matrix-profile work: proportional to ``profile_len^2`` diagonals."""
    profile_len = max(0, n - m + 1)
    return profile_len * profile_len


def should_distribute(n: int, m: int, threshold: int = 4_000_000) -> bool:
    """Adaptive driver-vs-Spark decision.

    Below ``threshold`` work units the Spark scheduling/serialization overhead dominates
    the actual compute, so the job should run on the driver (single task). Above it,
    fan out across executors. The default threshold corresponds to a profile length of
    ~2000 windows and is tuned per workspace in production (see design spec §6.2).
    """
    return mp_work_units(n, m) >= threshold


def diagonal_blocks(minlag: int, profile_len: int, n_blocks: int) -> list[tuple[int, int, int]]:
    """Split the diagonal range ``[minlag+1, profile_len)`` into ``n_blocks`` tasks.

    Diagonal ``k`` carries ``profile_len - k`` work units, so blocks are chosen to
    equalize *total* work (not diagonal count), giving balanced tasks. Returns a list
    of ``(block_id, k_lo, k_hi)`` in ascending ``k`` order; ``block_id`` fixes the
    deterministic reduce order so the parallel result matches the serial one exactly.
    """
    start = minlag + 1
    if start >= profile_len:
        return []
    n_blocks = max(1, min(n_blocks, profile_len - start))
    ks = np.arange(start, profile_len)
    work = (profile_len - ks).astype(np.float64)
    cum = np.cumsum(work)
    total = cum[-1]
    blocks: list[tuple[int, int, int]] = []
    prev = start
    for b in range(1, n_blocks + 1):
        if prev >= profile_len:
            break
        target = total * b / n_blocks
        # first diagonal index whose cumulative work reaches the target
        pos = int(np.searchsorted(cum, target, side="left"))
        k_hi = min(profile_len, start + pos + 1)
        k_hi = max(k_hi, prev + 1)
        blocks.append((len(blocks), prev, k_hi))
        prev = k_hi
    if prev < profile_len:
        blocks.append((len(blocks), prev, profile_len))
    return blocks


def combine_corr(
    lo: tuple[np.ndarray, np.ndarray],
    hi: tuple[np.ndarray, np.ndarray],
) -> tuple[np.ndarray, np.ndarray]:
    """Element-wise argmax reduce of two correlation partials.

    ``lo`` is the lower-``block_id`` (lower-``k``) partial. On an exact correlation tie
    ``lo`` is kept, mirroring the strict ``>`` update order of the monolithic loop.
    """
    lo_corr, lo_mpi = lo
    hi_corr, hi_mpi = hi
    take_hi = hi_corr > lo_corr
    out_corr = np.where(take_hi, hi_corr, lo_corr)
    out_mpi = np.where(take_hi, hi_mpi, lo_mpi)
    return out_corr, out_mpi


def parallel_matrix_profile(
    a: np.ndarray,
    w: int,
    minlag: int | None = None,
    n_blocks: int = 4,
    mapper: Mapper = map,
) -> MatrixProfile:
    """Exact self-join matrix profile computed by diagonal-block map/reduce.

    Bit-for-bit identical to :func:`tsmp.momp.mpx.mpx` for any ``n_blocks``.
    """
    prep = mpx_prep(a, w, minlag)
    blocks = diagonal_blocks(prep.minlag, prep.profile_len, n_blocks)

    if not blocks:
        corr = np.full(prep.profile_len, -np.inf)
        mpi = np.full(prep.profile_len, -1, dtype=np.int64)
        return MatrixProfile(corr_to_distance(corr, prep.w), mpi, prep.w, prep.minlag)

    def _task(block: tuple[int, int, int]):
        bid, k_lo, k_hi = block
        corr, mpi = mpx_accumulate(prep, k_lo, k_hi)
        return bid, corr, mpi

    partials = list(mapper(_task, blocks))
    # Deterministic reduce in ascending block_id so ties resolve to the lower k.
    partials.sort(key=lambda p: p[0])
    acc_corr, acc_mpi = partials[0][1], partials[0][2]
    for _, corr, mpi in partials[1:]:
        acc_corr, acc_mpi = combine_corr((acc_corr, acc_mpi), (corr, mpi))

    mp = corr_to_distance(acc_corr, prep.w)
    return MatrixProfile(mp=mp, mpi=acc_mpi, m=prep.w, minlag=prep.minlag)


def combine_lr(
    lo: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    hi: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Element-wise argmax reduce of two directional (left/right) correlation partials.

    Each partial is ``(corr_left, il, corr_right, ir)``. The left and right sides are
    reduced independently; on an exact tie the lower-``block_id`` partial (``lo``) wins,
    matching the strict ``>`` update order of the monolithic loop.
    """
    lo_cl, lo_il, lo_cr, lo_ir = lo
    hi_cl, hi_il, hi_cr, hi_ir = hi
    take_l = hi_cl > lo_cl
    take_r = hi_cr > lo_cr
    return (
        np.where(take_l, hi_cl, lo_cl),
        np.where(take_l, hi_il, lo_il),
        np.where(take_r, hi_cr, lo_cr),
        np.where(take_r, hi_ir, lo_ir),
    )


def parallel_lr_matrix_profile(
    a: np.ndarray,
    w: int,
    minlag: int | None = None,
    n_blocks: int = 4,
    mapper: Mapper = map,
) -> LRMatrixProfile:
    """Exact directional (left/right) matrix profile via diagonal-block map/reduce.

    Bit-for-bit identical to :func:`tsmp.momp.mpx.mpx_lr` for any ``n_blocks``; the heavy
    O(n^2) diagonal sweep fans out across the injected ``mapper`` so chains scale to long
    windows on a cluster.
    """
    prep = mpx_prep(a, w, minlag)
    blocks = diagonal_blocks(prep.minlag, prep.profile_len, n_blocks)

    if not blocks:
        inf_corr = np.full(prep.profile_len, -np.inf)
        empty = np.full(prep.profile_len, -1, dtype=np.int64)
        return LRMatrixProfile(
            mp_left=corr_to_distance(inf_corr.copy(), prep.w),
            il=empty.copy(),
            mp_right=corr_to_distance(inf_corr.copy(), prep.w),
            ir=empty.copy(),
            m=prep.w,
            minlag=prep.minlag,
        )

    def _task(block: tuple[int, int, int]):
        bid, k_lo, k_hi = block
        cl, il, cr, ir = mpx_accumulate_lr(prep, k_lo, k_hi)
        return bid, cl, il, cr, ir

    partials = list(mapper(_task, blocks))
    partials.sort(key=lambda p: p[0])
    acc = (partials[0][1], partials[0][2], partials[0][3], partials[0][4])
    for _, cl, il, cr, ir in partials[1:]:
        acc = combine_lr(acc, (cl, il, cr, ir))

    acc_cl, acc_il, acc_cr, acc_ir = acc
    return LRMatrixProfile(
        mp_left=corr_to_distance(acc_cl, prep.w),
        il=acc_il,
        mp_right=corr_to_distance(acc_cr, prep.w),
        ir=acc_ir,
        m=prep.w,
        minlag=prep.minlag,
    )


def _exact_nn(t: np.ndarray, m: int, i: int, excl: int) -> tuple[float, int]:
    dp = mass(t[i : i + m], t)
    lo = max(0, i - excl)
    hi = min(len(dp), i + excl + 1)
    dp[lo:hi] = np.inf
    j = int(np.argmin(dp))
    return float(dp[j]), j


def parallel_nn_scan(
    t: np.ndarray,
    m: int,
    indices: Iterable[int],
    minlag: int | None = None,
    mapper: Mapper = map,
) -> dict[int, tuple[float, int]]:
    """Exact nearest-neighbor distance/index for each query window in ``indices``.

    Embarrassingly parallel: one MASS per query. Used to parallelize the MOMP exact
    refinement pass and DAMP candidate verification.
    """
    t = np.asarray(t, dtype=np.float64)
    if minlag is None:
        minlag = exclusion_zone(m)
    idx_list = [int(i) for i in indices]

    def _task(i: int):
        d, j = _exact_nn(t, m, i, minlag)
        return i, d, j

    return {i: (d, j) for i, d, j in mapper(_task, idx_list)}


def parallel_discords(
    t: np.ndarray,
    m: int,
    k: int = 1,
    minlag: int | None = None,
    n_blocks: int = 4,
    mapper: Mapper = map,
) -> list[DiscordResult]:
    """Exact top-``k`` discords via the diagonal-block parallel matrix profile.

    Equivalent to :func:`tsmp.damp.damp.discords` but the (dominant) matrix-profile
    computation is distributed across ``n_blocks`` tasks.
    """
    t = np.asarray(t, dtype=np.float64)
    if minlag is None:
        minlag = exclusion_zone(m)
    profile = parallel_matrix_profile(t, m, minlag, n_blocks, mapper)
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
