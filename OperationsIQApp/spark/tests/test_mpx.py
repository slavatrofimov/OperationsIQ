"""MPX exact matrix-profile tests, validated against STUMPY as an independent oracle."""
import numpy as np
import pytest

from tsmp.momp.mpx import mpx, matrix_profile
from tsmp import datagen


def _brute_force_mp(t, m, minlag):
    n = len(t)
    l = n - m + 1

    def znorm(x):
        s = x.std()
        return (x - x.mean()) / s if s > 0 else np.zeros_like(x)

    mp = np.full(l, np.inf)
    mpi = np.full(l, -1)
    for i in range(l):
        zi = znorm(t[i : i + m])
        for j in range(l):
            if abs(i - j) <= minlag:
                continue
            d = np.linalg.norm(zi - znorm(t[j : j + m]))
            if d < mp[i]:
                mp[i] = d
                mpi[i] = j
    return mp, mpi


def test_mpx_matches_bruteforce(rng):
    t = rng.standard_normal(160)
    m = 16
    minlag = 4
    prof = mpx(t, m, minlag)
    mp_bf, _ = _brute_force_mp(t, m, minlag)
    assert np.allclose(prof.mp, mp_bf, atol=1e-6)


@pytest.mark.parametrize("m", [8, 16, 32])
def test_mpx_matches_stumpy_random_walk(m):
    stumpy = pytest.importorskip("stumpy")
    t = datagen.random_walk(500, seed=7)
    prof = mpx(t, m)  # default minlag = ceil(m/4) matches stumpy
    ref = stumpy.stump(t, m)[:, 0].astype(float)
    assert np.allclose(prof.mp, ref, atol=1e-5)


def test_mpx_matches_stumpy_with_motif():
    stumpy = pytest.importorskip("stumpy")
    t = datagen.planted_motif(600, 40, loc_a=100, loc_b=400, seed=3)
    m = 40
    prof = mpx(t, m)
    ref = stumpy.stump(t, m)[:, 0].astype(float)
    assert np.allclose(prof.mp, ref, atol=1e-5)


def test_matrix_profile_wrapper_returns_array(rng):
    t = rng.standard_normal(120)
    mp = matrix_profile(t, 12)
    assert mp.shape[0] == len(t) - 12 + 1
    assert np.all(np.isfinite(mp))


def test_mpx_index_points_to_true_neighbor(rng):
    t = datagen.planted_motif(400, 30, loc_a=60, loc_b=250, seed=11)
    m = 30
    prof = mpx(t, m)
    i = int(np.argmin(prof.mp))
    j = int(prof.mpi[i])
    # The top motif's two members should point at each other's neighborhood.
    assert min(abs(i - 60), abs(i - 250)) <= m
    assert min(abs(j - 60), abs(j - 250)) <= m
