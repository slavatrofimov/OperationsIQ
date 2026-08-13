"""Parallel decomposition of the Matrix Profile compute core (P2).

The numerics live in :mod:`tsmp` (single node, framework-free). This subpackage adds:

* :mod:`tsmp.parallel.decompose` — pure ``map`` / ``reduce`` primitives that split the
  work into independent tasks and recombine them. These reproduce the monolithic
  results *exactly* and are unit-tested with the builtin ``map`` (no Spark required),
  which is where the real correctness risk of parallelization lives.
* :mod:`tsmp.parallel.spark` — thin PySpark wrappers that feed the same primitives to
  ``sc.parallelize(...).map(...).reduce(...)``. PySpark is imported lazily so importing
  :mod:`tsmp` never requires a Spark/JVM runtime.
"""

from tsmp.parallel.decompose import (
    diagonal_blocks,
    combine_corr,
    parallel_matrix_profile,
    parallel_nn_scan,
    parallel_discords,
    threaded_mapper,
    should_distribute,
    mp_work_units,
)

__all__ = [
    "diagonal_blocks",
    "combine_corr",
    "parallel_matrix_profile",
    "parallel_nn_scan",
    "parallel_discords",
    "threaded_mapper",
    "should_distribute",
    "mp_work_units",
]
