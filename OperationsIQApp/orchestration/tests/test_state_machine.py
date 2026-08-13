"""Tests for the pure orchestration logic: state machine + callback payloads."""
import json

import pytest

from orchestration.state_machine import (
    JobStatus,
    JobState,
    InvalidTransition,
    is_terminal,
    can_transition,
    transition,
    start,
    report_progress,
    succeed,
    fail,
    cancel,
)
from orchestration.callbacks import (
    progress_callback,
    completion_callback,
    update_job_mutation,
)


# --------------------------------------------------------------------------- state machine
def test_terminal_classification():
    assert is_terminal(JobStatus.SUCCEEDED)
    assert is_terminal(JobStatus.FAILED)
    assert is_terminal(JobStatus.CANCELLED)
    assert not is_terminal(JobStatus.QUEUED)
    assert not is_terminal(JobStatus.RUNNING)


def test_allowed_transitions():
    assert can_transition(JobStatus.QUEUED, JobStatus.RUNNING)
    assert can_transition(JobStatus.QUEUED, JobStatus.CANCELLED)
    assert can_transition(JobStatus.RUNNING, JobStatus.SUCCEEDED)
    assert can_transition(JobStatus.RUNNING, JobStatus.FAILED)
    assert can_transition(JobStatus.RUNNING, JobStatus.CANCELLED)


def test_illegal_transitions_rejected():
    # Cannot skip RUNNING.
    assert not can_transition(JobStatus.QUEUED, JobStatus.SUCCEEDED)
    # Cannot leave a terminal state.
    assert not can_transition(JobStatus.SUCCEEDED, JobStatus.RUNNING)
    assert not can_transition(JobStatus.FAILED, JobStatus.RUNNING)
    assert not can_transition(JobStatus.CANCELLED, JobStatus.QUEUED)


def test_start_records_spark_app_and_running():
    s = JobState(job_id="j1")
    s2 = start(s, spark_app_id="app-42")
    assert s2.status == JobStatus.RUNNING
    assert s2.spark_app_id == "app-42"
    # Original is untouched (frozen / pure).
    assert s.status == JobStatus.QUEUED
    assert s.spark_app_id is None


def test_full_happy_path():
    s = JobState(job_id="j1")
    s = start(s, spark_app_id="app-1")
    s = report_progress(s, 25.0)
    s = report_progress(s, 80.0)
    s = succeed(s)
    assert s.status == JobStatus.SUCCEEDED
    assert s.progress_pct == 100.0


def test_progress_is_monotonic_and_clamped():
    s = start(JobState(job_id="j1"))
    s = report_progress(s, 40.0)
    # Backwards progress ignored.
    s = report_progress(s, 10.0)
    assert s.progress_pct == 40.0
    # Over-100 clamped.
    s = report_progress(s, 150.0)
    assert s.progress_pct == 100.0
    # Negative clamped to floor (still monotonic so stays 100).
    s = report_progress(s, -5.0)
    assert s.progress_pct == 100.0


def test_progress_requires_running():
    with pytest.raises(InvalidTransition):
        report_progress(JobState(job_id="j1"), 10.0)  # still QUEUED


def test_fail_from_queued_and_running():
    assert fail(JobState(job_id="a"), "bad params").status == JobStatus.FAILED
    running = start(JobState(job_id="b"))
    failed = fail(running, "spark died")
    assert failed.status == JobStatus.FAILED
    assert failed.error_message == "spark died"


def test_cancel_from_either_state():
    assert cancel(JobState(job_id="a")).status == JobStatus.CANCELLED
    assert cancel(start(JobState(job_id="b"))).status == JobStatus.CANCELLED


def test_cannot_resurrect_terminal_job():
    done = succeed(start(JobState(job_id="j1")))
    with pytest.raises(InvalidTransition):
        start(done)
    with pytest.raises(InvalidTransition):
        cancel(done)


def test_transition_unknown_status():
    with pytest.raises(InvalidTransition):
        transition(JobState(job_id="j1"), "BOGUS")


# --------------------------------------------------------------------------- callbacks
def test_update_job_mutation_is_stable_string():
    m = update_job_mutation()
    assert "mutation UpdateAnalysisJob" in m
    assert "updateAnalysisJob" in m


def test_progress_callback_shape():
    body = progress_callback("job-9", 33.333333, best={"idxA": 10, "idxB": 250})
    assert body["query"] == update_job_mutation()
    v = body["variables"]
    assert v["id"] == "job-9"
    assert v["patch"]["status"] == "RUNNING"
    assert v["patch"]["progressPct"] == 33.333
    # best-so-far serialized deterministically.
    assert v["patch"]["bestSoFar"] == json.dumps(
        {"idxA": 10, "idxB": 250}, sort_keys=True
    )


def test_progress_callback_without_best_omits_field():
    body = progress_callback("job-9", 5.0, stage="level dsr=4")
    patch = body["variables"]["patch"]
    assert "bestSoFar" not in patch
    assert patch["stage"] == "level dsr=4"


def test_completion_callback_success_records_pointers():
    body = completion_callback(
        "job-1",
        "SUCCEEDED",
        summary={"motif": {"dist": 1.23}},
        compute_seconds=12.5,
    )
    patch = body["variables"]["patch"]
    assert patch["status"] == "SUCCEEDED"
    assert patch["progressPct"] == 100.0
    assert patch["resultKey"] == "job-1"  # defaults to job id
    assert patch["resultKqlTable"] == "mp_result"
    assert patch["overviewKqlTable"] == "overview"
    assert patch["computeSeconds"] == 12.5
    assert json.loads(patch["summary"]) == {"motif": {"dist": 1.23}}


def test_completion_callback_failure_records_error():
    body = completion_callback("job-2", "FAILED", error_message="OOM")
    patch = body["variables"]["patch"]
    assert patch["status"] == "FAILED"
    assert patch["errorMessage"] == "OOM"
    assert "resultKey" not in patch  # no result pointers on failure


def test_completion_callback_rejects_non_terminal():
    with pytest.raises(ValueError):
        completion_callback("job-3", "RUNNING")


def test_completion_callback_custom_result_key():
    body = completion_callback("job-4", "SUCCEEDED", result_key="custom-key")
    assert body["variables"]["patch"]["resultKey"] == "custom-key"


def test_progress_callback_streams_livy_identifiers():
    body = progress_callback(
        "job-9",
        12.0,
        stage="statement:running",
        livy_session_id=7,
        livy_statement_id=1,
        livy_state="busy",
        spark_app_id="app-1",
        spark_ui_url="https://ui",
    )
    patch = body["variables"]["patch"]
    assert patch["stage"] == "statement:running"
    assert patch["livySessionId"] == "7"
    assert patch["livyStatementId"] == "1"
    assert patch["livyState"] == "busy"
    assert patch["sparkAppId"] == "app-1"
    assert patch["sparkUiUrl"] == "https://ui"


def test_completion_callback_failure_records_troubleshooting_detail():
    body = completion_callback(
        "job-2",
        "FAILED",
        error_message="OOM",
        driver_log_tail=["line1", "line2"],
        spark_ui_url="https://ui",
        livy_state="dead",
    )
    patch = body["variables"]["patch"]
    assert patch["errorMessage"] == "OOM"
    assert patch["driverLogTail"] == "line1\nline2"
    assert patch["sparkUiUrl"] == "https://ui"
    assert patch["livyState"] == "dead"
