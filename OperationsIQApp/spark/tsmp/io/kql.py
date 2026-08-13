"""Pure KQL query-string builders (design spec §5.1, §6.4).

These functions return KQL text only — they never touch a cluster — so they are fully
unit-testable without Azure credentials. The execution layer lives in
:mod:`tsmp.io.kusto`, which passes these strings to the Kusto SDK.

Two families of builders:

* **Source reads** (raw sensor series in the Eventhouse): bulk read for Spark compute,
  and a windowed slice for interactive charting.
* **Result reads** (the ``mp_result`` / ``motif_pairs`` / ``discords`` / ``overview``
  tables written by Spark): the range/zoom queries the UI issues on every pan/zoom.

All user-supplied literals are escaped: strings via KQL ``\`` escaping wrapped in
double quotes, datetimes via the ``datetime(...)`` literal, and identifiers validated
against a strict allowlist so a table/column name can never inject KQL.
"""
from __future__ import annotations

import re

__all__ = [
    "escape_string",
    "ident",
    "bulk_series_query",
    "window_slice_query",
    "binned_window_query",
    "mp_result_range_query",
    "motif_pairs_query",
    "motif_occurrences_query",
    "discords_query",
    "overview_level_query",
]

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Aggregations allowed inside a binned source read. Restricting to a known set means the
# aggregation name (which is interpolated into KQL) can never be an injection vector.
_AGG_FNS = {"avg", "min", "max", "sum", "count", "median", "stdev", "any"}


def ident(name: str) -> str:
    """Validate a KQL identifier (table/column name). Rejects anything unusual.

    KQL entity names used here are simple identifiers; refusing everything else makes
    identifier injection impossible without needing to know KQL quoting rules.
    """
    if not isinstance(name, str) or not _IDENT_RE.match(name):
        raise ValueError(f"invalid KQL identifier: {name!r}")
    return name


def escape_string(value: str) -> str:
    """Return a safely quoted KQL string literal for ``value``."""
    if not isinstance(value, str):
        raise TypeError(f"expected str, got {type(value).__name__}")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _check_range(a: int, b: int) -> tuple[int, int]:
    a, b = int(a), int(b)
    if a > b:
        raise ValueError(f"range start {a} must be <= end {b}")
    return a, b


# --------------------------------------------------------------------------- source

def _source_expr(table: str, source_query: str | None) -> tuple[str | None, str]:
    """Resolve the pipeline source, returning ``(prefix_line, source_ref)``.

    When ``source_query`` is provided it is the active Connection Profile's canonical
    timeseries *adapter* — a KQL expression that projects the underlying schema onto the
    canonical ``Timestamp`` / ``SignalId`` / ``Value`` columns. It is bound to a local
    ``_Source`` name and used as the pipeline source so the Spark read runs through the
    exact same adapter as the app's client-side KQL builders (``withTimeseriesRef``),
    regardless of the raw table/column names. Because it is trusted profile-defined KQL
    (a full expression, not a bare identifier) it is intentionally NOT run through
    :func:`ident`; the canonical column names composed around it still are.

    When ``source_query`` is absent the validated ``table`` identifier is used directly
    (the legacy raw-table path).
    """
    if source_query is not None and source_query.strip():
        return f"let _Source = (\n{source_query.strip()}\n);", "_Source"
    return None, ident(table)


def bulk_series_query(
    table: str,
    time_col: str,
    value_col: str,
    tag_col: str | None = None,
    tag: str | None = None,
    source_query: str | None = None,
) -> str:
    """Full ordered series for Spark compute (optionally filtered to one tag).

    When ``source_query`` is given the series is read through the profile's canonical
    timeseries adapter (see :func:`_source_expr`) rather than a raw table.
    """
    tc = ident(time_col)
    vc = ident(value_col)
    prefix, src = _source_expr(table, source_query)
    parts = [prefix] if prefix else []
    parts.append(src)
    if tag_col is not None and tag is not None:
        parts.append(f"| where {ident(tag_col)} == {escape_string(tag)}")
    parts.append(f"| project {tc}, {vc}")
    parts.append(f"| order by {tc} asc")
    return "\n".join(parts)


def window_slice_query(
    table: str,
    time_col: str,
    value_col: str,
    start: str,
    end: str,
    tag_col: str | None = None,
    tag: str | None = None,
    source_query: str | None = None,
) -> str:
    """Interactive slice between two ISO-8601 timestamps for charting.

    When ``source_query`` is given the slice is read through the profile's canonical
    timeseries adapter (see :func:`_source_expr`) rather than a raw table.
    """
    tc = ident(time_col)
    vc = ident(value_col)
    prefix, src = _source_expr(table, source_query)
    parts = [prefix] if prefix else []
    parts.append(src)
    if tag_col is not None and tag is not None:
        parts.append(f"| where {ident(tag_col)} == {escape_string(tag)}")
    parts.append(
        f"| where {tc} between (datetime({escape_string(start)}) .. datetime({escape_string(end)}))"
    )
    parts.append(f"| project {tc}, {vc}")
    parts.append(f"| order by {tc} asc")
    return "\n".join(parts)


def _agg_fn(agg: str | None) -> str:
    """Validate and normalise an aggregation function name for a binned read."""
    name = (agg or "avg").strip().lower()
    if name not in _AGG_FNS:
        raise ValueError(f"unsupported aggregation: {agg!r}")
    return name


def binned_window_query(
    table: str,
    time_col: str,
    value_col: str,
    start: str,
    end: str,
    bin_seconds: float,
    agg: str | None = None,
    tag_col: str | None = None,
    tag: str | None = None,
    source_query: str | None = None,
) -> str:
    """Aggregate a window into fixed ``bin_seconds`` buckets for Matrix-Profile compute.

    Unlike :func:`window_slice_query` (raw rows), this collapses the slice to one value per
    ``bin_seconds`` bucket via ``summarize <agg>(value) by bin(time, ...)``. The projected
    columns keep the original ``time_col``/``value_col`` names so downstream readers are
    unchanged. Missing buckets (gaps) are *not* emitted here — the caller gap-fills onto a
    uniform grid so the MP algorithms see a contiguous, uniformly-sampled series.

    When ``source_query`` is given the window is read through the profile's canonical
    timeseries adapter (see :func:`_source_expr`) rather than a raw table.
    """
    tc = ident(time_col)
    vc = ident(value_col)
    fn = _agg_fn(agg)
    seconds = float(bin_seconds)
    if not seconds > 0:
        raise ValueError(f"bin_seconds must be positive, got {bin_seconds!r}")
    prefix, src = _source_expr(table, source_query)
    parts = [prefix] if prefix else []
    parts.append(src)
    if tag_col is not None and tag is not None:
        parts.append(f"| where {ident(tag_col)} == {escape_string(tag)}")
    parts.append(
        f"| where {tc} between (datetime({escape_string(start)}) .. datetime({escape_string(end)}))"
    )
    # `seconds * 1s` turns a plain number into a KQL timespan, supporting sub-second widths.
    parts.append(f"| summarize {vc}={fn}({vc}) by {tc}=bin({tc}, {seconds} * 1s)")
    parts.append(f"| project {tc}, {vc}")
    parts.append(f"| order by {tc} asc")
    return "\n".join(parts)

def mp_result_range_query(job_id: str, a: int, b: int, table: str = "mp_result") -> str:
    """Matrix-profile values for indices ``[a, b]`` — the core pan/zoom query."""
    t = ident(table)
    a, b = _check_range(a, b)
    return (
        f"{t}\n"
        f"| where jobId == {escape_string(job_id)} and idx between ({a} .. {b})\n"
        f"| project idx, mp, mpi\n"
        f"| order by idx asc"
    )


def motif_pairs_query(job_id: str, top: int | None = None, table: str = "motif_pairs") -> str:
    """Ranked motif pairs for a job (optionally only the top ``top``)."""
    t = ident(table)
    parts = [
        t,
        f"| where jobId == {escape_string(job_id)}",
        "| order by rank asc",
    ]
    if top is not None:
        if int(top) <= 0:
            raise ValueError("top must be positive")
        parts.append(f"| take {int(top)}")
    parts.append("| project rank, idxA, idxB, dist, subLen")
    return "\n".join(parts)


def motif_occurrences_query(
    job_id: str, rank: int | None = None, table: str = "motif_occurrences"
) -> str:
    """All occurrences of a job's motifs (optionally only one ``rank``), ordered for the UI."""
    t = ident(table)
    parts = [
        t,
        f"| where jobId == {escape_string(job_id)}",
    ]
    if rank is not None:
        parts.append(f"| where rank == {int(rank)}")
    parts.append("| order by rank asc, occurrence asc")
    parts.append("| project rank, occurrence, idx, dist, seriesId, subLen")
    return "\n".join(parts)


def discords_query(job_id: str, top: int | None = None, table: str = "discords") -> str:
    """Ranked discords for a job (optionally only the top ``top``)."""
    t = ident(table)
    parts = [
        t,
        f"| where jobId == {escape_string(job_id)}",
        "| order by rank asc",
    ]
    if top is not None:
        if int(top) <= 0:
            raise ValueError("top must be positive")
        parts.append(f"| take {int(top)}")
    parts.append("| project rank, idx, nnDist, severity")
    return "\n".join(parts)


def overview_level_query(
    job_id: str,
    level: int,
    bucket_lo: int | None = None,
    bucket_hi: int | None = None,
    table: str = "overview",
) -> str:
    """Downsampled envelope at one zoom ``level`` (optionally a bucket window)."""
    t = ident(table)
    parts = [
        t,
        f"| where jobId == {escape_string(job_id)} and level == {int(level)}",
    ]
    if bucket_lo is not None and bucket_hi is not None:
        lo, hi = _check_range(bucket_lo, bucket_hi)
        parts.append(f"| where bucket between ({lo} .. {hi})")
    parts.append("| project bucket, tMin, tMax, tAvg, startIdx")
    parts.append("| order by bucket asc")
    return "\n".join(parts)
