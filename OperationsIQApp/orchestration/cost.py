"""Cost estimation, quotas, and result-cache deduplication (design spec §8, §9).

All pure + dependency-free so the control plane can call it before dispatch and the tests
run instantly. Three concerns:

- **Cost estimate** — turn a request into an approximate compute-seconds + Capacity Unit
  (CU) cost so the UI can show it *before* submit and quotas can be enforced.
- **Quota ledger** — a per-user/day compute budget check.
- **Cache key** — a stable hash of (signal, window, m, algo, params) so identical
  requests are deduped to an existing result instead of recomputing.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Mapping

# Rough per-job-type work multipliers relative to a full MP scan. MOMP/DAMP prune heavily,
# so their *expected* work is a fraction of the O(n*m) full scan; PAN scans many lengths.
_WORK_FACTOR: Mapping[str, float] = {
    "FULL_MP": 1.0,
    "MOTIF_MOMP": 0.15,
    "DISCORD_DAMP": 0.25,
    "PAN_MP": 4.0,
}

# Calibration: work-units processed per compute-second on one core (order-of-magnitude).
_WORK_UNITS_PER_SEC = 2.0e7
# Fabric Spark CU billing rate; pool-dependent and calibrated for standard F64 clusters.
_CU_PER_COMPUTE_SEC = 0.5


def estimate_compute_seconds(points: int, sub_len: int, job_type: str, cores: int = 4) -> float:
    """Approximate wall-clock compute seconds for a job on ``cores`` executors."""
    if points <= 0 or sub_len <= 0:
        return 0.0
    factor = _WORK_FACTOR.get(job_type, 1.0)
    work_units = points * sub_len * factor
    serial_seconds = work_units / _WORK_UNITS_PER_SEC
    # Assume near-linear scaling with a small floor for scheduling overhead.
    return max(0.05, serial_seconds / max(1, cores))


def estimate_cu_cost(compute_seconds: float, cores: int = 4) -> float:
    """Approximate Fabric Capacity Unit cost for a job."""
    return round(compute_seconds * cores * _CU_PER_COMPUTE_SEC, 4)


@dataclass
class QuotaLedger:
    """A simple per-user/day compute-seconds budget (design spec §9).

    Not persistent — the control plane seeds ``used`` from the day's job rows. Pure so the
    allow/deny decision is unit-tested.
    """

    daily_limit_seconds: float
    used: dict[str, float] = field(default_factory=dict)

    def remaining(self, user: str) -> float:
        return max(0.0, self.daily_limit_seconds - self.used.get(user, 0.0))

    def can_submit(self, user: str, estimate_seconds: float) -> bool:
        return estimate_seconds <= self.remaining(user)

    def record(self, user: str, seconds: float) -> None:
        self.used[user] = self.used.get(user, 0.0) + max(0.0, seconds)


def cache_key(
    signal_id: str,
    window_start: str,
    window_end: str,
    sub_len: int | None,
    job_type: str,
    params: Mapping[str, object] | None = None,
) -> str:
    """Stable SHA-256 hex key deduping identical requests (design spec §8).

    ``params`` is canonicalized (sorted keys) so semantically-equal requests collide.
    """
    payload = {
        "signal": signal_id,
        "start": window_start,
        "end": window_end,
        "m": sub_len,
        "type": job_type,
        "params": params or {},
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
