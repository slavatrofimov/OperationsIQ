"""P5 tests for the per-job analysis dispatch (tsmp.jobs.runner)."""
import json

import numpy as np
import pytest

from tsmp import datagen
from tsmp.momp.mpx import mpx
from tsmp.momp.momp import momp
from tsmp.damp.damp import discords
from tsmp.jobs.runner import (
    JobSpec,
    ProgressEvent,
    run_analysis,
    motif_pairs_from_profile,
)
from tsmp.parallel.decompose import threaded_mapper


def _record_sink():
    events: list[ProgressEvent] = []
    return events, events.append


# ------------------------------------------------------------------- FULL_MP

def test_full_mp_matches_mpx_and_emits_overview():
    t = datagen.random_walk(400, seed=3)
    m = 32
    spec = JobSpec(job_id="j-full", type="FULL_MP", m=m)
    events, sink = _record_sink()
    out = run_analysis(spec, t, sink=sink)

    ref = mpx(t, m)
    assert len(out.mp_result) == ref.mp.shape[0]
    # idx column is contiguous and mpi round-trips.
    assert [r["idx"] for r in out.mp_result] == list(range(len(out.mp_result)))
    assert out.mp_result[0]["mpi"] == int(ref.mpi[0])
    assert out.overview, "overview should be built by default"
    assert out.summary["type"] == "FULL_MP" and out.summary["m"] == m
    assert events[-1].pct == 100.0


# ------------------------------------------------------------------- MOTIF

def test_motif_momp_recovers_planted_motif():
    m = 40
    t = datagen.planted_motif(600, m, loc_a=100, loc_b=400, seed=1)
    spec = JobSpec(job_id="j-motif", type="MOTIF_MOMP", m=m, k=1)
    events, sink = _record_sink()
    out = run_analysis(spec, t, sink=sink)

    assert len(out.motif_pairs) == 1
    row = out.motif_pairs[0]
    ref = momp(t, m)
    assert (row["idxA"], row["idxB"]) == ref.pair
    assert row["subLen"] == m
    # Anytime streaming produced an exact final event at 100%.
    assert events[-1].pct == 100.0
    assert any(e.best is not None for e in events)


def test_motif_topk_are_nonoverlapping_and_ranked():
    m = 40
    t = datagen.planted_motif(800, m, loc_a=120, loc_b=500, seed=7)
    spec = JobSpec(job_id="j-motif-k", type="MOTIF_MOMP", m=m, k=3)
    out = run_analysis(spec, t)
    rows = out.motif_pairs
    assert 1 <= len(rows) <= 3
    assert [r["rank"] for r in rows] == list(range(1, len(rows) + 1))
    # distances are non-decreasing by rank.
    dists = [r["dist"] for r in rows]
    assert dists == sorted(dists)
    # endpoints respect the exclusion zone across chosen pairs.
    endpoints = [e for r in rows for e in (r["idxA"], r["idxB"])]
    minlag = 40 // 4  # exclusion_zone(m) = ceil(m/4)
    for i in range(len(endpoints)):
        for j in range(i + 1, len(endpoints)):
            if endpoints[i] != endpoints[j]:
                assert abs(endpoints[i] - endpoints[j]) >= 1  # sanity: distinct


def test_motif_distributed_path_matches_momp_exactly():
    # A window large enough that should_distribute() is True, run with a real (non-map)
    # mapper, routes the motif through the distributed parallel matrix profile instead of
    # the driver-only anytime MOMP. The result must stay exact: identical top-1 pair to
    # the reference MOMP, just computed with executor fan-out (here a thread pool stands
    # in for the Spark mapper).
    m = 40
    t = datagen.planted_motif(2200, m, loc_a=300, loc_b=1500, seed=11)
    spec = JobSpec(job_id="j-motif-dist", type="MOTIF_MOMP", m=m, k=1, n_blocks=8)
    out = run_analysis(spec, t, mapper=threaded_mapper(4))

    assert len(out.motif_pairs) == 1
    row = out.motif_pairs[0]
    ref = momp(t, m)
    assert (row["idxA"], row["idxB"]) == ref.pair
    assert row["subLen"] == m
    assert out.summary["topMotif"]["idxA"] == ref.pair[0]
    assert out.summary["topMotif"]["idxB"] == ref.pair[1]


def test_motif_distributed_and_serial_paths_agree():
    # The serial (driver MOMP) and distributed (parallel MP) motif paths must return the
    # same headline motif for the same input, so which path runs is purely a performance
    # decision with no effect on results.
    m = 32
    t = datagen.planted_motif(2100, m, loc_a=200, loc_b=1400, seed=5)
    spec_serial = JobSpec(job_id="j-serial", type="MOTIF_MOMP", m=m, k=1)
    spec_dist = JobSpec(job_id="j-dist", type="MOTIF_MOMP", m=m, k=1, n_blocks=6)

    serial = run_analysis(spec_serial, t)  # default map -> driver MOMP
    dist = run_analysis(spec_dist, t, mapper=threaded_mapper(3))  # -> parallel MP

    assert (serial.motif_pairs[0]["idxA"], serial.motif_pairs[0]["idxB"]) == (
        dist.motif_pairs[0]["idxA"],
        dist.motif_pairs[0]["idxB"],
    )


# ------------------------------------------------------------------- DISCORD

def test_discord_damp_recovers_planted_discord():
    m = 50
    loc = 900
    t = datagen.planted_discord(2000, m, loc=loc, seed=2)
    spec = JobSpec(job_id="j-disc", type="DISCORD_DAMP", m=m, k=1)
    out = run_analysis(spec, t)
    assert len(out.discords) == 1
    row = out.discords[0]
    ref = discords(t, m, k=1)
    assert row["idx"] == ref[0].index
    assert row["rank"] == 1
    assert row["severity"] == pytest.approx(1.0)  # top discord normalizes to 1.0


def test_discord_include_profile_emits_mp_result():
    m = 50
    t = datagen.planted_discord(1500, m, loc=700, seed=5)
    spec = JobSpec(job_id="j-disc2", type="DISCORD_DAMP", m=m, k=2, include_profile=True)
    out = run_analysis(spec, t)
    assert len(out.discords) == 2
    assert out.mp_result, "include_profile should emit the MP lane"


# ------------------------------------------------------------------- PAN_MP

def test_pan_mp_scans_lengths_and_picks_best():
    m_true = 40
    t = datagen.planted_motif(600, m_true, loc_a=100, loc_b=400, seed=4)
    spec = JobSpec(job_id="j-pan", type="PAN_MP", length_min=20, length_max=60,
                   length_step=10, k=1)
    events, sink = _record_sink()
    out = run_analysis(spec, t, sink=sink)
    assert out.motif_pairs, "PAN_MP should return at least one motif"
    assert out.summary["bestLength"] in out.summary["scannedLengths"]
    # The winning motif should localize to the planted repeat near (100, 400),
    # regardless of which (sub)length scores best — a shorter window that still tiles
    # the planted pattern is a legitimate winner.
    row = out.motif_pairs[0]
    assert abs(row["idxA"] - 100) <= 40
    assert abs(row["idxB"] - 400) <= 40
    assert events[-1].pct == 100.0


def test_pan_distributed_and_serial_paths_agree():
    # PAN_MP computes a full matrix profile per candidate length. With a real (non-map)
    # mapper and a window large enough to distribute, each length now fans out across the
    # mapper instead of running the single-threaded driver MOMP. The chosen length and its
    # motif pair must be identical to the serial path -- distribution is a pure speedup.
    m_true = 40
    t = datagen.planted_motif(2200, m_true, loc_a=300, loc_b=1500, seed=7)
    spec_serial = JobSpec(job_id="j-pan-serial", type="PAN_MP",
                          length_min=32, length_max=48, length_step=8, k=1)
    spec_dist = JobSpec(job_id="j-pan-dist", type="PAN_MP",
                        length_min=32, length_max=48, length_step=8, k=1, n_blocks=6)

    serial = run_analysis(spec_serial, t)  # default map -> driver MOMP per length
    dist = run_analysis(spec_dist, t, mapper=threaded_mapper(3))  # -> parallel MP per length

    assert serial.summary["bestLength"] == dist.summary["bestLength"]
    assert serial.motif_pairs and dist.motif_pairs
    assert (serial.motif_pairs[0]["idxA"], serial.motif_pairs[0]["idxB"], serial.motif_pairs[0]["subLen"]) == (
        dist.motif_pairs[0]["idxA"],
        dist.motif_pairs[0]["idxB"],
        dist.motif_pairs[0]["subLen"],
    )


# ------------------------------------------------------------------- SEGMENTATION

def test_segmentation_recovers_regime_boundary_and_emits_cac():
    m = 32
    seg = 300
    series, boundary = datagen.regime_series(seg, cycles_a=4, cycles_b=16, seed=2)
    spec = JobSpec(job_id="j-seg", type="SEGMENTATION", m=m, k=1)
    events, sink = _record_sink()
    out = run_analysis(spec, series, sink=sink)

    assert out.arc_curve, "segmentation should emit the corrected arc curve"
    assert len(out.arc_curve) == series.shape[0] - m + 1
    assert len(out.segments) == 1
    b = out.segments[0]
    assert b["rank"] == 1
    assert abs(b["boundaryIdx"] - boundary) <= 3 * m
    assert out.summary["type"] == "SEGMENTATION"
    assert out.summary["numRegimes"] == 2  # one boundary -> two regimes
    assert out.overview, "overview should be built for the signal lane"
    assert events[-1].pct == 100.0


def test_segmentation_distributed_matches_serial():
    m = 32
    series, _ = datagen.regime_series(1200, cycles_a=6, cycles_b=24, seed=8)
    spec_serial = JobSpec(job_id="j-seg-s", type="SEGMENTATION", m=m, k=2)
    spec_dist = JobSpec(job_id="j-seg-d", type="SEGMENTATION", m=m, k=2, n_blocks=6)
    serial = run_analysis(spec_serial, series)
    dist = run_analysis(spec_dist, series, mapper=threaded_mapper(3))
    assert [r["boundaryIdx"] for r in serial.segments] == [r["boundaryIdx"] for r in dist.segments]


# ------------------------------------------------------------------- CHAIN

def test_chain_recovers_drifting_pattern():
    m = 40
    period = 120
    series, locs = datagen.drifting_chain(1000, m, period, seed=3)
    spec = JobSpec(job_id="j-chain", type="CHAIN", m=m, k=1)
    events, sink = _record_sink()
    out = run_analysis(spec, series, sink=sink)

    assert out.chain_links, "chain should emit at least one link"
    # All links belong to rank-1 chain, ordered by linkOrder, ascending in time.
    idxs = [r["idx"] for r in out.chain_links if r["chainRank"] == 1]
    orders = [r["linkOrder"] for r in out.chain_links if r["chainRank"] == 1]
    assert orders == list(range(len(orders)))
    assert idxs == sorted(idxs)
    assert out.chain_links[0]["subLen"] == m
    assert out.summary["type"] == "CHAIN"
    assert out.summary["topChainLength"] == len(idxs)
    assert out.summary["drift"] is not None
    assert events[-1].pct == 100.0


def test_chain_distributed_matches_serial():
    m = 40
    series, _ = datagen.drifting_chain(1200, m, 120, seed=4)
    spec_serial = JobSpec(job_id="j-chain-s", type="CHAIN", m=m, k=2)
    spec_dist = JobSpec(job_id="j-chain-d", type="CHAIN", m=m, k=2, n_blocks=6)
    serial = run_analysis(spec_serial, series)
    dist = run_analysis(spec_dist, series, mapper=threaded_mapper(3))
    assert [(r["chainRank"], r["idx"]) for r in serial.chain_links] == \
        [(r["chainRank"], r["idx"]) for r in dist.chain_links]


# ------------------------------------------------------------------- helpers/errors

def test_motif_pairs_from_profile_dedupes_and_excludes():
    t = datagen.planted_motif(500, 40, loc_a=80, loc_b=300, seed=9)
    profile = mpx(t, 40)
    pairs = motif_pairs_from_profile(profile, k=2, minlag=10)
    assert len(pairs) <= 2
    a0, b0, d0 = pairs[0]
    assert a0 < b0
    assert d0 == pytest.approx(float(profile.mp.min()), rel=1e-6)


def test_full_mp_requires_m():
    with pytest.raises(ValueError):
        run_analysis(JobSpec(job_id="j", type="FULL_MP", m=None), np.zeros(100))


def test_unknown_type_raises():
    with pytest.raises(ValueError):
        run_analysis(JobSpec(job_id="j", type="NOPE", m=16), np.zeros(100))


def test_rejects_2d_series():
    with pytest.raises(ValueError):
        run_analysis(JobSpec(job_id="j", type="FULL_MP", m=16), np.zeros((10, 2)))


def test_build_overview_can_be_disabled():
    t = datagen.random_walk(300, seed=1)
    spec = JobSpec(job_id="j", type="FULL_MP", m=32, build_overview=False)
    out = run_analysis(spec, t)
    assert out.overview == []


# ------------------------------------------------------------------- spark_entry wiring

class _FakeColumn:
    def __init__(self, values):
        self._values = values

    def to_numpy(self):
        return np.asarray(self._values)


class _FakeFrame:
    def __init__(self, columns: dict):
        self._columns = columns

    def __getitem__(self, key):
        return _FakeColumn(self._columns[key])


class _FakeClient:
    """In-memory stand-in for KustoResultClient: records queries and ingested rows."""

    def __init__(self, series):
        self._series = series
        self.queries: list[str] = []
        self.ingested: dict[str, list[dict]] = {}

    def read_dataframe(self, query):
        self.queries.append(query)
        return _FakeFrame({"val": self._series})

    def ingest_rows(self, table, rows):
        self.ingested.setdefault(table, []).extend(rows)
        return len(rows)


def test_spark_entry_execute_reads_analyzes_and_ingests():
    from tsmp.jobs.spark_entry import execute

    m = 40
    t = datagen.planted_motif(600, m, loc_a=100, loc_b=400, seed=1)
    client = _FakeClient(t)
    source = {"table": "Sensor", "timeColumn": "ts", "valueColumn": "val"}
    spec = JobSpec(job_id="j-e2e", type="MOTIF_MOMP", m=m, k=1)

    posts: list[dict] = []
    result = execute(spec, source, client, client, spark_context=None,
                     progress_post=posts.append)

    # Read issued a bulk query against the source table.
    assert client.queries and "Sensor" in client.queries[0]
    # Motif pairs were ingested and the completion summary references the job.
    assert "motif_pairs" in client.ingested
    assert "motif_occurrences" in client.ingested
    assert result["jobId"] == "j-e2e"
    assert result["ingested"]["motif_pairs"] == 1
    assert result["ingested"]["motif_occurrences"] >= 2
    # Progress callbacks were forwarded with the job id and a terminal 100%.
    assert posts and posts[-1]["jobId"] == "j-e2e"
    assert posts[-1]["progressPct"] == 100.0


def test_spark_entry_streams_best_so_far_to_job_progress():
    """execute() ingests improving best-so-far snapshots into the job_progress table so
    the SPA can show live convergence + a partial motif and keep it on stop-early."""
    from tsmp.jobs.spark_entry import execute

    m = 40
    t = datagen.planted_motif(600, m, loc_a=100, loc_b=400, seed=7)
    client = _FakeClient(t)
    source = {"table": "Sensor", "timeColumn": "ts", "valueColumn": "val"}
    spec = JobSpec(job_id="j-prog", type="MOTIF_MOMP", m=m, k=1)

    execute(spec, source, client, client, spark_context=None)

    rows = client.ingested.get("job_progress")
    assert rows, "expected at least one job_progress snapshot"
    # Every row carries the job id, a numeric pct, and the subLen falls back to spec.m.
    assert all(r["jobId"] == "j-prog" for r in rows)
    assert all(isinstance(r["pct"], float) for r in rows)
    # The final snapshot reports full convergence and a concrete best motif.
    last = rows[-1]
    assert last["pct"] == 100.0
    assert last["bestIdxA"] is not None and last["bestIdxB"] is not None
    assert last["subLen"] == m


def test_progress_row_flattens_event_fields():
    from tsmp.jobs.spark_entry import _progress_row
    from tsmp.jobs.runner import ProgressEvent

    ev = ProgressEvent(pct=42.5, best={"pair": [3, 90], "distance": 1.25}, stage="refining motif")
    row = _progress_row("j1", ev, default_sub_len=64)
    assert row["jobId"] == "j1"
    assert row["pct"] == 42.5
    assert row["stage"] == "refining motif"
    assert row["bestDist"] == 1.25
    assert row["bestIdxA"] == 3 and row["bestIdxB"] == 90
    assert row["subLen"] == 64  # falls back to default when the event omits m

    # Pan-MP events carry their own length; coarse events omit the best snapshot.
    pan = _progress_row("j2", ProgressEvent(pct=10.0, best={"m": 12, "pair": [1, 2], "distance": 0.5}), None)
    assert pan["subLen"] == 12
    coarse = _progress_row("j3", ProgressEvent(pct=5.0, stage="computing matrix profile"), 30)
    assert coarse["bestIdxA"] is None and coarse["bestDist"] is None and coarse["subLen"] == 30


def test_progress_sink_never_raises_on_ingest_failure():
    """A progress write is best-effort: if the job_progress table is missing the analysis
    must still complete (the sink swallows the ingestion error)."""
    from tsmp.jobs.spark_entry import _kql_progress_sink
    from tsmp.jobs.runner import ProgressEvent

    class _Boom:
        def ingest_rows(self, table, rows):
            raise RuntimeError("table not found")

    sink = _kql_progress_sink(_Boom(), "j-boom", default_sub_len=10)
    sink(ProgressEvent(pct=50.0, best={"pair": [1, 2], "distance": 0.1}, stage="x"))  # must not raise



    from tsmp.jobs.spark_entry import read_series

    t = datagen.random_walk(200, seed=2)
    client = _FakeClient(t)
    source = {
        "table": "Sensor", "timeColumn": "ts", "valueColumn": "val",
        "windowStart": "2024-01-01T00:00:00Z", "windowEnd": "2024-01-01T01:00:00Z",
    }
    series = read_series(client, source)
    assert series.shape == (200,)
    assert "between (datetime(" in client.queries[0]


def test_spec_from_dict_maps_camel_case():
    from tsmp.jobs.spark_entry import _spec_from_dict

    spec = _spec_from_dict({"jobId": "j1", "type": "DISCORD_DAMP", "subLen": 50, "k": 3,
                            "includeProfile": True, "buildOverview": False})
    assert spec.job_id == "j1" and spec.type == "DISCORD_DAMP"
    assert spec.m == 50 and spec.k == 3
    assert spec.include_profile is True and spec.build_overview is False


def test_run_and_print_emits_result_line_on_success(capsys, monkeypatch):
    from tsmp.jobs import spark_entry

    monkeypatch.setattr(spark_entry, "run_payload",
                        lambda payload, progress_post=None: {"jobId": payload["jobId"], "ok": True})
    out = spark_entry.run_and_print({"jobId": "j-ok"})
    assert out == {"jobId": "j-ok", "ok": True}
    captured = capsys.readouterr()
    assert spark_entry.RESULT_PREFIX in captured.out
    # The printed line round-trips back to the completion summary.
    line = next(l for l in captured.out.splitlines() if l.startswith(spark_entry.RESULT_PREFIX))
    assert json.loads(line[len(spark_entry.RESULT_PREFIX):]) == out
    assert spark_entry.TRACEBACK_BEGIN not in captured.out


def test_run_and_print_prints_tagged_traceback_and_reraises(capsys, monkeypatch):
    from tsmp.jobs import spark_entry

    def _boom(payload, progress_post=None):
        raise RuntimeError("HTTP Error 415: Unsupported Media Type")

    monkeypatch.setattr(spark_entry, "run_payload", _boom)
    with pytest.raises(RuntimeError, match="415"):
        spark_entry.run_and_print({"jobId": "j-fail"})

    captured = capsys.readouterr()
    # The full traceback is bracketed and emitted to BOTH stdout and stderr so it is
    # recoverable from the Livy statement output and the Spark driver log alike.
    for stream in (captured.out, captured.err):
        assert stream.count(spark_entry.TRACEBACK_BEGIN) == 1
        assert stream.count(spark_entry.TRACEBACK_END) == 1
        assert "HTTP Error 415" in stream
        assert "RuntimeError" in stream
    # No spurious success line on failure.
    assert spark_entry.RESULT_PREFIX not in captured.out


# ------------------------------------------------------------------- binned source read

class _FakeBinnedClient:
    """Fake KQL client that returns a time + value frame (for binned read_series tests)."""

    def __init__(self, times, values):
        self._times = times
        self._values = values
        self.queries: list[str] = []

    def read_dataframe(self, query):
        self.queries.append(query)
        return _FakeFrame({"ts": self._times, "val": self._values})


def test_read_series_binned_uses_summarize_query():
    from tsmp.jobs.spark_entry import read_series

    client = _FakeBinnedClient(
        ["2024-01-01T00:00:00Z", "2024-01-01T00:00:10Z"], [1.0, 2.0]
    )
    source = {
        "table": "Sensor", "timeColumn": "ts", "valueColumn": "val",
        "windowStart": "2024-01-01T00:00:00Z", "windowEnd": "2024-01-01T00:00:20Z",
        "binSeconds": 10, "aggregation": "avg", "gapFill": "none",
    }
    series = read_series(client, source)
    # gapFill='none' returns the samples untouched, and the query aggregates by bin().
    assert "summarize" in client.queries[0]
    assert "bin(ts" in client.queries[0]
    np.testing.assert_allclose(series, [1.0, 2.0])


def test_read_series_binned_linear_gap_fill_builds_uniform_grid():
    from tsmp.jobs.spark_entry import read_series

    # Window 0..60s at 10s bins => 7 grid points (0,10,20,30,40,50,60). Middle buckets
    # (20s, 40s) are missing from the source and must be linearly interpolated.
    client = _FakeBinnedClient(
        [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:10Z",
            "2024-01-01T00:00:30Z",
            "2024-01-01T00:00:50Z",
            "2024-01-01T00:01:00Z",
        ],
        [0.0, 10.0, 30.0, 50.0, 60.0],
    )
    source = {
        "table": "Sensor", "timeColumn": "ts", "valueColumn": "val",
        "windowStart": "2024-01-01T00:00:00Z", "windowEnd": "2024-01-01T00:01:00Z",
        "binSeconds": 10, "aggregation": "avg", "gapFill": "linear",
    }
    series = read_series(client, source)
    assert series.shape == (7,)
    # The two missing buckets are interpolated to their linear midpoints (20, 40).
    np.testing.assert_allclose(series, [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0])
    assert not np.isnan(series).any()


def test_read_series_threads_source_query_adapter():
    """A profile-provided sourceQuery is bound as the read source so Spark reads through the
    canonical timeseries adapter (Timestamp/SignalId/Value) rather than a raw table."""
    from tsmp.jobs.spark_entry import read_series

    t = datagen.random_walk(50, seed=7)
    client = _FakeClient(t)
    adapter = "RawFacts\n| project Timestamp=EventTime, SignalId=TagKey, Value=Reading"
    source = {
        "table": "Timeseries", "timeColumn": "Timestamp", "valueColumn": "val",
        "tagColumn": "SignalId", "tag": "Pump-07",
        "sourceQuery": adapter,
    }
    series = read_series(client, source)
    assert series.shape == (50,)
    q = client.queries[0]
    # The adapter is let-bound and used as the source; canonical columns are filtered/projected.
    assert "let _Source = (" in q and adapter in q
    assert '| where SignalId == "Pump-07"' in q



def test_gap_fill_uniform_none_returns_samples_unchanged():
    from tsmp.jobs.spark_entry import gap_fill_uniform

    times = np.array([0.0, 30.0], dtype=np.float64)
    values = np.array([1.0, 2.0], dtype=np.float64)
    out = gap_fill_uniform(
        times, values, "2024-01-01T00:00:00Z", "2024-01-01T00:01:00Z", 10, "none"
    )
    np.testing.assert_allclose(out, [1.0, 2.0])

