"""Tests for the Livy dispatch/monitor layer (:mod:`orchestration.fabric_livy`).

The network client (``FabricLivyClient``) is exercised through a fake in-memory transport
so the whole submit → wait-ready → run → terminal flow — plus the anti-hang guards — are
tested without a live Fabric cluster, mirroring how the pure modules are tested elsewhere.
"""
from __future__ import annotations

from typing import List, Optional

import pytest

from orchestration.fabric_livy import (
    FabricLivyClient,
    LivyDiagnostics,
    LivyJobMonitor,
    LivySessionState,
    LivyStartTimeout,
    LivyStatementState,
    LivyStatementTimeout,
    LivyStatus,
    build_status_callback,
    interpret_livy_status,
)
from orchestration.state_machine import JobStatus


# --------------------------------------------------------------------------- interpret (pure)
def test_interpret_none_session_is_submitting():
    status = interpret_livy_status(None)
    assert status.job_status == JobStatus.QUEUED
    assert status.stage == "submitting"
    assert not status.is_terminal


def test_interpret_starting_session_stays_queued():
    status = interpret_livy_status({"state": LivySessionState.STARTING})
    assert status.job_status == JobStatus.QUEUED
    assert status.stage == "session:starting"
    assert "capacity" in status.message.lower() or "start" in status.message.lower()
    assert not status.is_terminal


def test_interpret_dead_session_is_terminal_failure():
    status = interpret_livy_status(
        {"state": LivySessionState.DEAD, "log": ["boom", "capacity exhausted"]}
    )
    assert status.job_status == JobStatus.FAILED
    assert status.is_terminal
    assert "capacity exhausted" in (status.error_message or "")


def test_interpret_ready_session_no_statement_is_running():
    status = interpret_livy_status({"state": LivySessionState.IDLE})
    assert status.job_status == JobStatus.RUNNING
    assert status.progress_pct > 0


def test_interpret_running_statement_reports_progress():
    status = interpret_livy_status(
        {"state": LivySessionState.BUSY},
        {"state": LivyStatementState.RUNNING, "progress": 0.42},
    )
    assert status.job_status == JobStatus.RUNNING
    assert status.progress_pct == pytest.approx(42.0)
    assert not status.is_terminal


def test_interpret_waiting_statement_is_queued_behind():
    status = interpret_livy_status(
        {"state": LivySessionState.BUSY},
        {"state": LivyStatementState.WAITING},
    )
    assert status.job_status == JobStatus.RUNNING
    assert "queued" in status.message.lower()


def test_interpret_available_ok_statement_succeeds():
    status = interpret_livy_status(
        {"state": LivySessionState.IDLE},
        {"state": LivyStatementState.AVAILABLE, "output": {"status": "ok"}},
    )
    assert status.job_status == JobStatus.SUCCEEDED
    assert status.progress_pct == 100.0
    assert status.is_terminal


def test_interpret_available_error_statement_fails_with_traceback():
    status = interpret_livy_status(
        {"state": LivySessionState.IDLE},
        {
            "state": LivyStatementState.AVAILABLE,
            "output": {
                "status": "error",
                "ename": "ValueError",
                "evalue": "bad subLen",
                "traceback": ["line 1", "line 2"],
            },
        },
    )
    assert status.job_status == JobStatus.FAILED
    assert status.is_terminal
    assert "ValueError: bad subLen" in (status.error_message or "")
    assert "line 2" in (status.error_message or "")


def test_interpret_cancelled_statement():
    status = interpret_livy_status(
        {"state": LivySessionState.IDLE},
        {"state": LivyStatementState.CANCELLED},
    )
    assert status.job_status == JobStatus.CANCELLED
    assert status.is_terminal


def test_interpret_is_defensive_about_unknown_state():
    status = interpret_livy_status({"state": "some_future_state"})
    assert status.job_status == JobStatus.QUEUED
    assert not status.is_terminal


def test_interpret_ended_session_without_statement_is_terminal_failure():
    # Session closed/shut down before any statement produced a result.
    status = interpret_livy_status(
        {"state": LivySessionState.SHUTTING_DOWN, "log": ["session closing"]}
    )
    assert status.job_status == JobStatus.FAILED
    assert status.is_terminal
    assert "ended before" in status.message.lower()


def test_interpret_ended_session_with_running_statement_is_terminal_failure():
    # A statement still "running" while the session already ended = closed out from
    # under the analysis. Must not report perpetual progress.
    status = interpret_livy_status(
        {"state": LivySessionState.SUCCESS, "log": ["bye"]},
        {"state": LivyStatementState.RUNNING, "progress": 0.3},
    )
    assert status.job_status == JobStatus.FAILED
    assert status.is_terminal
    assert "ended before" in status.message.lower()


def test_interpret_ended_session_preserves_completed_success():
    # If the statement already reported ok, an ended session must NOT flip it to failed.
    status = interpret_livy_status(
        {"state": LivySessionState.SUCCESS},
        {"state": LivyStatementState.AVAILABLE, "output": {"status": "ok"}},
    )
    assert status.job_status == JobStatus.SUCCEEDED
    assert status.is_terminal


# --------------------------------------------------------------------------- fake transport
class FakeLivyTransport:
    """A scriptable fake of the Fabric Livy REST surface.

    ``session_states`` / ``statement_states`` are consumed one entry per poll so tests can
    describe an entire lifecycle as a list.
    """

    def __init__(
        self,
        session_states: List[dict],
        statement_states: Optional[List[dict]] = None,
        log: Optional[List[str]] = None,
    ) -> None:
        self._session_states = list(session_states)
        self._statement_states = list(statement_states or [])
        self._log = log or ["driver started", "reading signal"]
        self.created = False
        self.submitted_code: Optional[str] = None
        self.deleted = False
        self.cancelled = False

    def _next(self, seq: List[dict], fallback: dict) -> dict:
        if len(seq) > 1:
            return seq.pop(0)
        return seq[0] if seq else fallback

    def create_session(self, config=None):
        self.created = True
        return {"id": 7, "state": LivySessionState.STARTING}

    def get_session(self, session_id):
        return {"id": session_id, "appId": "app-99", **self._next(self._session_states, {"state": LivySessionState.IDLE})}

    def get_session_log(self, session_id, size=100):
        return list(self._log)

    def delete_session(self, session_id):
        self.deleted = True

    def submit_statement(self, session_id, code):
        self.submitted_code = code
        return {"id": 1, "state": LivyStatementState.WAITING}

    def get_statement(self, session_id, statement_id):
        return {"id": statement_id, **self._next(self._statement_states, {"state": LivyStatementState.AVAILABLE, "output": {"status": "ok"}})}

    def cancel_statement(self, session_id, statement_id):
        self.cancelled = True


def _client_with(transport: FakeLivyTransport) -> FabricLivyClient:
    client = FabricLivyClient("ws", "lh", token="t")
    # Swap the network methods for the fake transport's.
    client.create_session = transport.create_session  # type: ignore[assignment]
    client.get_session = transport.get_session  # type: ignore[assignment]
    client.get_session_log = transport.get_session_log  # type: ignore[assignment]
    client.delete_session = transport.delete_session  # type: ignore[assignment]
    client.submit_statement = transport.submit_statement  # type: ignore[assignment]
    client.get_statement = transport.get_statement  # type: ignore[assignment]
    client.cancel_statement = transport.cancel_statement  # type: ignore[assignment]
    return client


def _monitor(client: FabricLivyClient, **kwargs) -> LivyJobMonitor:
    # No real sleeping / clock in tests.
    defaults = dict(poll_interval_s=0.0, sleep=lambda _s: None)
    defaults.update(kwargs)
    return LivyJobMonitor(client, **defaults)


# --------------------------------------------------------------------------- monitor flows
def test_run_happy_path_streams_status_and_cleans_up():
    transport = FakeLivyTransport(
        session_states=[
            {"state": LivySessionState.STARTING},
            {"state": LivySessionState.IDLE},
            {"state": LivySessionState.BUSY},
            {"state": LivySessionState.IDLE},
        ],
        statement_states=[
            {"state": LivyStatementState.WAITING},
            {"state": LivyStatementState.RUNNING, "progress": 0.5},
            {"state": LivyStatementState.AVAILABLE, "output": {"status": "ok"}},
        ],
    )
    client = _client_with(transport)
    monitor = _monitor(client)

    seen: List[str] = []
    status, diag = monitor.run("print('mp')", on_status=lambda s: seen.append(s.stage))

    assert status.job_status == JobStatus.SUCCEEDED
    assert status.is_terminal
    assert transport.submitted_code == "print('mp')"
    assert transport.deleted is True  # session cleaned up
    assert isinstance(diag, LivyDiagnostics)
    assert diag.spark_app_id == "app-99"
    # Transparent progression was streamed (starting -> running -> available at least).
    assert any(stage.startswith("session:") for stage in seen)
    assert any("statement" in stage for stage in seen)


def test_run_session_stuck_starting_raises_start_timeout():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.STARTING}],  # never becomes idle
        log=["waiting for capacity", "still waiting"],
    )
    client = _client_with(transport)
    # Zero start budget + a clock that always advances so the deadline trips immediately.
    ticks = iter([0.0, 100.0, 200.0, 300.0, 400.0])
    monitor = _monitor(
        client,
        session_start_timeout_s=1.0,
        monotonic=lambda: next(ticks),
    )
    with pytest.raises(LivyStartTimeout) as exc:
        monitor.run("print('mp')")
    assert "did not start" in str(exc.value)
    assert "still waiting" in str(exc.value)  # driver log tail included for troubleshooting
    assert transport.deleted is True  # still cleaned up


def test_run_dead_session_reports_failure_via_start_timeout():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.DEAD}],
        log=["OOMKilled"],
    )
    client = _client_with(transport)
    monitor = _monitor(client)
    with pytest.raises(LivyStartTimeout) as exc:
        monitor.run("print('mp')")
    assert "dead" in str(exc.value).lower()


def test_run_statement_error_returns_failed_status_with_diagnostics():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.IDLE}],
        statement_states=[
            {
                "state": LivyStatementState.AVAILABLE,
                "output": {
                    "status": "error",
                    "ename": "RuntimeError",
                    "evalue": "spark exploded",
                    "traceback": ["frame a", "frame b"],
                },
            }
        ],
    )
    client = _client_with(transport)
    monitor = _monitor(client)
    status, diag = monitor.run("print('mp')")
    assert status.job_status == JobStatus.FAILED
    assert "spark exploded" in (status.error_message or "")
    assert diag.error_traceback == ["frame a", "frame b"]


def test_statement_timeout_cancels_and_raises():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.BUSY}],
        statement_states=[{"state": LivyStatementState.RUNNING, "progress": 0.1}],  # never finishes
    )
    client = _client_with(transport)
    ticks = iter([0.0, 0.0, 100.0, 200.0, 300.0])
    monitor = _monitor(
        client,
        statement_timeout_s=1.0,
        monotonic=lambda: next(ticks),
    )
    with pytest.raises(LivyStatementTimeout):
        monitor.await_statement(7, 1)
    assert transport.cancelled is True


def test_statement_timeout_captures_diagnostics_in_message():
    # On timeout the monitor must grab the driver log tail *before* the caller deletes
    # the session, so troubleshooting detail survives.
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.BUSY}],
        statement_states=[{"state": LivyStatementState.RUNNING, "progress": 0.1}],
        log=["reading signal", "stuck on shuffle stage"],
    )
    client = _client_with(transport)
    ticks = iter([0.0, 0.0, 100.0, 200.0, 300.0, 400.0])
    monitor = _monitor(
        client,
        statement_timeout_s=1.0,
        monotonic=lambda: next(ticks),
    )
    with pytest.raises(LivyStatementTimeout) as exc:
        monitor.await_statement(7, 1)
    assert "stuck on shuffle stage" in str(exc.value)  # log tail preserved
    assert transport.cancelled is True


def test_run_enforces_overall_max_runtime_during_session_start():
    # A session that keeps "starting" past the overall budget must abort even if the
    # per-phase start timeout is generous.
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.STARTING}],
        log=["still starting"],
    )
    client = _client_with(transport)
    ticks = iter([0.0, 100.0, 200.0, 300.0, 400.0, 500.0])
    monitor = _monitor(
        client,
        session_start_timeout_s=10_000.0,  # huge per-phase budget
        max_runtime_s=1.0,                 # tiny overall budget
        monotonic=lambda: next(ticks),
    )
    with pytest.raises(LivyStartTimeout):
        monitor.run("print('mp')")
    assert transport.deleted is True


def test_await_statement_respects_overall_deadline():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.BUSY}],
        statement_states=[{"state": LivyStatementState.RUNNING, "progress": 0.1}],
    )
    client = _client_with(transport)
    ticks = iter([0.0, 0.0, 100.0, 200.0, 300.0])
    monitor = _monitor(
        client,
        statement_timeout_s=10_000.0,  # huge per-phase budget
        monotonic=lambda: next(ticks),
    )
    # An overall_deadline in the near past forces the loop to abort promptly.
    with pytest.raises(LivyStatementTimeout):
        monitor.await_statement(7, 1, overall_deadline=1.0)
    assert transport.cancelled is True


def test_diagnose_collects_troubleshooting_detail():
    transport = FakeLivyTransport(
        session_states=[{"state": LivySessionState.ERROR}],
        statement_states=[
            {
                "state": LivyStatementState.ERROR,
                "output": {
                    "status": "error",
                    "ename": "ValueError",
                    "evalue": "bad window",
                    "traceback": ["t1"],
                },
            }
        ],
        log=["line1", "line2", "line3"],
    )
    client = _client_with(transport)
    monitor = _monitor(client)
    diag = monitor.diagnose(7, 1)
    assert diag.session_id == "7"
    assert diag.statement_id == "1"
    assert diag.spark_app_id == "app-99"
    assert diag.driver_log_tail == ["line1", "line2", "line3"]
    assert "ValueError: bad window" == diag.error_message
    assert diag.error_traceback == ["t1"]


def test_diagnose_never_raises_on_broken_client():
    client = FabricLivyClient("ws", "lh", token="t")

    def boom(*_a, **_k):
        raise RuntimeError("network down")

    client.get_session = boom  # type: ignore[assignment]
    client.get_session_log = boom  # type: ignore[assignment]
    monitor = _monitor(client)
    diag = monitor.diagnose(7)
    assert diag.session_id == "7"
    assert "network down" in (diag.error_message or "")


def test_livy_root_url_shape():
    client = FabricLivyClient("WS", "LH", token="t")
    assert client._livy_root.endswith(
        "/workspaces/WS/lakehouses/LH/livyApi/versions/2023-12-01"
    )


def test_list_sessions_gets_sessions_endpoint():
    client = FabricLivyClient("WS", "LH", token="t")
    captured = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"from": 0, "total": 2, "sessions": [{"id": 1}, {"id": 2}]}

    class _Requests:
        @staticmethod
        def get(url, headers=None, timeout=None):
            captured["url"] = url
            captured["headers"] = headers
            return _Resp()

    client._requests = lambda: _Requests  # type: ignore[assignment]
    doc = client.list_sessions()
    assert doc["total"] == 2
    assert captured["url"].endswith(
        "/workspaces/WS/lakehouses/LH/livyApi/versions/2023-12-01/sessions"
    )
    assert captured["headers"]["Authorization"] == "Bearer t"


# --------------------------------------------------------------------------- callback bridge
def test_build_status_callback_running_streams_progress_and_ids():
    status = LivyStatus(
        job_status=JobStatus.RUNNING,
        stage="statement:running",
        message="Analyzing…",
        progress_pct=40.0,
    )
    diag = LivyDiagnostics(
        session_id="7", statement_id="1", session_state="busy", spark_app_id="app-1",
        spark_ui_url="https://ui",
    )
    body = build_status_callback("job-1", status, diag)
    patch = body["variables"]["patch"]
    assert patch["status"] == JobStatus.RUNNING
    assert patch["progressPct"] == 40.0
    assert patch["stage"] == "statement:running"
    assert patch["livySessionId"] == "7"
    assert patch["sparkUiUrl"] == "https://ui"


def test_build_status_callback_terminal_uses_completion_with_diagnostics():
    status = LivyStatus(
        job_status=JobStatus.FAILED,
        stage="session:dead",
        message="died",
        is_terminal=True,
        error_message="OOM",
    )
    diag = LivyDiagnostics(
        session_state="dead", driver_log_tail=["a", "b"], spark_ui_url="https://ui"
    )
    body = build_status_callback("job-1", status, diag)
    patch = body["variables"]["patch"]
    assert patch["status"] == JobStatus.FAILED
    assert patch["errorMessage"] == "OOM"
    assert patch["driverLogTail"] == "a\nb"
    assert patch["livyState"] == "dead"


def test_build_status_callback_without_diagnostics_is_safe():
    status = LivyStatus(
        job_status=JobStatus.QUEUED, stage="session:starting", message="waiting"
    )
    body = build_status_callback("job-1", status)
    assert body["variables"]["patch"]["status"] == JobStatus.QUEUED
