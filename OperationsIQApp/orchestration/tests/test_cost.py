"""Tests for cost estimation, quotas, and cache-key dedup."""
from orchestration.cost import (
    estimate_compute_seconds,
    estimate_cu_cost,
    QuotaLedger,
    cache_key,
)


def test_compute_seconds_scales_with_work_and_cores():
    small = estimate_compute_seconds(1000, 100, "FULL_MP", cores=4)
    big = estimate_compute_seconds(1_000_000, 100, "FULL_MP", cores=4)
    assert big > small
    # more cores -> less wall clock
    assert estimate_compute_seconds(1_000_000, 100, "FULL_MP", cores=8) < big


def test_job_type_work_factors_ordered():
    n, m = 1_000_000, 200
    full = estimate_compute_seconds(n, m, "FULL_MP")
    motif = estimate_compute_seconds(n, m, "MOTIF_MOMP")
    pan = estimate_compute_seconds(n, m, "PAN_MP")
    # pruned motif search cheaper than full; pan scan more expensive.
    assert motif < full < pan


def test_zero_inputs_are_free():
    assert estimate_compute_seconds(0, 100, "FULL_MP") == 0.0
    assert estimate_compute_seconds(1000, 0, "FULL_MP") == 0.0


def test_cu_cost_positive():
    secs = estimate_compute_seconds(1_000_000, 200, "FULL_MP")
    assert estimate_cu_cost(secs) > 0


def test_quota_ledger_allows_and_blocks():
    q = QuotaLedger(daily_limit_seconds=100.0)
    assert q.remaining("alice") == 100.0
    assert q.can_submit("alice", 60.0)
    q.record("alice", 60.0)
    assert q.remaining("alice") == 40.0
    assert not q.can_submit("alice", 50.0)  # over budget
    assert q.can_submit("bob", 90.0)  # separate user


def test_cache_key_is_stable_and_order_insensitive_for_params():
    k1 = cache_key("sig", "t0", "t1", 200, "MOTIF_MOMP", {"a": 1, "b": 2})
    k2 = cache_key("sig", "t0", "t1", 200, "MOTIF_MOMP", {"b": 2, "a": 1})
    assert k1 == k2
    assert len(k1) == 64  # sha-256 hex


def test_cache_key_differs_on_any_field():
    base = cache_key("sig", "t0", "t1", 200, "MOTIF_MOMP", {"k": 3})
    assert base != cache_key("sig2", "t0", "t1", 200, "MOTIF_MOMP", {"k": 3})
    assert base != cache_key("sig", "t0", "t1", 201, "MOTIF_MOMP", {"k": 3})
    assert base != cache_key("sig", "t0", "t1", 200, "DISCORD_DAMP", {"k": 3})
    assert base != cache_key("sig", "t0", "t1", 200, "MOTIF_MOMP", {"k": 4})
    assert base != cache_key("sig", "t0", "t1", None, "MOTIF_MOMP", {"k": 3})
