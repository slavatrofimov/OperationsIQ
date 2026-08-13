"""P3 tests for the fleet consensus motif (Ostinato), extractors, and runner dispatch."""
import numpy as np
import pytest

from tsmp import datagen
from tsmp.common.mass import mass
from tsmp.ostinato.ostinato import ostinato, ConsensusMotif
from tsmp.jobs.runner import JobSpec, ProgressEvent, run_analysis
from tsmp.parallel.decompose import threaded_mapper


def _record_sink():
    events: list[ProgressEvent] = []
    return events, events.append


def _fleet(lengths, seeds, scale: float = 1.0) -> list[np.ndarray]:
    """A fleet of independent random walks (may differ in length)."""
    return [datagen.random_walk(n, seed=s, scale=scale) for n, s in zip(lengths, seeds)]


def _plant(series: np.ndarray, loc: int, shape: np.ndarray) -> np.ndarray:
    out = series.copy()
    out[loc : loc + shape.shape[0]] += shape
    return out


def _brute_ostinato(series_list, m: int, min_count: int):
    """Reference consensus by scanning every candidate window explicitly.

    Iterates candidates in (series, index) order and keeps the first with a strictly
    smaller radius, matching the parallel implementation's tie-break (lowest series then
    index). Returns ``(central_series, central_index, radius, members)``.
    """
    n = len(series_list)
    best = None
    best_radius = np.inf
    for s in range(n):
        plen_s = len(series_list[s]) - m + 1
        for i in range(plen_s):
            q = series_list[s][i : i + m]
            dists = np.empty(n)
            idxs = np.empty(n, dtype=np.int64)
            dists[s] = 0.0
            idxs[s] = i
            for sp in range(n):
                if sp == s:
                    continue
                dp = mass(q, series_list[sp])
                j = int(np.argmin(dp))
                dists[sp] = dp[j]
                idxs[sp] = j
            radius = float(np.sort(dists)[min_count - 1])
            if radius < best_radius:
                best_radius = radius
                best = (s, i, radius, list(zip(idxs.tolist(), dists.tolist())))
    return best


# ------------------------------------------------------------- core algorithm

def test_ostinato_matches_brute_force():
    fleet = _fleet((160, 170, 150), (1, 2, 3))
    m = 20
    got = ostinato(fleet, m)
    ref = _brute_ostinato(fleet, m, min_count=3)
    assert got is not None and ref is not None
    assert got.central_series == ref[0]
    assert got.central_index == ref[1]
    assert got.radius == pytest.approx(ref[2], abs=1e-9)
    for member, (idx, dist) in zip(got.members, ref[3]):
        assert member.index == idx
        assert member.distance == pytest.approx(dist, abs=1e-9)


def test_ostinato_parallel_equivalence():
    fleet = _fleet((200, 210, 190, 205), (5, 6, 7, 8))
    m = 24
    serial = ostinato(fleet, m, n_blocks=1)
    parallel = ostinato(fleet, m, n_blocks=8, mapper=threaded_mapper(4))
    assert serial is not None and parallel is not None
    assert serial.central_series == parallel.central_series
    assert serial.central_index == parallel.central_index
    assert serial.radius == pytest.approx(parallel.radius, abs=1e-9)
    assert [mm.index for mm in serial.members] == [mm.index for mm in parallel.members]


def test_ostinato_recovers_planted_shape_all_n():
    m = 30
    shape = 8.0 * np.sin(np.linspace(0, 4 * np.pi, m))
    fleet = _fleet((300, 320, 280), (11, 12, 13))
    locs = (40, 120, 90)
    fleet = [_plant(s, loc, shape) for s, loc in zip(fleet, locs)]
    motif = ostinato(fleet, m)
    assert motif is not None
    assert motif.min_count == 3
    # Every series' member should land on (or very near) its planted location.
    for member, loc in zip(motif.members, locs):
        assert abs(member.index - loc) <= m
    # The central series' own member is the reference (distance 0).
    central = motif.members[motif.central_series]
    assert central.is_central and central.distance == pytest.approx(0.0)


def test_ostinato_partial_consensus_min_count():
    m = 30
    shape = 9.0 * np.sin(np.linspace(0, 6 * np.pi, m))
    # Plant the shared shape in only 2 of the 3 series (series 0 and 2, NOT 1).
    fleet = _fleet((300, 300, 300), (21, 22, 23))
    fleet[0] = _plant(fleet[0], 50, shape)
    fleet[2] = _plant(fleet[2], 150, shape)

    strict = ostinato(fleet, m, min_count=3)
    partial = ostinato(fleet, m, min_count=2)
    assert strict is not None and partial is not None
    # Requiring only 2 of 3 finds a much tighter consensus than requiring all 3.
    assert partial.radius < strict.radius
    assert partial.min_count == 2
    # The partial consensus should be the planted shape (central in series 0 or 2).
    assert partial.central_series in (0, 2)


def test_ostinato_requires_two_series():
    with pytest.raises(ValueError, match="at least 2 series"):
        ostinato([datagen.random_walk(100, seed=1)], m=20)


def test_ostinato_deterministic_across_blocks():
    fleet = _fleet((180, 180, 180), (31, 32, 33))
    m = 22
    results = [ostinato(fleet, m, n_blocks=b, mapper=threaded_mapper(3)) for b in (1, 2, 3, 5, 7)]
    radii = [r.radius for r in results]
    idxs = [(r.central_series, r.central_index) for r in results]
    assert all(x == pytest.approx(radii[0], abs=1e-9) for x in radii)
    assert all(x == idxs[0] for x in idxs)


# ------------------------------------------------------------- runner dispatch

def test_run_analysis_consensus_motif():
    m = 30
    shape = 8.0 * np.sin(np.linspace(0, 4 * np.pi, m))
    fleet = _fleet((300, 320, 280), (11, 12, 13))
    locs = (40, 120, 90)
    fleet = [_plant(s, loc, shape) for s, loc in zip(fleet, locs)]
    spec = JobSpec(job_id="j-consensus", type="CONSENSUS_MOTIF", m=m)
    events, sink = _record_sink()
    out = run_analysis(spec, np.empty(0), sink=sink, series_list=fleet)

    # One consensus_members row per fleet series, exactly one central.
    assert len(out.consensus_members) == 3
    assert sum(1 for r in out.consensus_members if r["isCentral"]) == 1
    by_series = {r["seriesId"]: r for r in out.consensus_members}
    for s, loc in enumerate(locs):
        assert abs(by_series[s]["idx"] - loc) <= m
    # Overview built per series.
    assert {r.get("seriesId") for r in out.overview} == {0, 1, 2}
    assert out.summary["consensus"] is True
    assert out.summary["numSeries"] == 3
    assert events[-1].pct == 100.0


def test_run_analysis_consensus_min_count_in_summary():
    m = 24
    fleet = _fleet((200, 200, 200), (61, 62, 63))
    spec = JobSpec(job_id="j-consensus-mc", type="CONSENSUS_MOTIF", m=m, min_count=2)
    out = run_analysis(spec, np.empty(0), series_list=fleet)
    assert out.summary["minCount"] == 2
    assert len(out.consensus_members) == 3


def test_run_analysis_consensus_requires_series_list():
    spec = JobSpec(job_id="j-consensus-missing", type="CONSENSUS_MOTIF", m=20)
    with pytest.raises(ValueError, match="series_list"):
        run_analysis(spec, np.empty(0), series_list=[datagen.random_walk(100, seed=1)])
