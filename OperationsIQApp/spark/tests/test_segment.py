"""Tests for FLUSS/FLOSS semantic segmentation (tsmp.segment.fluss)."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.momp.mpx import mpx
from tsmp.segment.fluss import (
    arc_counts,
    corrected_arc_curve,
    find_regimes,
    RegimeBoundary,
)


def test_arc_counts_simple_arcs():
    # Three arcs to the same target: 0->4, 1->4, 2->4 (no mutual duplicates).
    mpi = np.array([4, 4, 4, -1, -1], dtype=np.int64)
    ac = arc_counts(mpi)
    assert ac.shape == (5,)
    # Location 3 is crossed by all three arcs (each spans up to index 4 inclusive).
    assert ac[3] == 3
    # Location 0 is never crossed (arcs are exclusive of their left endpoint).
    assert ac[0] == 0


def test_arc_counts_counts_every_pointer():
    # FLUSS counts one arc per subsequence pointer, so mutual nearest neighbors
    # (i->j and j->i) contribute two arcs over the same span — by design.
    mpi = np.array([2, -1, 0], dtype=np.int64)  # 0<->2 mutual
    ac = arc_counts(mpi)
    assert ac[1] == 2


def test_corrected_arc_curve_is_bounded_0_1():
    t = datagen.random_walk(400, seed=7)
    prof = mpx(t, 32)
    cac = corrected_arc_curve(prof.mpi, exclusion=32)
    assert cac.shape == prof.mpi.shape
    assert np.all(cac >= 0.0) and np.all(cac <= 1.0)


def test_cac_dips_at_regime_boundary():
    seg = 300
    m = 32
    series, boundary = datagen.regime_series(seg, cycles_a=4, cycles_b=16, seed=2)
    prof = mpx(series, m)
    cac = corrected_arc_curve(prof.mpi, exclusion=m)
    # The global minimum of the CAC should be near the true regime boundary.
    min_idx = int(np.argmin(cac))
    assert abs(min_idx - boundary) <= 3 * m


def test_find_regimes_recovers_boundary():
    seg = 300
    m = 32
    series, boundary = datagen.regime_series(seg, cycles_a=4, cycles_b=16, seed=5)
    prof = mpx(series, m)
    boundaries = find_regimes(prof.mpi, num_regimes=1, exclusion=m)
    assert len(boundaries) == 1
    b = boundaries[0]
    assert isinstance(b, RegimeBoundary)
    assert abs(b.index - boundary) <= 3 * m
    assert 0.0 <= b.cac <= 1.0


def test_find_regimes_respects_exclusion_spacing():
    seg = 300
    m = 32
    series, _ = datagen.regime_series(seg, cycles_a=4, cycles_b=16, seed=9)
    prof = mpx(series, m)
    boundaries = find_regimes(prof.mpi, num_regimes=3, exclusion=m)
    idxs = sorted(b.index for b in boundaries)
    for a, b in zip(idxs, idxs[1:]):
        assert b - a >= m  # boundaries kept at least one exclusion zone apart


def test_find_regimes_zero_request_returns_empty():
    prof = mpx(datagen.random_walk(200, seed=1), 16)
    assert find_regimes(prof.mpi, num_regimes=0, exclusion=16) == []
