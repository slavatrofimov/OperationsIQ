"""MOMP motif-discovery tests: exactness vs the full matrix profile + anytime behaviour."""
import numpy as np
import pytest

from tsmp.momp.mpx import mpx
from tsmp.momp.momp import momp, momp_anytime
from tsmp import datagen


def _znorm_dist(t, m, a, b):
    def zn(x):
        return (x - x.mean()) / x.std()

    return float(np.linalg.norm(zn(t[a : a + m]) - zn(t[b : b + m])))


@pytest.mark.parametrize("m", [16, 24, 40])
def test_momp_distance_equals_exact_mp_minimum(m):
    t = datagen.planted_motif(600, m, loc_a=90, loc_b=380, seed=5)
    res = momp(t, m)
    exact_min = float(mpx(t, m).mp.min())
    assert res.distance == pytest.approx(exact_min, abs=1e-6)


def test_momp_returned_pair_has_reported_distance():
    m = 32
    t = datagen.planted_motif(700, m, loc_a=120, loc_b=500, seed=9)
    res = momp(t, m)
    a, b = res.pair
    assert _znorm_dist(t, m, a, b) == pytest.approx(res.distance, abs=1e-6)


def test_momp_recovers_planted_motif():
    m = 40
    t = datagen.planted_motif(800, m, loc_a=150, loc_b=560, seed=1, noise=0.02)
    res = momp(t, m)
    a, b = res.pair
    near = {min(abs(x - 150), abs(x - 560)) for x in (a, b)}
    assert max(near) <= m  # both members land on a planted location


def test_momp_matches_stumpy_motif():
    stumpy = pytest.importorskip("stumpy")
    m = 30
    t = datagen.planted_motif(600, m, loc_a=100, loc_b=420, seed=2)
    res = momp(t, m)
    ref_min = float(stumpy.stump(t, m)[:, 0].astype(float).min())
    assert res.distance == pytest.approx(ref_min, abs=1e-5)


def test_momp_anytime_is_monotonic_and_converges():
    m = 32
    t = datagen.planted_motif(900, m, loc_a=200, loc_b=650, seed=4)
    levels = list(momp_anytime(t, m))
    bsfs = [lv.bsf for lv in levels]
    # Best-so-far never gets worse as the algorithm refines.
    assert all(b2 <= b1 + 1e-9 for b1, b2 in zip(bsfs, bsfs[1:]))
    # The final level is exact and matches the full matrix profile.
    assert levels[-1].exact
    assert levels[-1].bsf == pytest.approx(float(mpx(t, m).mp.min()), abs=1e-6)
    # Pruning actually removed candidates before the exact pass (on cooperative data).
    assert levels[-1].pruned_fraction > 0.0


def test_momp_pruning_never_discards_true_motif():
    # Even with an aggressive schedule the exact answer is preserved.
    m = 20
    t = datagen.planted_motif(500, m, loc_a=70, loc_b=300, seed=8)
    res = momp(t, m)
    assert res.distance == pytest.approx(float(mpx(t, m).mp.min()), abs=1e-6)
