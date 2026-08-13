"""Payload builders for control-plane callbacks (design spec §8).

Spark posts progress + best-so-far and, on completion, result-artifact metadata back to
the Rayfin GraphQL Data API which flips the job's state. These builders are pure — they
produce the GraphQL mutation string and the variables dict — so they are unit-testable
without a running API and keep the network layer (a lazy HTTP POST) trivial.
"""
from __future__ import annotations

import json
from typing import Optional

__all__ = ["progress_callback", "completion_callback", "update_job_mutation"]


# A single parameterized mutation the dispatcher/Spark job POSTs to /api/graphql. The
# control plane maps these fields onto the AnalysisJob row.
_UPDATE_JOB_MUTATION = """
mutation UpdateAnalysisJob($id: ID!, $patch: AnalysisJobPatch!) {
  updateAnalysisJob(id: $id, patch: $patch) {
    id
    status
    progressPct
  }
}
""".strip()


def update_job_mutation() -> str:
    """Return the GraphQL mutation string used by both callbacks."""
    return _UPDATE_JOB_MUTATION


def progress_callback(
    job_id: str,
    progress_pct: float,
    status: str = "RUNNING",
    best: Optional[dict] = None,
    stage: str = "",
    *,
    livy_session_id: Optional[str] = None,
    livy_statement_id: Optional[str] = None,
    livy_state: Optional[str] = None,
    spark_app_id: Optional[str] = None,
    spark_ui_url: Optional[str] = None,
) -> dict:
    """Build the GraphQL request body for a streaming progress update.

    ``best`` (the current best-so-far motif/discord) is serialized into the job's
    ``params``-adjacent ``bestSoFar`` field as JSON so the UI can render the anytime
    result without a separate round trip.

    The Livy identifiers (``livy_session_id``/``livy_statement_id``/``livy_state``/
    ``spark_app_id``/``spark_ui_url``) are streamed onto the job row so the UI's session
    details / troubleshooting panel is transparent *while the job is still running* — this
    is what turns an opaque "waiting" spinner into an actionable status.
    """
    patch: dict = {"status": status, "progressPct": round(float(progress_pct), 3)}
    if best is not None:
        patch["bestSoFar"] = json.dumps(best, sort_keys=True)
    if stage:
        patch["stage"] = stage
    if livy_session_id is not None:
        patch["livySessionId"] = str(livy_session_id)
    if livy_statement_id is not None:
        patch["livyStatementId"] = str(livy_statement_id)
    if livy_state is not None:
        patch["livyState"] = livy_state
    if spark_app_id is not None:
        patch["sparkAppId"] = spark_app_id
    if spark_ui_url is not None:
        patch["sparkUiUrl"] = spark_ui_url
    return {
        "query": _UPDATE_JOB_MUTATION,
        "variables": {"id": job_id, "patch": patch},
    }


def completion_callback(
    job_id: str,
    status: str,
    summary: Optional[dict] = None,
    result_key: Optional[str] = None,
    result_kql_table: str = "mp_result",
    overview_kql_table: str = "overview",
    compute_seconds: Optional[float] = None,
    error_message: Optional[str] = None,
    *,
    driver_log_tail: Optional[list] = None,
    spark_ui_url: Optional[str] = None,
    livy_state: Optional[str] = None,
) -> dict:
    """Build the GraphQL request body that finalizes a job (SUCCEEDED/FAILED).

    On success it records the KQL result pointers + small summary so the UI can list the
    job instantly and lazy-load full arrays from KQL; on failure it records the error plus
    troubleshooting detail (driver-log tail, Spark UI link, final Livy state) so the UI's
    session-details panel can explain *why* it failed without another round trip.
    """
    if status not in ("SUCCEEDED", "FAILED", "CANCELLED"):
        raise ValueError(f"completion status must be terminal, got {status!r}")

    patch: dict = {"status": status}
    if status == "SUCCEEDED":
        patch["progressPct"] = 100.0
        patch["resultKey"] = result_key if result_key is not None else job_id
        patch["resultKqlTable"] = result_kql_table
        patch["overviewKqlTable"] = overview_kql_table
        if summary is not None:
            patch["summary"] = json.dumps(summary, sort_keys=True)
    if compute_seconds is not None:
        patch["computeSeconds"] = round(float(compute_seconds), 3)
    if error_message is not None:
        patch["errorMessage"] = error_message
    if driver_log_tail:
        # Stored newline-joined; the UI splits it back into lines.
        patch["driverLogTail"] = "\n".join(str(line) for line in driver_log_tail)
    if spark_ui_url is not None:
        patch["sparkUiUrl"] = spark_ui_url
    if livy_state is not None:
        patch["livyState"] = livy_state

    return {
        "query": _UPDATE_JOB_MUTATION,
        "variables": {"id": job_id, "patch": patch},
    }
