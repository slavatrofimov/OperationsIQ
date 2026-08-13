"""Spark driver entry point for an analysis job (design spec §8).

This is the thin *runtime* wrapper around the pure :func:`tsmp.jobs.runner.run_analysis`
dispatch. On Fabric Spark it:

1. reads the raw series slice from the KQL source table (via :class:`KustoResultClient`),
2. runs the analysis with a Spark-backed ``mapper`` for the parallel MP/discord passes,
3. streams best-so-far progress back to the control plane through a callback, and
4. ingests the result rows into the KQL result tables.

It intentionally contains no heavy logic of its own — everything testable lives in
``runner.py`` — so this module is a lazily-imported orchestration shell that only runs on
a real cluster. Invoke it as a Spark Job Definition / notebook with a JSON job spec.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from typing import Callable, Optional

import numpy as np

from tsmp.jobs.runner import JobSpec, AnalysisOutput, ProgressEvent, run_analysis
from tsmp.io.kql import bulk_series_query, window_slice_query, binned_window_query

__all__ = [
    "build_spark_mapper",
    "read_series",
    "gap_fill_uniform",
    "ingest_output",
    "execute",
    "run_payload",
    "run_and_print",
    "main",
]

# Markers wrapping the traceback emitted by :func:`run_and_print` on failure. They are
# printed to *both* stdout and stderr so the full Python traceback lands in the Livy
# statement output AND the Spark driver log — the latter is retrievable from Fabric
# monitoring even when the app UI does not surface the captured error.
TRACEBACK_BEGIN = "TSMP_TRACEBACK_BEGIN"
TRACEBACK_END = "TSMP_TRACEBACK_END"
RESULT_PREFIX = "TSMP_RESULT "


def build_spark_mapper(spark_context) -> Callable:
    """Return a ``map``-compatible mapper that fans work out over a SparkContext.

    Mirrors ``tsmp.parallel.spark._spark_mapper``: parallelize the work items, apply the
    per-block function on executors, and collect back to the driver for the (tiny,
    deterministic) reduce that the decomposition performs.
    """
    def _mapper(fn, items):
        items = list(items)
        if not items:
            return []
        slices = min(len(items), (spark_context.defaultParallelism or 1) * 4)
        return spark_context.parallelize(items, slices).map(fn).collect()

    return _mapper


def _to_epoch_seconds(values) -> np.ndarray:
    """Coerce a column of timestamps to float epoch seconds (UTC).

    Handles the shapes a KQL client may hand back: numpy ``datetime64``, Python
    ``datetime`` objects, ISO-8601 strings, or already-numeric epoch seconds. Kept
    dependency-light (no hard pandas requirement) so it is unit-testable off-cluster.
    """
    arr = np.asarray(values)
    if np.issubdtype(arr.dtype, np.datetime64):
        return arr.astype("datetime64[ns]").astype("int64") / 1e9
    if np.issubdtype(arr.dtype, np.number):
        return arr.astype(np.float64)

    from datetime import datetime, timezone

    out = np.empty(arr.shape[0], dtype=np.float64)
    for i, v in enumerate(arr.tolist()):
        if isinstance(v, datetime):
            dt = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        elif isinstance(v, str):
            s = v.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = datetime.fromtimestamp(float(v), tz=timezone.utc)
        out[i] = dt.timestamp()
    return out


def _iso_to_epoch(iso: str) -> float:
    from datetime import datetime, timezone

    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def gap_fill_uniform(
    times_epoch: np.ndarray,
    values: np.ndarray,
    start_iso: str,
    end_iso: str,
    bin_seconds: float,
    gap_fill: str,
) -> np.ndarray:
    """Align binned samples onto a uniform grid and fill missing buckets.

    The MP algorithms assume a contiguous, uniformly-sampled series. After a
    ``summarize by bin(...)`` read, buckets with no source rows are simply absent, so this
    lays the returned samples onto a regular ``bin_seconds`` grid spanning the window and:

    * ``linear`` — linearly interpolates empty buckets (leading/trailing filled with the
      nearest known value), yielding a fully contiguous series;
    * ``none`` — returns the samples in time order untouched (no grid), so the series is
      whatever the source provided.
    """
    values = np.asarray(values, dtype=np.float64)
    if gap_fill == "none" or times_epoch.size == 0:
        return values

    bin_seconds = float(bin_seconds)
    g0 = np.floor(_iso_to_epoch(start_iso) / bin_seconds) * bin_seconds
    g_end = np.floor(_iso_to_epoch(end_iso) / bin_seconds) * bin_seconds
    n = int(round((g_end - g0) / bin_seconds)) + 1
    if n < 1:
        n = int(round((times_epoch.max() - g0) / bin_seconds)) + 1
    n = max(n, 1)

    idx = np.rint((times_epoch - g0) / bin_seconds).astype(int)
    inside = (idx >= 0) & (idx < n)
    idx, vals = idx[inside], values[inside]

    grid = np.full(n, np.nan, dtype=np.float64)
    grid[idx] = vals
    known = ~np.isnan(grid)
    if not known.any():
        return np.zeros(n, dtype=np.float64)
    if known.all():
        return grid
    positions = np.arange(n)
    grid[~known] = np.interp(positions[~known], positions[known], grid[known])
    return grid


def read_series(
    client,
    spec_source: dict,
) -> np.ndarray:
    """Read the analysis window from KQL and return it as a float64 array.

    ``spec_source`` carries the resolved source mapping (table/columns/tag) and optional
    window bounds. When ``windowStart``/``windowEnd`` are present a slice query is used;
    otherwise the full series is read (Spark bulk path).

    When ``sourceQuery`` is present it is the active Connection Profile's canonical
    timeseries adapter (projecting Timestamp/SignalId/Value); the read runs through it so
    Spark sees the same canonical schema as the app's client KQL builders, regardless of
    the raw table/column names.

    When ``binSeconds`` is set the window is aggregated into fixed-width buckets
    (``aggregation``, default ``avg``) and laid onto a uniform grid with ``gapFill``
    (default ``linear``) so the returned series is contiguous and uniformly sampled — the
    effective sample interval then equals ``binSeconds``.
    """
    table = spec_source["table"]
    time_col = spec_source["timeColumn"]
    value_col = spec_source["valueColumn"]
    tag_col = spec_source.get("tagColumn")
    tag = spec_source.get("tag")
    source_query = spec_source.get("sourceQuery")

    bin_seconds = spec_source.get("binSeconds")
    has_window = bool(spec_source.get("windowStart") and spec_source.get("windowEnd"))

    if bin_seconds and has_window:
        query = binned_window_query(
            table, time_col, value_col,
            spec_source["windowStart"], spec_source["windowEnd"],
            float(bin_seconds),
            agg=spec_source.get("aggregation"),
            tag_col=tag_col, tag=tag,
            source_query=source_query,
        )
        frame = client.read_dataframe(query)
        values = np.asarray(frame[value_col].to_numpy(), dtype=np.float64)
        times = _to_epoch_seconds(frame[time_col].to_numpy())
        return gap_fill_uniform(
            times, values,
            spec_source["windowStart"], spec_source["windowEnd"],
            float(bin_seconds),
            str(spec_source.get("gapFill") or "linear"),
        )

    if has_window:
        query = window_slice_query(
            table, time_col, value_col,
            spec_source["windowStart"], spec_source["windowEnd"],
            tag_col=tag_col, tag=tag,
            source_query=source_query,
        )
    else:
        query = bulk_series_query(
            table, time_col, value_col,
            tag_col=tag_col, tag=tag,
            source_query=source_query,
        )

    frame = client.read_dataframe(query)
    return np.asarray(frame[value_col].to_numpy(), dtype=np.float64)


def ingest_output(client, out: AnalysisOutput) -> dict:
    """Ingest each non-empty result table for a finished job. Returns per-table counts."""
    counts: dict[str, int] = {}
    if out.mp_result:
        counts["mp_result"] = client.ingest_rows("mp_result", out.mp_result)
    if out.motif_pairs:
        counts["motif_pairs"] = client.ingest_rows("motif_pairs", out.motif_pairs)
    if out.motif_occurrences:
        counts["motif_occurrences"] = client.ingest_rows("motif_occurrences", out.motif_occurrences)
    if out.discords:
        counts["discords"] = client.ingest_rows("discords", out.discords)
    if out.overview:
        counts["overview"] = client.ingest_rows("overview", out.overview)
    if out.arc_curve:
        counts["arc_curve"] = client.ingest_rows("arc_curve", out.arc_curve)
    if out.segments:
        counts["segments"] = client.ingest_rows("segments", out.segments)
    if out.chain_links:
        counts["chain_links"] = client.ingest_rows("chain_links", out.chain_links)
    if out.md_dimensions:
        counts["md_dimensions"] = client.ingest_rows("md_dimensions", out.md_dimensions)
    if out.consensus_members:
        counts["consensus_members"] = client.ingest_rows("consensus_members", out.consensus_members)
    return counts


def _utcnow_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _progress_row(job_id: str, ev: ProgressEvent, default_sub_len: Optional[int]) -> dict:
    """Flatten a :class:`ProgressEvent` into a ``job_progress`` KQL row.

    The best-so-far snapshot (``ev.best``) carries either ``{"pair":[a,b],"distance":d}``
    (motif paths) or ``{"m":m,"pair":[a,b],"distance":d}`` (Pan-MP); coarse stages
    (full MP / discord) have ``best=None``. We store the current best motif inline so the
    SPA can draw a live partial motif while the job runs — and keep it if the user stops
    early — without polluting the final ``motif_pairs`` table.
    """
    best = ev.best or {}
    pair = best.get("pair") or []
    idx_a = int(pair[0]) if len(pair) > 0 and pair[0] is not None else None
    idx_b = int(pair[1]) if len(pair) > 1 and pair[1] is not None else None
    dist = best.get("distance")
    sub_len = best.get("m", default_sub_len)
    return {
        "jobId": job_id,
        "pct": float(ev.pct),
        "stage": ev.stage or "",
        "bestDist": float(dist) if dist is not None else None,
        "bestIdxA": idx_a,
        "bestIdxB": idx_b,
        "subLen": int(sub_len) if sub_len is not None else None,
        "updatedAt": _utcnow_iso(),
    }


def _kql_progress_sink(
    write_client,
    job_id: str,
    default_sub_len: Optional[int] = None,
    post: Optional[Callable[[dict], None]] = None,
):
    """Build a :class:`ProgressSink` that streams best-so-far snapshots to KQL.

    Each improving :class:`ProgressEvent` is ingested as a ``job_progress`` row so the SPA
    can render live convergence + a partial motif while the exhaustive search continues
    (design spec §6.6, §7.2). Progress is strictly best-effort: any ingestion failure
    (e.g. the optional ``job_progress`` table is absent) is swallowed so a progress write
    can never fail the analysis. When ``post`` is also supplied it is invoked too, so an
    out-of-band callback channel (tests / future push transport) still works.
    """

    def sink(ev: ProgressEvent) -> None:
        try:
            write_client.ingest_rows("job_progress", [_progress_row(job_id, ev, default_sub_len)])
        except Exception:  # pragma: no cover - progress is best-effort
            pass
        if post is not None:
            post({"jobId": job_id, "progressPct": ev.pct, "stage": ev.stage, "best": ev.best})

    return sink


def execute(
    spec: JobSpec,
    source: dict,
    read_client,
    write_client,
    spark_context=None,
    progress_post: Optional[Callable[[dict], None]] = None,
    compare_source: Optional[dict] = None,
    signal_sources: Optional[list] = None,
) -> dict:
    """End-to-end run: read → analyze → ingest, returning a completion summary.

    ``read_client`` / ``write_client`` are :class:`KustoResultClient`-shaped objects
    (they can point at the same cluster). ``spark_context`` enables the distributed
    mapper; when ``None`` the analysis runs on the driver (small windows / local tests).
    ``compare_source`` is the AB-join comparison series' source mapping (a second signal
    and/or window); it is read as ``series_b`` and required by AB-join job types.
    ``signal_sources`` is the list of per-channel source mappings for multidimensional
    (mSTAMP) jobs — each is read (at the same bin width, so their samples align) into
    ``series_list``.
    """
    series = read_series(read_client, source)
    series_b = read_series(read_client, compare_source) if compare_source is not None else None
    series_list = (
        [read_series(read_client, s) for s in signal_sources]
        if signal_sources
        else None
    )
    mapper = build_spark_mapper(spark_context) if spark_context is not None else map
    # Stream best-so-far snapshots to KQL so the SPA can show live convergence and a
    # partial motif while the search runs (and retain it on stop-early). progress_post,
    # when provided, is chained as an extra out-of-band channel.
    sink = _kql_progress_sink(write_client, spec.job_id, default_sub_len=spec.m, post=progress_post)
    out = run_analysis(
        spec, series, sink=sink, mapper=mapper, series_b=series_b, series_list=series_list
    )
    counts = ingest_output(write_client, out)
    return {"jobId": spec.job_id, "ingested": counts, "summary": out.summary}


def _spec_from_dict(d: dict) -> JobSpec:
    fields = {
        "job_id": d.get("jobId") or d["job_id"],
        "type": d["type"],
        "m": d.get("subLen", d.get("m")),
        "k": d.get("k", 1),
        "minlag": d.get("minlag"),
        "include_profile": d.get("includeProfile", False),
        "build_overview": d.get("buildOverview", True),
        "length_min": d.get("lengthMin"),
        "length_max": d.get("lengthMax"),
        "length_step": d.get("lengthStep"),
        "n_blocks": d.get("nBlocks", 4),
        "ab_target": d.get("abTarget", "b"),
        "n_dims": d.get("nDims"),
        "min_count": d.get("minCount"),
        "max_occurrences": d.get("maxOccurrences", 200),
    }
    return JobSpec(**fields)


def run_payload(
    payload: dict,
    progress_post: Optional[Callable[[dict], None]] = None,
) -> dict:  # pragma: no cover - requires PySpark + Kusto at runtime
    """Run an analysis from an in-memory job spec ``payload`` and return the summary.

    This is the file-free core shared by the CLI (:func:`main`, which loads the payload
    from ``--job``) and the Livy dispatcher (which submits a statement that calls this
    directly with an inline payload). It lazily builds a SparkSession + Kusto clients so
    importing this module never requires PySpark or the Kusto SDK.

    ``payload`` mirrors the ``AnalysisJob`` row plus a resolved ``source`` mapping:
    ``{jobId,type,subLen,..., source:{kqlClusterUri,database,table,timeColumn,valueColumn,
    tagColumn?,tag?,windowStart?,windowEnd?}, auth?, resultClusterUri?, resultDatabase?}``.

    AB-join (two-series) jobs (``type`` ``AB_MOTIF`` / ``AB_DISCORD``) additionally carry a
    ``compareSource`` mapping (same shape as ``source``) for series B, and an optional
    ``abTarget`` ("a"/"b") selecting the novelty direction for ``AB_DISCORD``.
    """
    spec = _spec_from_dict(payload)
    source = payload["source"]

    from pyspark.sql import SparkSession
    from tsmp.io.kusto import KustoResultClient

    spark = SparkSession.builder.appName(f"tsmp-{spec.job_id}").getOrCreate()

    # Scale the diagonal-block count to the cluster so the parallel matrix profile
    # actually fans out across executors. The JobSpec default (4) would otherwise cap
    # the self-join — and therefore the motif/discord scan built on it — at 4 concurrent
    # tasks no matter how many cores are available, which is what made long windows crawl
    # on a single-core-effective driver. Respect an explicit nBlocks if the caller pinned
    # one; the diagonal splitter clamps the value to the profile length internally.
    if payload.get("nBlocks") is None and payload.get("n_blocks") is None:
        try:
            parallelism = int(spark.sparkContext.defaultParallelism or 0)
        except Exception:
            parallelism = 0
        if parallelism > spec.n_blocks:
            spec.n_blocks = parallelism

    cluster = source["kqlClusterUri"]
    database = source["database"]
    auth = payload.get("auth", "managed_identity")
    read_client = KustoResultClient(cluster, database, auth=auth)
    write_client = KustoResultClient(
        payload.get("resultClusterUri", cluster),
        payload.get("resultDatabase", database),
        auth=auth,
        ingest_mode=payload.get("ingestMode", "managed_streaming"),
    )

    return execute(
        spec,
        source,
        read_client,
        write_client,
        spark_context=spark.sparkContext,
        progress_post=progress_post,
        compare_source=payload.get("compareSource"),
        signal_sources=payload.get("signalSources"),
    )


def run_and_print(
    payload: dict,
    progress_post: Optional[Callable[[dict], None]] = None,
) -> dict:
    """Run one analysis and print a tagged result line, or a tagged traceback on failure.

    This is the single entry point the Livy statement (SPA ``buildLivyCode`` and the
    dispatcher ``build_livy_code``) invokes. On success it prints ``TSMP_RESULT <json>``
    so the caller can recover the completion summary from the statement output. On
    failure it prints the full traceback bracketed by :data:`TRACEBACK_BEGIN` /
    :data:`TRACEBACK_END` to **both** ``stdout`` and ``stderr`` before re-raising, so the
    exact failing call is captured in the Livy statement error *and* the Spark driver log
    (which is retrievable from Fabric monitoring even without the app's diagnostics panel).
    Re-raising preserves the FAILED statement state the control plane relies on.
    """
    import sys
    import traceback

    try:
        result = run_payload(payload, progress_post)
    except BaseException:
        tb = traceback.format_exc()
        for stream in (sys.stdout, sys.stderr):
            try:
                print(TRACEBACK_BEGIN, file=stream)
                print(tb, file=stream)
                print(TRACEBACK_END, file=stream)
                stream.flush()
            except Exception:  # pragma: no cover - stream may be unavailable
                pass
        raise
    print(RESULT_PREFIX + json.dumps(result))
    return result


def main(argv: Optional[list[str]] = None) -> None:  # pragma: no cover - cluster entry
    """CLI entry: ``python -m tsmp.jobs.spark_entry --job job.json``.

    Thin wrapper around :func:`run_payload`: it only loads the job spec JSON from disk and
    prints the resulting completion summary.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Run a matrix-profile analysis job on Spark.")
    parser.add_argument("--job", required=True, help="Path to the job spec JSON file.")
    args = parser.parse_args(argv)

    with open(args.job, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    result = run_payload(payload)
    print(json.dumps(result))


if __name__ == "__main__":  # pragma: no cover
    main()
