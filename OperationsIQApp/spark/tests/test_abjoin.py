"""P1 tests for the AB-join (two-series) matrix profile, extractors, and runner dispatch."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone
from tsmp.abjoin.abjoin import (
    ab_matrix_profile,
    ab_motifs,
    ab_discords,
    ABMatrixProfile,
)
from tsmp.jobs.runner import JobSpec, ProgressEvent, run_analysis
from tsmp.parallel.decompose import threaded_mapper


def _record_sink():
    events: list[ProgressEvent] = []
    return events, events.append


def _brute_ab_profile(a: np.ndarray, b: np.ndarray, m: int) -> ABMatrixProfile:
    """Reference AB profile via an explicit z-normalized distance matrix (MASS per row)."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    plen_a = len(a) - m + 1
    plen_b = len(b) - m + 1
    D = np.empty((plen_a, plen_b), dtype=np.float64)
    for i in range(plen_a):
        D[i, :] = mass(a[i : i + m], b)
    pab = D.min(axis=1)
    ipab = D.argmin(axis=1).astype(np.int64)
    pba = D.min(axis=0)
    ipba = D.argmin(axis=0).astype(np.int64)
    return ABMatrixProfile(pab=pab, ipab=ipab, pba=pba, ipba=ipba, m=m)


# ------------------------------------------------------------- core profile

def test_ab_profile_matches_brute_force():
    a = datagen.random_walk(200, seed=1)
    b = datagen.random_walk(240, seed=2)
    m = 24
    got = ab_matrix_profile(a, b, m)
    ref = _brute_ab_profile(a, b, m)

    assert got.pab.shape == ref.pab.shape
    assert got.pba.shape == ref.pba.shape
    np.testing.assert_allclose(got.pab, ref.pab, atol=1e-8)
    np.testing.assert_allclose(got.pba, ref.pba, atol=1e-8)
    # Nearest-neighbour indices agree wherever the min is unambiguous.
    assert np.array_equal(got.ipab, ref.ipab)
    assert np.array_equal(got.ipba, ref.ipba)


def test_ab_profile_parallel_equivalence():
    a = datagen.random_walk(300, seed=5)
    b = datagen.random_walk(260, seed=6)
    m = 30
    serial = ab_matrix_profile(a, b, m, n_blocks=1)
    parallel = ab_matrix_profile(a, b, m, n_blocks=7, mapper=threaded_mapper(4))
    np.testing.assert_allclose(serial.pab, parallel.pab, atol=1e-9)
    np.testing.assert_allclose(serial.pba, parallel.pba, atol=1e-9)
    assert np.array_equal(serial.ipab, parallel.ipab)
    assert np.array_equal(serial.ipba, parallel.ipba)


def test_ab_profile_differing_lengths():
    a = datagen.random_walk(150, seed=3)
    b = datagen.random_walk(400, seed=4)
    m = 20
    p = ab_matrix_profile(a, b, m)
    assert p.pab.shape[0] == len(a) - m + 1
    assert p.pba.shape[0] == len(b) - m + 1


# ------------------------------------------------------------- AB motif

def test_ab_motif_recovers_shared_shape():
    m = 40
    # Plant the same sinusoidal shape into two independent random walks at known spots.
    a = datagen.planted_motif(500, m, loc_a=80, loc_b=300, seed=11)
    b = datagen.planted_motif(520, m, loc_a=150, loc_b=380, seed=12)
    p = ab_matrix_profile(a, b, m)
    motifs = ab_motifs(p, k=1)
    assert len(motifs) == 1
    top = motifs[0]
    # The closest cross pair should land on one planted location in each series.
    assert top.idx_a in (80, 300) or min(abs(top.idx_a - 80), abs(top.idx_a - 300)) <= m
    assert top.idx_b in (150, 380) or min(abs(top.idx_b - 150), abs(top.idx_b - 380)) <= m
    assert top.dist >= 0.0


def test_ab_motifs_are_spaced_and_ordered():
    a = datagen.random_walk(400, seed=21)
    b = datagen.random_walk(400, seed=22)
    m = 25
    p = ab_matrix_profile(a, b, m)
    motifs = ab_motifs(p, k=3)
    assert len(motifs) == 3
    dists = [mo.dist for mo in motifs]
    assert dists == sorted(dists)
    # A-endpoints spaced by at least the exclusion zone.
    excl = exclusion_zone(m)
    for i in range(len(motifs)):
        for j in range(i + 1, len(motifs)):
            assert abs(motifs[i].idx_a - motifs[j].idx_a) >= excl


# ------------------------------------------------------------- AB discord

def test_ab_discord_finds_novelty_in_b():
    m = 40
    # Baseline a and b share the same background; b gets a planted burst absent from a.
    a = datagen.random_walk(600, seed=31)
    b = datagen.random_walk(600, seed=31).copy()
    burst_loc = 300
    b[burst_loc : burst_loc + m] += 12.0 * np.sin(np.linspace(0, 12 * np.pi, m))
    p = ab_matrix_profile(a, b, m)
    ds = ab_discords(p, k=1, target="b")
    assert len(ds) == 1
    assert abs(ds[0].index - burst_loc) <= m


# ------------------------------------------------------------- runner dispatch

def test_run_analysis_ab_motif():
    m = 40
    a = datagen.planted_motif(500, m, loc_a=80, loc_b=300, seed=41)
    b = datagen.planted_motif(500, m, loc_a=120, loc_b=350, seed=42)
    spec = JobSpec(job_id="j-ab-motif", type="AB_MOTIF", m=m, k=2, include_profile=True)
    events, sink = _record_sink()
    out = run_analysis(spec, a, sink=sink, series_b=b)

    assert len(out.motif_pairs) == 2
    row = out.motif_pairs[0]
    assert row["seriesA"] == 0 and row["seriesB"] == 1
    assert row["subLen"] == m
    assert out.summary["abMode"] is True
    # include_profile emits both directions of the mp lane.
    assert any(r["seriesId"] == 0 for r in out.mp_result)
    assert any(r["seriesId"] == 1 for r in out.mp_result)
    # overview built for both series.
    assert {r.get("seriesId") for r in out.overview} == {0, 1}
    assert events[-1].pct == 100.0


def test_run_analysis_ab_discord():
    m = 40
    a = datagen.random_walk(600, seed=51)
    b = datagen.random_walk(600, seed=51).copy()
    burst_loc = 320
    b[burst_loc : burst_loc + m] += 12.0 * np.sin(np.linspace(0, 12 * np.pi, m))
    spec = JobSpec(job_id="j-ab-disc", type="AB_DISCORD", m=m, k=1, ab_target="b")
    out = run_analysis(spec, a, series_b=b)

    assert len(out.discords) == 1
    row = out.discords[0]
    assert row["seriesId"] == 1
    assert abs(row["idx"] - burst_loc) <= m
    assert out.summary["target"] == "b"


def test_run_analysis_ab_requires_series_b():
    spec = JobSpec(job_id="j-ab-missing", type="AB_MOTIF", m=20)
    with pytest.raises(ValueError, match="series_b"):
        run_analysis(spec, datagen.random_walk(100, seed=1))
