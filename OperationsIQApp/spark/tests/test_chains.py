"""Tests for Time-Series Chains + directional (left/right) matrix profile."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone
from tsmp.momp.mpx import mpx_lr, LRMatrixProfile
from tsmp.parallel.decompose import parallel_lr_matrix_profile
from tsmp.chains.chains import unanchored_chain, top_k_chains, chain_drift, Chain


def _brute_lr(t: np.ndarray, m: int, minlag: int):
    """Reference directional nearest-neighbor indices via one MASS per window."""
    n = t.shape[0]
    pl = n - m + 1
    il = np.full(pl, -1, dtype=np.int64)
    ir = np.full(pl, -1, dtype=np.int64)
    for i in range(pl):
        dp = mass(t[i : i + m], t)[:pl]
        hi_l = i - minlag  # left neighbors are j in [0, i - minlag - 1]
        if hi_l > 0:
            il[i] = int(np.argmin(dp[:hi_l]))
        lo_r = i + minlag + 1  # right neighbors are j >= i + minlag + 1
        if lo_r < pl:
            ir[i] = lo_r + int(np.argmin(dp[lo_r:]))
    return il, ir


def test_mpx_lr_matches_brute_force():
    t = datagen.random_walk(300, seed=11)
    m = 24
    minlag = exclusion_zone(m)
    lr = mpx_lr(t, m, minlag)
    il_ref, ir_ref = _brute_lr(t, m, minlag)
    # Random-walk data has no correlation ties, so indices match exactly.
    np.testing.assert_array_equal(lr.il, il_ref)
    np.testing.assert_array_equal(lr.ir, ir_ref)


@pytest.mark.parametrize("n_blocks", [1, 2, 4, 7])
def test_parallel_lr_matches_monolithic(n_blocks):
    t = datagen.random_walk(400, seed=13)
    m = 32
    ref = mpx_lr(t, m)
    par = parallel_lr_matrix_profile(t, m, n_blocks=n_blocks)
    np.testing.assert_array_equal(par.il, ref.il)
    np.testing.assert_array_equal(par.ir, ref.ir)
    np.testing.assert_allclose(par.mp_left, ref.mp_left, atol=1e-9, rtol=0)
    np.testing.assert_allclose(par.mp_right, ref.mp_right, atol=1e-9, rtol=0)


def test_unanchored_chain_follows_drifting_pattern():
    m = 40
    period = 120
    series, locs = datagen.drifting_chain(1000, m, period, seed=3)
    lr = mpx_lr(series, m)
    chain = unanchored_chain(lr.il, lr.ir)
    # The recovered chain should be non-trivial and ascending in time.
    assert len(chain) >= 3
    assert chain == sorted(chain)
    # The chain tracks the recurring pattern: it may sit at a fixed phase offset
    # within each period, but its members must be spaced one period apart and hold
    # that phase consistently across the whole series.
    gaps = np.diff(chain)
    np.testing.assert_allclose(gaps, period, atol=2)
    phases = np.array(chain) % period
    assert phases.max() - phases.min() <= 2
    # It should span roughly as many recurrences as were planted.
    assert len(chain) >= len(locs) - 1


def test_top_k_chains_are_disjoint_and_ordered():
    m = 40
    series, _ = datagen.drifting_chain(1000, m, 120, seed=4)
    lr = mpx_lr(series, m)
    chains = top_k_chains(lr.il, lr.ir, k=3)
    assert 1 <= len(chains) <= 3
    assert all(isinstance(c, Chain) for c in chains)
    # Ordered longest-first.
    lengths = [c.length for c in chains]
    assert lengths == sorted(lengths, reverse=True)
    # Index-disjoint across chains.
    seen: set[int] = set()
    for c in chains:
        assert seen.isdisjoint(c.indices)
        seen.update(c.indices)


def test_chain_drift_detects_growing_amplitude():
    m = 40
    series, _ = datagen.drifting_chain(1000, m, 120, seed=6, drift=0.2)
    lr = mpx_lr(series, m)
    chain = unanchored_chain(lr.il, lr.ir)
    drift = chain_drift(series, chain, m)
    assert drift["links"] == len(chain)
    # Amplitude grows along the planted chain, so the fitted slope is positive.
    assert drift["amplitudeSlope"] > 0


def test_empty_indices_return_empty_chain():
    empty = np.zeros(0, dtype=np.int64)
    assert unanchored_chain(empty, empty) == []
    assert top_k_chains(empty, empty, k=2) == []
