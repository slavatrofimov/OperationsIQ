"""Multi-resolution overview downsampling (design spec §6.4).

Produces "OHLC-style" min/max/avg envelopes at several zoom levels so the frontend can
render millions of points at 60fps by loading only the level and bucket range that are
visible. The output rows map 1:1 onto the KQL ``overview`` table (see
``kql/result_schema.kql``).

This is a pure NumPy function (no Spark, no Kusto) so it is unit-testable on a laptop;
the Spark job simply calls it per signal/window and ingests the returned rows.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

__all__ = ["OverviewRow", "build_overview", "overview_rows"]


@dataclass(frozen=True)
class OverviewRow:
    """One downsampled bucket at a given zoom level."""

    level: int      # 0 = finest; each higher level is `factor` times coarser
    bucket: int     # bucket index within the level
    tMin: float     # minimum value in the bucket
    tMax: float     # maximum value in the bucket
    tAvg: float     # mean value in the bucket
    startIdx: int   # index in the original series where the bucket starts


def _bucketize(values: np.ndarray, bucket_size: int, level: int) -> list[OverviewRow]:
    n = values.shape[0]
    rows: list[OverviewRow] = []
    for b, start in enumerate(range(0, n, bucket_size)):
        seg = values[start : start + bucket_size]
        if seg.size == 0:
            continue
        rows.append(
            OverviewRow(
                level=level,
                bucket=b,
                tMin=float(np.min(seg)),
                tMax=float(np.max(seg)),
                tAvg=float(np.mean(seg)),
                startIdx=int(start),
            )
        )
    return rows


def build_overview(
    values: np.ndarray,
    base_bucket: int = 8,
    factor: int = 4,
    min_buckets: int = 16,
    max_levels: int = 12,
) -> list[OverviewRow]:
    """Build min/max/avg envelopes at geometrically coarsening zoom levels.

    Level 0 uses ``base_bucket`` samples per bucket; each subsequent level multiplies
    the bucket size by ``factor``. Generation stops once a level has at most
    ``min_buckets`` buckets (fully zoomed out) or ``max_levels`` is reached.
    """
    values = np.asarray(values, dtype=np.float64)
    if values.ndim != 1:
        raise ValueError("values must be a 1-D array")
    if base_bucket < 1 or factor < 2:
        raise ValueError("base_bucket must be >= 1 and factor >= 2")

    rows: list[OverviewRow] = []
    bucket_size = base_bucket
    for level in range(max_levels):
        level_rows = _bucketize(values, bucket_size, level)
        rows.extend(level_rows)
        if len(level_rows) <= min_buckets:
            break
        bucket_size *= factor
    return rows


def overview_rows(
    job_id: str,
    values: np.ndarray,
    series_id: int | None = None,
    **kwargs,
) -> list[dict]:
    """``build_overview`` as KQL-ready dicts tagged with ``jobId`` (``ingestedAt`` set on ingest).

    ``series_id`` tags multi-series (AB-join) envelopes so the UI can render one lane per
    series; it is omitted for single-series jobs so those rows keep their original shape.
    """
    extra = {} if series_id is None else {"seriesId": int(series_id)}
    return [{"jobId": job_id, **extra, **asdict(r)} for r in build_overview(values, **kwargs)]
