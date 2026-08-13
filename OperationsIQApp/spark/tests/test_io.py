"""P3 tests for the data-plane IO: result formatters + KQL query builders."""
import math

import numpy as np
import pytest

from tsmp.momp.mpx import MatrixProfile, mpx
from tsmp.momp.momp import MompResult
from tsmp.damp.damp import DiscordResult, discords
from tsmp.io.results import mp_result_rows, motif_pair_rows, discord_rows
from tsmp.io import kql


# ------------------------------------------------------------------ formatters

def test_mp_result_rows_shape_and_nonfinite_to_none():
    mp = np.array([1.0, math.inf, 0.5, math.nan])
    mpi = np.array([2, -1, 0, -1])
    profile = MatrixProfile(mp=mp, mpi=mpi, m=4, minlag=2)
    rows = mp_result_rows("job-1", profile)
    assert len(rows) == 4
    assert rows[0] == {"jobId": "job-1", "idx": 0, "mp": 1.0, "mpi": 2}
    assert rows[1]["mp"] is None       # inf -> None
    assert rows[3]["mp"] is None       # nan -> None
    assert all(set(r) == {"jobId", "idx", "mp", "mpi"} for r in rows)


def test_mp_result_rows_matches_real_profile():
    rng = np.random.default_rng(1)
    t = rng.standard_normal(300)
    profile = mpx(t, 16)
    rows = mp_result_rows("j", profile)
    assert len(rows) == profile.mp.shape[0]
    assert [r["idx"] for r in rows] == list(range(len(rows)))


def test_motif_pair_rows_from_mompresult():
    res = MompResult(distance=0.19, pair=(420, 100), m=64, levels=5)
    rows = motif_pair_rows("job-9", res)
    assert len(rows) == 1
    row = rows[0]
    assert row["rank"] == 1
    assert (row["idxA"], row["idxB"]) == (100, 420)  # sorted low, high
    assert row["dist"] == pytest.approx(0.19)
    assert row["subLen"] == 64


def test_motif_pair_rows_from_tuples():
    pairs = [(10, 50, 0.1), (200, 240, 0.3)]
    rows = motif_pair_rows("j", pairs, sub_len=40)
    assert [r["rank"] for r in rows] == [1, 2]
    assert rows[1]["idxA"] == 200 and rows[1]["idxB"] == 240
    assert all(r["subLen"] == 40 for r in rows)


def test_motif_pair_rows_requires_sublen_for_tuples():
    with pytest.raises(ValueError):
        motif_pair_rows("j", [(1, 2, 0.5)])


def test_discord_rows_severity_normalized():
    ds = [
        DiscordResult(index=500, nn_distance=4.0, nn_index=10),
        DiscordResult(index=800, nn_distance=2.0, nn_index=20),
    ]
    rows = discord_rows("job-d", ds)
    assert rows[0]["severity"] == pytest.approx(1.0)   # strongest -> 1.0
    assert rows[1]["severity"] == pytest.approx(0.5)
    assert [r["rank"] for r in rows] == [1, 2]
    assert rows[0]["idx"] == 500


def test_discord_rows_from_real_discords():
    rng = np.random.default_rng(2)
    t = rng.standard_normal(400)
    ds = discords(t, 20, k=3)
    rows = discord_rows("j", ds)
    assert len(rows) == 3
    assert all(set(r) == {"jobId", "rank", "idx", "nnDist", "severity"} for r in rows)
    # severity is descending because discords are rank-ordered by nn distance.
    sev = [r["severity"] for r in rows]
    assert sev == sorted(sev, reverse=True)


def test_discord_rows_all_nonfinite_gives_none_severity():
    ds = [DiscordResult(index=1, nn_distance=math.inf, nn_index=-1)]
    rows = discord_rows("j", ds)
    assert rows[0]["nnDist"] is None
    assert rows[0]["severity"] is None


# --------------------------------------------------------- multidimensional (mSTAMP)

def test_mdim_motif_pair_rows_carry_dims_csl():
    from tsmp.mstamp.mstamp import MDimMotif
    from tsmp.io.results import mdim_motif_pair_rows

    motifs = [
        MDimMotif(idx_a=40, idx_b=10, dist=1.5, n_dims=2, dims=[2, 0], dim_dists=[0.4, 0.9]),
    ]
    rows = mdim_motif_pair_rows("j", motifs, sub_len=20)
    assert rows[0]["idxA"] == 10 and rows[0]["idxB"] == 40  # ordered
    assert rows[0]["numDims"] == 2
    assert rows[0]["dims"] == "2,0"  # participating channels, best-agreeing first
    assert rows[0]["subLen"] == 20


def test_mdim_dimension_rows_one_per_channel():
    from tsmp.mstamp.mstamp import MDimMotif
    from tsmp.io.results import mdim_dimension_rows

    motifs = [MDimMotif(idx_a=10, idx_b=40, dist=1.5, n_dims=2, dims=[2, 0], dim_dists=[0.4, 0.9])]
    rows = mdim_dimension_rows("j", motifs, kind="MOTIF")
    assert len(rows) == 2
    assert {r["seriesId"] for r in rows} == {0, 2}
    assert all(r["resultKind"] == "MOTIF" and r["included"] for r in rows)
    got = {r["seriesId"]: r["dist"] for r in rows}
    assert got[2] == pytest.approx(0.4) and got[0] == pytest.approx(0.9)


def test_mdim_discord_rows_severity_and_dims():
    from tsmp.mstamp.mstamp import MDimDiscord
    from tsmp.io.results import mdim_discord_rows

    ds = [
        MDimDiscord(index=5, nn_distance=4.0, nn_index=99, n_dims=2, dims=[1, 0], dim_dists=[3.0, 5.0]),
        MDimDiscord(index=50, nn_distance=2.0, nn_index=9, n_dims=2, dims=[0, 1], dim_dists=[1.0, 3.0]),
    ]
    rows = mdim_discord_rows("j", ds)
    assert rows[0]["idx"] == 5 and rows[0]["numDims"] == 2
    assert rows[0]["severity"] == pytest.approx(1.0)
    assert rows[1]["severity"] == pytest.approx(0.5)


def test_consensus_member_rows_one_per_series_with_central():
    from tsmp.ostinato.ostinato import ConsensusMotif, ConsensusMember
    from tsmp.io.results import consensus_member_rows

    motif = ConsensusMotif(
        central_series=1,
        central_index=42,
        radius=3.5,
        m=20,
        min_count=3,
        members=[
            ConsensusMember(series_id=0, index=10, distance=2.0, is_central=False),
            ConsensusMember(series_id=1, index=42, distance=0.0, is_central=True),
            ConsensusMember(series_id=2, index=7, distance=3.5, is_central=False),
        ],
    )
    rows = consensus_member_rows("j", motif, rank=1)
    assert len(rows) == 3
    assert {r["seriesId"] for r in rows} == {0, 1, 2}
    central = [r for r in rows if r["isCentral"]]
    assert len(central) == 1 and central[0]["seriesId"] == 1
    assert central[0]["idx"] == 42 and central[0]["dist"] == pytest.approx(0.0)
    assert all(r["rank"] == 1 for r in rows)





def test_ident_accepts_valid_rejects_invalid():
    assert kql.ident("mp_result") == "mp_result"
    for bad in ["mp result", "1abc", "drop; table", "a-b", "", "a.b"]:
        with pytest.raises(ValueError):
            kql.ident(bad)


def test_escape_string_quotes_and_escapes():
    assert kql.escape_string("abc") == '"abc"'
    assert kql.escape_string('a"b') == '"a\\"b"'
    assert kql.escape_string("a\\b") == '"a\\\\b"'


def test_escape_string_blocks_injection():
    malicious = 'x") | evil-command //'
    out = kql.escape_string(malicious)
    # The closing quote is escaped, so it can't terminate the literal.
    assert out.startswith('"') and out.endswith('"')
    assert '\\"' in out


# ------------------------------------------------------------------ KQL builders

def test_bulk_series_query_with_and_without_tag():
    q = kql.bulk_series_query("Sensor", "ts", "val")
    assert q.startswith("Sensor")
    assert "| project ts, val" in q
    assert "| order by ts asc" in q
    assert "where" not in q

    qt = kql.bulk_series_query("Sensor", "ts", "val", tag_col="tag", tag="Pump-07")
    assert '| where tag == "Pump-07"' in qt


def test_window_slice_query_uses_datetime_literals():
    q = kql.window_slice_query(
        "Sensor", "ts", "val", "2024-01-01T09:00:00Z", "2024-01-01T10:00:00Z"
    )
    assert 'between (datetime("2024-01-01T09:00:00Z") .. datetime("2024-01-01T10:00:00Z"))' in q
    assert "| project ts, val" in q


def test_binned_window_query_summarizes_by_bin():
    q = kql.binned_window_query(
        "Sensor", "ts", "val", "2024-01-01T09:00:00Z", "2024-01-01T10:00:00Z",
        bin_seconds=60, agg="avg",
    )
    assert 'between (datetime("2024-01-01T09:00:00Z") .. datetime("2024-01-01T10:00:00Z"))' in q
    assert "summarize val=avg(val) by ts=bin(ts, 60.0 * 1s)" in q
    assert "| project ts, val" in q
    assert "| order by ts asc" in q


def test_binned_window_query_with_tag_and_agg():
    q = kql.binned_window_query(
        "Sensor", "ts", "val", "2024-01-01T09:00:00Z", "2024-01-01T10:00:00Z",
        bin_seconds=0.5, agg="max", tag_col="tag", tag="pump-1",
    )
    assert '| where tag == "pump-1"' in q
    assert "summarize val=max(val) by ts=bin(ts, 0.5 * 1s)" in q


def test_binned_window_query_millisecond_bin():
    # A 50 ms bin width (0.05 s) must be emitted verbatim as a KQL timespan, not
    # rounded to a whole second, so millisecond-resolution reads bin correctly.
    q = kql.binned_window_query(
        "Sensor", "ts", "val", "2024-01-01T09:00:00Z", "2024-01-01T09:00:01Z",
        bin_seconds=0.05, agg="avg",
    )
    assert "summarize val=avg(val) by ts=bin(ts, 0.05 * 1s)" in q


def test_binned_window_query_rejects_bad_agg_and_bin():
    with pytest.raises(ValueError):
        kql.binned_window_query("Sensor", "ts", "val", "a", "b", 60, agg="drop table")
    with pytest.raises(ValueError):
        kql.binned_window_query("Sensor", "ts", "val", "a", "b", 0, agg="avg")


# ---- source_query (connection-profile canonical adapter) ------------------

# The active profile's canonical timeseries adapter: raw schema -> Timestamp/SignalId/Value.
_ADAPTER = "RawFacts\n| project Timestamp=EventTime, SignalId=TagKey, Value=Reading"


def test_bulk_series_query_binds_source_query_adapter():
    q = kql.bulk_series_query(
        "Timeseries", "Timestamp", "Value",
        tag_col="SignalId", tag="Pump-07",
        source_query=_ADAPTER,
    )
    # The adapter is let-bound as _Source and used as the pipeline source instead of a raw table.
    assert q.startswith("let _Source = (\n")
    assert _ADAPTER in q
    assert "\n_Source\n" in q or "\n);\n_Source" in q
    # Canonical columns are filtered/projected around the adapter.
    assert '| where SignalId == "Pump-07"' in q
    assert "| project Timestamp, Value" in q


def test_window_slice_query_binds_source_query_adapter():
    q = kql.window_slice_query(
        "Timeseries", "Timestamp", "Value",
        "2024-01-01T09:00:00Z", "2024-01-01T10:00:00Z",
        tag_col="SignalId", tag="Pump-07",
        source_query=_ADAPTER,
    )
    assert "let _Source = (" in q
    assert "_Source" in q
    assert '| where SignalId == "Pump-07"' in q
    assert "| project Timestamp, Value" in q


def test_binned_window_query_binds_source_query_adapter():
    q = kql.binned_window_query(
        "Timeseries", "Timestamp", "Value",
        "2024-01-01T09:00:00Z", "2024-01-01T10:00:00Z",
        bin_seconds=60, agg="avg",
        tag_col="SignalId", tag="Pump-07",
        source_query=_ADAPTER,
    )
    assert "let _Source = (" in q
    assert "summarize Value=avg(Value) by Timestamp=bin(Timestamp, 60.0 * 1s)" in q
    assert '| where SignalId == "Pump-07"' in q


def test_source_query_bypasses_table_identifier_validation():
    # `table` is a placeholder ignored when source_query is set, so a non-identifier
    # table value must not raise (the adapter is the real source).
    q = kql.bulk_series_query(
        "ignored placeholder", "Timestamp", "Value", source_query=_ADAPTER,
    )
    assert "let _Source = (" in q
    # Canonical column identifiers are still validated.
    with pytest.raises(ValueError):
        kql.bulk_series_query("Timeseries", "not a col", "Value", source_query=_ADAPTER)


def test_mp_result_range_query():
    q = kql.mp_result_range_query("job-1", 100, 200)
    assert q.startswith("mp_result")
    assert 'jobId == "job-1"' in q
    assert "idx between (100 .. 200)" in q
    assert "| order by idx asc" in q


def test_mp_result_range_query_rejects_bad_range():
    with pytest.raises(ValueError):
        kql.mp_result_range_query("j", 200, 100)


def test_motif_pairs_query_top():
    q = kql.motif_pairs_query("j", top=3)
    assert '| where jobId == "j"' in q
    assert "| order by rank asc" in q
    assert "| take 3" in q
    with pytest.raises(ValueError):
        kql.motif_pairs_query("j", top=0)


def test_motif_occurrences_query():
    q = kql.motif_occurrences_query("j")
    assert q.startswith("motif_occurrences")
    assert '| where jobId == "j"' in q
    assert "| order by rank asc, occurrence asc" in q
    assert "rank == " not in q  # no rank filter unless requested

    scoped = kql.motif_occurrences_query("j", rank=2)
    assert "| where rank == 2" in scoped


def test_discords_query():
    q = kql.discords_query("j")
    assert "discords" in q
    assert "| project rank, idx, nnDist, severity" in q
    assert "take" not in q


def test_overview_level_query_with_bucket_window():
    q = kql.overview_level_query("j", level=2, bucket_lo=0, bucket_hi=99)
    assert "level == 2" in q
    assert "bucket between (0 .. 99)" in q
    assert "| order by bucket asc" in q


def test_overview_level_query_without_window():
    q = kql.overview_level_query("j", level=0)
    assert "level == 0" in q
    assert "bucket between" not in q


def test_custom_table_name_is_validated():
    # A malicious "table name" must be rejected, not interpolated.
    with pytest.raises(ValueError):
        kql.mp_result_range_query("j", 0, 10, table="mp_result | evil")
