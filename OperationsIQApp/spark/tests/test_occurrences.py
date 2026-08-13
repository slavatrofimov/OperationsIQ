"""Tests for exact motif-occurrence extraction (tsmp.common.occurrences) and the
``motif_occurrences`` rows produced by the runner for every motif family."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.common.occurrences import (
    match_threshold,
    find_matches,
    occurrences_for_query,
    multidim_occurrences,
)
from tsmp.io.results import motif_occurrence_rows
from tsmp.jobs.runner import JobSpec, run_analysis


def _plant(n, m, locs, seed=0, noise=0.02, amplitude=3.0):
    """Random-walk background with an identical sinusoid planted at every loc in ``locs``."""
    rng = np.random.default_rng(seed)
    t = np.cumsum(rng.standard_normal(n))
    cycle = amplitude * np.sin(np.linspace(0, 2 * np.pi, m, endpoint=False))
    for loc in locs:
        seg = cycle + noise * rng.standard_normal(m)
        t[loc : loc + m] = t[loc] + (seg - seg[0])
    return t


# ------------------------------------------------------------- match_threshold

def test_threshold_is_factor_of_pair_distance():
    dp = np.array([0.0, 5.0, 2.0])
    assert match_threshold(dp, pair_dist=2.0, factor=1.5) == pytest.approx(3.0)


def test_threshold_falls_back_to_percentile_when_pair_zero():
    dp = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    thr = match_threshold(dp, pair_dist=0.0, factor=2.0, percentile=50.0)
    # median of finite positives (1..4) is 2.5 -> *2.0
    assert thr == pytest.approx(5.0)


def test_threshold_infinite_when_no_finite_positive():
    dp = np.array([0.0, np.inf, np.nan])
    assert match_threshold(dp, pair_dist=0.0) == float("inf")


# ------------------------------------------------------------- find_matches

def test_find_matches_seed_first_and_sorted_by_index():
    dp = np.array([0.5, 0.0, 9.0, 0.1, 9.0])
    out = find_matches(dp, threshold=1.0, exclusion_zone=1, seed_index=1)
    idx = [i for i, _ in out]
    assert idx == sorted(idx)
    assert 1 in idx  # seed included
    assert 2 not in idx and 4 not in idx  # over threshold excluded


def test_find_matches_seed_included_even_over_threshold():
    dp = np.array([5.0, 0.0, 0.0])
    out = find_matches(dp, threshold=0.5, exclusion_zone=1, seed_index=0)
    assert out[0] == (0, 5.0)  # seed accepted despite exceeding threshold


def test_find_matches_respects_exclusion_zone():
    dp = np.zeros(10)
    out = find_matches(dp, threshold=1.0, exclusion_zone=3, seed_index=0)
    idx = [i for i, _ in out]
    # no two accepted starts within 3 samples
    assert all(b - a >= 3 for a, b in zip(idx, idx[1:]))


def test_find_matches_respects_max_results():
    dp = np.zeros(50)
    out = find_matches(dp, threshold=1.0, exclusion_zone=1, seed_index=0, max_results=4)
    assert len(out) == 4


# ------------------------------------------------------- occurrences_for_query

def test_occurrences_for_query_recovers_all_planted_instances():
    m = 32
    locs = [50, 200, 400]
    t = _plant(700, m, locs)
    occ = occurrences_for_query(t[locs[0] : locs[0] + m], t, pair_dist=1.0, seed_index=locs[0])
    found = [i for i, _ in occ]
    # every planted location is recovered within a small tolerance
    for loc in locs:
        assert any(abs(f - loc) <= 2 for f in found), f"missed occurrence near {loc}"
    # seed distance is ~0
    assert occ[[i for i, _ in occ].index(min(found, key=lambda f: abs(f - locs[0])))][1] == pytest.approx(0.0, abs=1e-6)


def test_occurrences_for_query_empty_when_query_too_long():
    assert occurrences_for_query(np.zeros(10), np.zeros(5), pair_dist=1.0) == []


# ------------------------------------------------------- multidim_occurrences

def test_multidim_occurrences_recovers_joint_repeats():
    m = 30
    locs = [40, 180, 330]
    d0 = _plant(500, m, locs, seed=1)
    d1 = _plant(500, m, locs, seed=2)
    series = np.vstack([d0, d1])
    occ = multidim_occurrences(series, idx_a=locs[0], m=m, dims=[0, 1], pair_dist=1.0)
    found = [i for i, _ in occ]
    for loc in locs:
        assert any(abs(f - loc) <= 2 for f in found), f"missed joint occurrence near {loc}"


def test_multidim_occurrences_ignores_invalid_dims():
    series = np.zeros((2, 100))
    assert multidim_occurrences(series, idx_a=0, m=10, dims=[5, 6], pair_dist=1.0) == []


# ------------------------------------------------------- motif_occurrence_rows

def test_motif_occurrence_rows_shape_and_series_id():
    rows = motif_occurrence_rows("job-1", rank=2, matches=[(10, 0.0), (55, 0.4)], sub_len=8, series_id=1)
    assert [r["occurrence"] for r in rows] == [0, 1]
    assert all(r["jobId"] == "job-1" and r["rank"] == 2 and r["subLen"] == 8 for r in rows)
    assert all(r["seriesId"] == 1 for r in rows)
    assert rows[0]["idx"] == 10 and rows[0]["dist"] == pytest.approx(0.0)


def test_motif_occurrence_rows_omit_series_id_when_none():
    rows = motif_occurrence_rows("job-1", rank=1, matches=[(0, 0.0)], sub_len=4)
    assert "seriesId" not in rows[0]


# ------------------------------------------------------- runner integration

def test_self_join_motif_emits_occurrences_for_all_instances():
    m = 32
    locs = [60, 240, 430]
    t = _plant(700, m, locs, seed=5)
    spec = JobSpec(job_id="occ-self", type="MOTIF_MOMP", m=m, k=1)
    out = run_analysis(spec, t)
    assert out.motif_occurrences, "expected occurrence rows"
    assert all(r["rank"] == 1 and r["subLen"] == m for r in out.motif_occurrences)
    assert all("seriesId" not in r for r in out.motif_occurrences)
    found = [r["idx"] for r in out.motif_occurrences]
    for loc in locs:
        assert any(abs(f - loc) <= 3 for f in found), f"missed occurrence near {loc}"


def test_ab_motif_emits_occurrences_in_both_series():
    m = 32
    a = _plant(500, m, [40, 260], seed=11)
    b = _plant(500, m, [120, 360], seed=12)
    spec = JobSpec(job_id="occ-ab", type="AB_MOTIF", m=m, k=1)
    out = run_analysis(spec, a, series_b=b)
    assert out.motif_occurrences
    series_ids = {r["seriesId"] for r in out.motif_occurrences}
    assert series_ids == {0, 1}, "occurrences reported in both A and B"


def test_multidim_motif_emits_occurrences_single_clock():
    m = 30
    locs = [50, 220, 380]
    d0 = _plant(500, m, locs, seed=21)
    d1 = _plant(500, m, locs, seed=22)
    series = np.vstack([d0, d1])
    spec = JobSpec(job_id="occ-md", type="MULTIDIM_MOTIF", m=m, k=1, n_dims=2)
    out = run_analysis(spec, series, series_list=[d0, d1])
    assert out.motif_occurrences
    assert all("seriesId" not in r for r in out.motif_occurrences)
    found = [r["idx"] for r in out.motif_occurrences]
    for loc in locs:
        assert any(abs(f - loc) <= 3 for f in found), f"missed md occurrence near {loc}"
