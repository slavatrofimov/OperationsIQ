"""Discord-discovery tests: exact discords + DAMP early-abandon parity."""
import numpy as np
import pytest

from tsmp.momp.mpx import mpx
from tsmp.damp.damp import discords, damp
from tsmp import datagen


def test_discords_top1_is_mp_argmax(rng):
    t = datagen.random_walk(400, seed=6)
    m = 24
    prof = mpx(t, m)
    expected = int(np.argmax(prof.mp))
    res = discords(t, m, k=1)
    assert res[0].index == expected
    assert res[0].nn_distance == pytest.approx(float(prof.mp[expected]), abs=1e-6)


def test_discords_recovers_planted_anomaly():
    m = 50
    t = datagen.planted_discord(1000, m, loc=600, seed=12)
    res = discords(t, m, k=1)
    assert abs(res[0].index - 600) <= m


def test_damp_matches_exact_discords():
    m = 30
    t = datagen.random_walk(500, seed=13)
    exact = discords(t, m, k=3)
    approx = damp(t, m, k=3)
    assert [d.index for d in approx] == [d.index for d in exact]
    for a, e in zip(approx, exact):
        assert a.nn_distance == pytest.approx(e.nn_distance, abs=1e-6)


def test_damp_top1_matches_stumpy():
    stumpy = pytest.importorskip("stumpy")
    m = 28
    t = datagen.random_walk(450, seed=14)
    ref = int(np.argmax(stumpy.stump(t, m)[:, 0].astype(float)))
    res = damp(t, m, k=1)
    assert res[0].index == ref


def test_damp_early_abandon_agrees_with_bruteforce_planted():
    m = 40
    t = datagen.planted_discord(800, m, loc=500, seed=15)
    exact = discords(t, m, k=1)[0]
    approx = damp(t, m, k=1)[0]
    assert approx.index == exact.index
    assert approx.nn_distance == pytest.approx(exact.nn_distance, abs=1e-6)
