"""Unit tests for the common primitives: moving statistics, PAA, and MASS."""
import numpy as np
import pytest

from tsmp.common.stats import moving_mean_std, muinvn, exclusion_zone
from tsmp.common.paa import paa
from tsmp.common.mass import mass, sliding_dot_product


def test_moving_mean_std_matches_bruteforce(rng):
    a = rng.standard_normal(200)
    w = 15
    mu, sig = moving_mean_std(a, w)
    for i in range(len(a) - w + 1):
        seg = a[i : i + w]
        assert mu[i] == pytest.approx(seg.mean(), abs=1e-9)
        assert sig[i] == pytest.approx(seg.std(), abs=1e-9)


def test_muinvn_is_inverse_norm(rng):
    a = rng.standard_normal(120)
    w = 10
    mu, siginv = muinvn(a, w)
    for i in range(len(a) - w + 1):
        norm = np.linalg.norm(a[i : i + w] - a[i : i + w].mean())
        assert siginv[i] == pytest.approx(1.0 / norm, rel=1e-9)


def test_muinvn_handles_constant_window():
    a = np.concatenate([np.full(10, 3.0), np.arange(10, dtype=float)])
    _, siginv = muinvn(a, 5)
    # The first window is constant -> inverse norm defined as 0.
    assert siginv[0] == 0.0


def test_exclusion_zone():
    assert exclusion_zone(8) == 2
    assert exclusion_zone(100) == 25


def test_paa_reference_behaviour():
    s = np.arange(12, dtype=float)
    out = paa(s, 3)  # segments of length 4
    assert np.allclose(out, [1.5, 5.5, 9.5])


def test_paa_truncates_trailing():
    s = np.arange(10, dtype=float)
    out = paa(s, 3)  # seg_len = 3, uses first 9 samples
    assert np.allclose(out, [1.0, 4.0, 7.0])


def test_sliding_dot_product(rng):
    q = rng.standard_normal(8)
    t = rng.standard_normal(50)
    qt = sliding_dot_product(q, t)
    assert qt.shape[0] == len(t) - len(q) + 1
    for i in range(qt.shape[0]):
        assert qt[i] == pytest.approx(np.dot(q, t[i : i + len(q)]), rel=1e-8, abs=1e-8)


def test_mass_matches_bruteforce_znorm(rng):
    t = rng.standard_normal(300)
    m = 20
    i = 40
    q = t[i : i + m]
    dp = mass(q, t)

    def znorm(x):
        return (x - x.mean()) / x.std()

    for j in (0, 10, 100, 250):
        expected = np.linalg.norm(znorm(q) - znorm(t[j : j + m]))
        assert dp[j] == pytest.approx(expected, abs=1e-6)
    # Distance to itself is ~0.
    assert dp[i] == pytest.approx(0.0, abs=1e-6)


def test_mass_matches_stumpy(rng):
    stumpy = pytest.importorskip("stumpy")
    t = rng.standard_normal(400)
    m = 25
    q = t[100 : 100 + m]
    dp = mass(q, t)
    dp_ref = stumpy.mass(q, t)
    assert np.allclose(dp, dp_ref, atol=1e-6)
