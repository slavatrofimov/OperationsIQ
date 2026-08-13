"""P2 parallelization parity tests.

The decomposition primitives run with the builtin ``map`` (serial) so no Spark/JVM is
needed. They must reproduce the monolithic :mod:`tsmp` results *exactly* for any number
of blocks — that equivalence is the whole correctness contract of P2.
"""
import numpy as np
import pytest

from tsmp.momp.mpx import mpx
from tsmp.damp.damp import discords
from tsmp.parallel.decompose import (
    diagonal_blocks,
    parallel_matrix_profile,
    parallel_nn_scan,
    parallel_discords,
    threaded_mapper,
    should_distribute,
    mp_work_units,
)
from tsmp import datagen


@pytest.mark.parametrize("n_blocks", [1, 2, 3, 5, 8, 64])
def test_diagonal_blocks_tile_the_range_disjointly(n_blocks):
    minlag, profile_len = 7, 200
    blocks = diagonal_blocks(minlag, profile_len, n_blocks)
    # Contiguous, disjoint, and covering [minlag+1, profile_len).
    assert blocks[0][1] == minlag + 1
    assert blocks[-1][2] == profile_len
    for (_, _, hi), (_, lo2, _) in zip(blocks, blocks[1:]):
        assert hi == lo2
    ids = [b[0] for b in blocks]
    assert ids == sorted(ids)


@pytest.mark.parametrize("n_blocks", [1, 2, 4, 7, 16])
def test_parallel_mp_matches_monolithic(n_blocks):
    t = datagen.random_walk(500, seed=21)
    m = 32
    ref = mpx(t, m)
    par = parallel_matrix_profile(t, m, n_blocks=n_blocks)
    np.testing.assert_allclose(par.mp, ref.mp, atol=1e-9, rtol=0)
    # Indices match exactly on non-degenerate random-walk data (no correlation ties).
    np.testing.assert_array_equal(par.mpi, ref.mpi)


def test_parallel_mp_matches_monolithic_with_planted_motif():
    m = 30
    t = datagen.planted_motif(600, m, loc_a=100, loc_b=420, seed=2)
    ref = mpx(t, m)
    par = parallel_matrix_profile(t, m, n_blocks=6)
    np.testing.assert_allclose(par.mp, ref.mp, atol=1e-9, rtol=0)
    np.testing.assert_array_equal(par.mpi, ref.mpi)


def test_parallel_nn_scan_matches_direct_mass():
    t = datagen.random_walk(400, seed=22)
    m = 24
    ref = mpx(t, m)
    idxs = [0, 50, 137, 200, len(t) - m]
    scan = parallel_nn_scan(t, m, idxs, mapper=map)
    for i in idxs:
        d, _ = scan[i]
        assert d == pytest.approx(float(ref.mp[i]), abs=1e-6)


@pytest.mark.parametrize("n_blocks", [1, 4, 9])
def test_parallel_discords_match_serial(n_blocks):
    t = datagen.random_walk(500, seed=23)
    m = 28
    ref = discords(t, m, k=3)
    par = parallel_discords(t, m, k=3, n_blocks=n_blocks)
    assert [d.index for d in par] == [d.index for d in ref]
    for a, b in zip(par, ref):
        assert a.nn_distance == pytest.approx(b.nn_distance, abs=1e-9)


def test_threaded_mapper_matches_serial_mp():
    t = datagen.random_walk(500, seed=24)
    m = 32
    ref = mpx(t, m)
    par = parallel_matrix_profile(t, m, n_blocks=8, mapper=threaded_mapper(4))
    np.testing.assert_allclose(par.mp, ref.mp, atol=1e-9, rtol=0)
    np.testing.assert_array_equal(par.mpi, ref.mpi)


def test_threaded_mapper_nn_scan_matches_serial():
    t = datagen.random_walk(400, seed=25)
    m = 24
    ref = mpx(t, m)
    idxs = list(range(0, len(t) - m + 1, 37))
    scan = parallel_nn_scan(t, m, idxs, mapper=threaded_mapper(4))
    for i in idxs:
        assert scan[i][0] == pytest.approx(float(ref.mp[i]), abs=1e-6)


def test_should_distribute_threshold():
    assert mp_work_units(2000, 1) == 2000 * 2000
    # Small series -> run on the driver; large series -> fan out to Spark.
    assert should_distribute(500, 32) is False
    assert should_distribute(50_000, 32) is True
