"""P3 tests for multi-resolution overview downsampling (design spec §6.4)."""
import numpy as np
import pytest

from tsmp.overview.downsample import OverviewRow, build_overview, overview_rows


def _levels(rows):
    out = {}
    for r in rows:
        out.setdefault(r.level, []).append(r)
    return out


def test_min_le_avg_le_max_per_bucket():
    rng = np.random.default_rng(0)
    values = rng.standard_normal(5000)
    for r in build_overview(values):
        assert r.tMin <= r.tAvg <= r.tMax


def test_level0_covers_full_series():
    values = np.arange(1000, dtype=float)
    rows = _levels(build_overview(values, base_bucket=8))[0]
    # Buckets tile the whole series with no gaps.
    assert rows[0].startIdx == 0
    covered = sum(1 for _ in rows)
    assert covered == (1000 + 8 - 1) // 8
    # startIdx increments by the bucket size.
    assert rows[1].startIdx == 8


def test_bucket_counts_shrink_by_factor():
    values = np.zeros(100_000)
    levels = _levels(build_overview(values, base_bucket=8, factor=4, min_buckets=16))
    ordered = sorted(levels)
    counts = [len(levels[l]) for l in ordered]
    # Each successive level has ~factor fewer buckets.
    for finer, coarser in zip(counts, counts[1:]):
        assert coarser <= finer
        assert coarser == pytest.approx(finer / 4, abs=2)


def test_coarsest_level_within_min_buckets():
    values = np.zeros(100_000)
    rows = build_overview(values, base_bucket=8, factor=4, min_buckets=16)
    coarsest = max(r.level for r in rows)
    n_coarse = sum(1 for r in rows if r.level == coarsest)
    assert n_coarse <= 16


def test_startidx_matches_bucket_size():
    values = np.arange(500, dtype=float)
    for r in build_overview(values, base_bucket=10, factor=2):
        bucket_size = 10 * (2 ** r.level)
        assert r.startIdx == r.bucket * bucket_size
        # tMin/tMax bracket the raw values in the bucket.
        seg = values[r.startIdx : r.startIdx + bucket_size]
        assert r.tMin == seg.min()
        assert r.tMax == seg.max()


def test_overview_rows_tags_jobid_and_is_kql_shaped():
    values = np.arange(200, dtype=float)
    rows = overview_rows("job-123", values, base_bucket=8)
    assert rows, "expected some rows"
    expected_keys = {"jobId", "level", "bucket", "tMin", "tMax", "tAvg", "startIdx"}
    for r in rows:
        assert set(r) == expected_keys
        assert r["jobId"] == "job-123"


def test_max_levels_caps_generation():
    values = np.zeros(10_000)
    rows = build_overview(values, base_bucket=100, factor=2, min_buckets=1, max_levels=3)
    assert max(r.level for r in rows) == 2


def test_rejects_2d_input():
    with pytest.raises(ValueError):
        build_overview(np.zeros((10, 2)))
