"""P2 tests for the multidimensional (mSTAMP) matrix profile, extractors, and runner dispatch."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.common.mass import mass
from tsmp.common.stats import exclusion_zone
from tsmp.mstamp.mstamp import (
    mstamp,
    mstamp_motifs,
    mstamp_discords,
    participating_dims,
    MStampProfile,
)
from tsmp.jobs.runner import JobSpec, ProgressEvent, run_analysis
from tsmp.parallel.decompose import threaded_mapper


def _record_sink():
    events: list[ProgressEvent] = []
    return events, events.append


def _multi_series(n: int, seeds, scale: float = 1.0) -> np.ndarray:
    """Stack independent random walks into a (d, n) aligned matrix."""
    return np.vstack([datagen.random_walk(n, seed=s, scale=scale) for s in seeds])


def _brute_mstamp(a: np.ndarray, m: int, excl: int) -> MStampProfile:
    """Reference multidimensional profile via explicit per-dim distance matrices."""
    a = np.asarray(a, dtype=np.float64)
    d, n = a.shape
    plen = n - m + 1
    D = np.empty((d, plen, plen), dtype=np.float64)
    for dim in range(d):
        for i in range(plen):
            D[dim, i] = mass(a[dim, i : i + m], a[dim])
    ks = np.arange(1, d + 1, dtype=np.float64)[:, None]
    mp = np.full((d, plen), np.inf)
    mpi = np.full((d, plen), -1, dtype=np.int64)
    for i in range(plen):
        col = D[:, i, :].copy()
        lo, hi = max(0, i - excl), min(plen, i + excl + 1)
        col[:, lo:hi] = np.inf
        ksort = np.sort(col, axis=0)
        kdist = np.cumsum(ksort, axis=0) / ks
        j = np.argmin(kdist, axis=1)
        mp[:, i] = kdist[np.arange(d), j]
        mpi[:, i] = j
    return MStampProfile(mp=mp, mpi=mpi, m=m, minlag=excl)


# ------------------------------------------------------------- core profile

def test_mstamp_matches_brute_force():
    a = _multi_series(160, (1, 2, 3))
    m = 20
    excl = exclusion_zone(m)
    got = mstamp(a, m)
    ref = _brute_mstamp(a, m, excl)
    assert got.mp.shape == ref.mp.shape == (3, 160 - m + 1)
    np.testing.assert_allclose(got.mp, ref.mp, atol=1e-8)
    assert np.array_equal(got.mpi, ref.mpi)


def test_mstamp_parallel_equivalence():
    a = _multi_series(240, (5, 6, 7, 8))
    m = 24
    serial = mstamp(a, m, n_blocks=1)
    parallel = mstamp(a, m, n_blocks=6, mapper=threaded_mapper(4))
    np.testing.assert_allclose(serial.mp, parallel.mp, atol=1e-9)
    assert np.array_equal(serial.mpi, parallel.mpi)


def test_mstamp_single_channel_matches_selfjoin_shape():
    a = _multi_series(120, (9,))
    m = 16
    prof = mstamp(a, m)
    assert prof.mp.shape[0] == 1
    assert prof.mp.shape[1] == 120 - m + 1


# ------------------------------------------------------------- motif

def test_mstamp_motif_recovers_participating_dims():
    m = 24
    # Plant the same shape into channels 0 and 2 (NOT 1) at two locations.
    a = _multi_series(320, (10, 11, 12))
    shape = 6.0 * np.sin(np.linspace(0, 4 * np.pi, m))
    for loc in (60, 200):
        a[0, loc : loc + m] += shape
        a[2, loc : loc + m] += shape
    prof = mstamp(a, m)
    motifs = mstamp_motifs(prof, a, k=1, n_dims=2)
    assert len(motifs) == 1
    mo = motifs[0]
    assert sorted(mo.dims) == [0, 2]
    assert min(abs(mo.idx_a - 60), abs(mo.idx_a - 200)) <= m
    assert min(abs(mo.idx_b - 60), abs(mo.idx_b - 200)) <= m
    assert mo.n_dims == 2 and mo.dist >= 0.0


def test_mstamp_motifs_spaced_and_ordered():
    a = _multi_series(400, (21, 22, 23))
    m = 25
    prof = mstamp(a, m)
    motifs = mstamp_motifs(prof, a, k=3, n_dims=3)
    assert len(motifs) == 3
    dists = [mo.dist for mo in motifs]
    assert dists == sorted(dists)
    excl = exclusion_zone(m)
    for i in range(len(motifs)):
        for j in range(i + 1, len(motifs)):
            assert abs(motifs[i].idx_a - motifs[j].idx_a) >= excl


def test_participating_dims_orders_by_agreement():
    m = 20
    a = _multi_series(200, (31, 32, 33))
    shape = 5.0 * np.sin(np.linspace(0, 6 * np.pi, m))
    a[1, 40 : 40 + m] += shape
    a[1, 140 : 140 + m] += shape
    dims, dists = participating_dims(a, m, 40, 140, n_dims=1)
    assert dims == [1]
    assert dists[0] >= 0.0


# ------------------------------------------------------------- discord

def test_mstamp_discord_finds_multi_sensor_novelty():
    m = 30
    a = _multi_series(500, (41, 42, 43))
    burst = 12.0 * np.sin(np.linspace(0, 10 * np.pi, m))
    loc = 250
    a[0, loc : loc + m] += burst
    a[1, loc : loc + m] += burst
    prof = mstamp(a, m)
    ds = mstamp_discords(prof, a, k=1, n_dims=2)
    assert len(ds) == 1
    assert abs(ds[0].index - loc) <= m
    assert ds[0].n_dims == 2


# ------------------------------------------------------------- runner dispatch

def test_run_analysis_multidim_motif():
    m = 24
    a = _multi_series(320, (10, 11, 12))
    shape = 6.0 * np.sin(np.linspace(0, 4 * np.pi, m))
    for loc in (60, 200):
        a[0, loc : loc + m] += shape
        a[2, loc : loc + m] += shape
    spec = JobSpec(job_id="j-md-motif", type="MULTIDIM_MOTIF", m=m, k=1, n_dims=2)
    events, sink = _record_sink()
    out = run_analysis(spec, np.empty(0), sink=sink, series_list=list(a))

    assert len(out.motif_pairs) == 1
    row = out.motif_pairs[0]
    assert row["numDims"] == 2
    assert set(row["dims"].split(",")) == {"0", "2"}
    assert row["subLen"] == m
    # md_dimensions carries one row per participating channel.
    dims = {r["seriesId"] for r in out.md_dimensions if r["resultKind"] == "MOTIF"}
    assert dims == {0, 2}
    # overview built for every channel.
    assert {r.get("seriesId") for r in out.overview} == {0, 1, 2}
    assert out.summary["multiDim"] is True
    assert events[-1].pct == 100.0


def test_run_analysis_multidim_discord():
    m = 30
    a = _multi_series(500, (41, 42, 43))
    burst = 12.0 * np.sin(np.linspace(0, 10 * np.pi, m))
    loc = 250
    a[0, loc : loc + m] += burst
    a[1, loc : loc + m] += burst
    spec = JobSpec(job_id="j-md-disc", type="MULTIDIM_DISCORD", m=m, k=1, n_dims=2)
    out = run_analysis(spec, np.empty(0), series_list=list(a))
    assert len(out.discords) == 1
    assert abs(out.discords[0]["idx"] - loc) <= m
    assert out.discords[0]["numDims"] == 2
    assert any(r["resultKind"] == "DISCORD" for r in out.md_dimensions)


def test_run_analysis_multidim_segmentation():
    m = 20
    # Two regimes: a fast oscillation then a slow one, in every channel (aligned change).
    def regime_channel(seed):
        rng = np.random.default_rng(seed)
        fast = np.sin(np.linspace(0, 40 * np.pi, 200)) + 0.1 * rng.standard_normal(200)
        slow = np.sin(np.linspace(0, 6 * np.pi, 200)) + 0.1 * rng.standard_normal(200)
        return np.concatenate([fast, slow])

    a = np.vstack([regime_channel(s) for s in (51, 52, 53)])
    spec = JobSpec(job_id="j-md-seg", type="MULTIDIM_SEGMENTATION", m=m, k=1)
    out = run_analysis(spec, np.empty(0), series_list=list(a))
    assert len(out.arc_curve) == a.shape[1] - m + 1
    assert len(out.segments) >= 1
    # The strongest boundary should land near the regime change at index 200.
    assert abs(out.segments[0]["boundaryIdx"] - 200) <= 3 * m
    assert out.summary["multiDim"] is True


def test_run_analysis_multidim_requires_series_list():
    spec = JobSpec(job_id="j-md-missing", type="MULTIDIM_MOTIF", m=20)
    with pytest.raises(ValueError, match="series_list"):
        run_analysis(spec, np.empty(0), series_list=[datagen.random_walk(100, seed=1)])
