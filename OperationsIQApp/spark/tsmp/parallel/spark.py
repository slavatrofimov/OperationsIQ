"""Thin PySpark wrappers over the tested decomposition primitives.

PySpark is imported lazily inside each function so that importing :mod:`tsmp` (and
running the single-node tests) never requires a JVM/Spark runtime. Each wrapper simply
supplies a Spark-backed ``mapper`` to the corresponding function in
:mod:`tsmp.parallel.decompose`, so the numerics are identical to the serial path.

On Fabric these run inside a Spark Job Definition / notebook; the driver holds the
(broadcast) series and reduces the small partial arrays. This module is the P2 seam
between the framework-free compute core and distributed execution.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from tsmp.momp.mpx import MatrixProfile
from tsmp.damp.damp import DiscordResult
from tsmp.parallel import decompose

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pyspark import SparkContext

__all__ = [
    "spark_matrix_profile",
    "spark_discords",
    "spark_nn_scan",
    "default_num_partitions",
]


def default_num_partitions(sc: "SparkContext") -> int:
    """A sensible default task count: 2-4x the cluster's core count."""
    try:
        cores = int(sc.defaultParallelism)
    except Exception:  # pragma: no cover - defensive
        cores = 4
    return max(2, cores * 3)


def _spark_mapper(sc: "SparkContext", n_slices: int):
    """Build a ``mapper(fn, items)`` that runs ``fn`` over ``items`` on Spark.

    Results are collected to the driver. Callables and captured arrays are shipped via
    Spark's cloudpickle serialization; the reduce itself happens on the driver so the
    deterministic ordering guarantees in ``decompose`` are preserved.
    """
    def mapper(fn, items):
        items = list(items)
        slices = min(n_slices, len(items)) if items else 1
        return sc.parallelize(items, slices).map(fn).collect()

    return mapper


def spark_matrix_profile(
    sc: "SparkContext",
    a: np.ndarray,
    w: int,
    minlag: int | None = None,
    n_partitions: int | None = None,
) -> MatrixProfile:
    """Distributed exact matrix profile (diagonal-block decomposition)."""
    n = n_partitions or default_num_partitions(sc)
    mapper = _spark_mapper(sc, n)
    return decompose.parallel_matrix_profile(a, w, minlag, n_blocks=n, mapper=mapper)


def spark_discords(
    sc: "SparkContext",
    t: np.ndarray,
    m: int,
    k: int = 1,
    minlag: int | None = None,
    n_partitions: int | None = None,
) -> list[DiscordResult]:
    """Distributed exact top-``k`` discords (parallel MP + driver-side top-k)."""
    n = n_partitions or default_num_partitions(sc)
    mapper = _spark_mapper(sc, n)
    return decompose.parallel_discords(t, m, k, minlag, n_blocks=n, mapper=mapper)


def spark_nn_scan(
    sc: "SparkContext",
    t: np.ndarray,
    m: int,
    indices,
    minlag: int | None = None,
    n_partitions: int | None = None,
) -> dict[int, tuple[float, int]]:
    """Distributed exact nearest-neighbor scan over a set of query windows.

    This is the parallel engine for the MOMP exact-refinement pass (evaluate every
    surviving candidate) and for DAMP candidate verification.
    """
    n = n_partitions or default_num_partitions(sc)
    mapper = _spark_mapper(sc, n)
    return decompose.parallel_nn_scan(t, m, indices, minlag, mapper=mapper)
