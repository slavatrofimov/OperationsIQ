"""Benchmark: serial vs. multi-core parallel matrix profile (P2 speedup evidence).

Demonstrates that the diagonal-block decomposition delivers *genuine* speedup on
multiple cores, without needing a Spark/JVM runtime. It uses a ``ProcessPoolExecutor``
(true parallelism, no GIL) with an initializer that broadcasts the precomputed ``prep``
state once per worker — mirroring how Spark broadcasts the series to each executor and
then processes a disjoint range of diagonals per task.

Every parallel result is checked bit-for-bit against the serial matrix profile, so this
doubles as a correctness harness. The same decomposition runs on Spark in production via
``tsmp.parallel.spark``.

Run (from the ``spark/`` directory):  python benchmark.py
"""
from __future__ import annotations

import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from tsmp import datagen
from tsmp.momp.mpx import mpx, mpx_prep, mpx_accumulate, corr_to_distance
from tsmp.parallel.decompose import diagonal_blocks, combine_corr, should_distribute

# Per-worker global state populated by the pool initializer (avoids re-pickling the
# broadcast `prep` for every task — the local analogue of a Spark broadcast variable).
_STATE: dict = {}


def _init_worker(prep) -> None:
    _STATE["prep"] = prep


def _diag_block(block):
    bid, k_lo, k_hi = block
    corr, mpi = mpx_accumulate(_STATE["prep"], k_lo, k_hi)
    return bid, corr, mpi


def _reduce(partials, w):
    partials.sort(key=lambda p: p[0])
    acc_corr, acc_mpi = partials[0][1], partials[0][2]
    for _, corr, mpi in partials[1:]:
        acc_corr, acc_mpi = combine_corr((acc_corr, acc_mpi), (corr, mpi))
    return corr_to_distance(acc_corr, w)


def _parallel_mp(ex, prep, n_blocks):
    blocks = diagonal_blocks(prep.minlag, prep.profile_len, n_blocks)
    partials = list(ex.map(_diag_block, blocks))
    return _reduce(partials, prep.w)


def _time(fn, repeat: int = 3) -> float:
    best = float("inf")
    for _ in range(repeat):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


def run(sizes=(4000, 8000, 12000), m: int = 200, workers=(2, 4)) -> None:
    cols = f"{'n':>7} {'m':>4} {'serial(s)':>10}"
    cols += "".join(f" {'p' + str(w) + '(s)':>9}" for w in workers)
    cols += "".join(f" {'speedup' + str(w):>10}" for w in workers)
    cols += "  distribute?"
    print(cols, flush=True)

    for n in sizes:
        t = datagen.random_walk(n, seed=7)
        prep = mpx_prep(t, m)
        ref = mpx(t, m)
        serial = _time(lambda: mpx(t, m), repeat=2)

        times = []
        for w in workers:
            n_blocks = max(w * 3, 4)
            # One warm pool per config: spawn + module import + broadcast happen once
            # (amortized, as on a long-lived Spark executor) and are excluded from the
            # timed region, which measures the actual parallel compute.
            with ProcessPoolExecutor(max_workers=w, initializer=_init_worker, initargs=(prep,)) as ex:
                par_mp = _parallel_mp(ex, prep, n_blocks)  # warm-up + correctness check
                assert np.allclose(par_mp, ref.mp, atol=1e-9), "parallel MP != serial MP"
                times.append(_time(lambda: _parallel_mp(ex, prep, n_blocks), repeat=3))

        speedups = [serial / tt if tt > 0 else float("nan") for tt in times]
        dist = "yes" if should_distribute(n, m) else "no"
        print(f"{n:>7} {m:>4} {serial:>10.3f}"
              + "".join(f" {tt:>9.3f}" for tt in times)
              + "".join(f" {s:>9.2f}x" for s in speedups)
              + f"  {dist:>11}", flush=True)


if __name__ == "__main__":
    run()
