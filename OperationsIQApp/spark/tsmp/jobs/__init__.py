"""Job execution glue (design spec §6, §8) — the Spark driver's analysis core.

`run_analysis` is the single entry point that turns a resolved :class:`JobSpec` plus a
raw series into KQL-ready result rows for every table in ``kql/result_schema.kql``. It is
deliberately **pure** (no Spark, no Kusto): the series comes in as a NumPy array and the
outputs go out as lists of dicts, so the whole dispatch is unit-testable on a laptop.

The thin runtime wrapper that reads the series from KQL, runs this on Spark, streams
progress back to the control plane, and ingests the rows lives in
``tsmp/jobs/spark_entry.py``.
"""
from tsmp.jobs.runner import (
    JobSpec,
    AnalysisOutput,
    ProgressEvent,
    run_analysis,
    motif_pairs_from_profile,
)

__all__ = [
    "JobSpec",
    "AnalysisOutput",
    "ProgressEvent",
    "run_analysis",
    "motif_pairs_from_profile",
]
