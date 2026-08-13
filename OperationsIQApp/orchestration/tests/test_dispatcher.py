"""Tests for the Livy job dispatcher (:mod:`orchestration.dispatcher`).

The dispatcher's network edges (Rayfin GraphQL + Fabric Livy) are replaced with in-memory
fakes so the whole claim -> build -> run -> callback flow is exercised without a live
cluster. The pure builders (params/payload/code) are tested directly.
"""
from __future__ import annotations

import base64
import json
from typing import List, Optional

import pytest

from orchestration.dispatcher import (
    ControlPlaneClient,
    DispatcherConfig,
    JobDispatcher,
    SourceMapping,
    build_job_payload,
    build_livy_code,
    parse_params,
    run_preflight,
)
from orchestration.fabric_livy import LivyDiagnostics, LivyStatus
from orchestration.state_machine import JobStatus


# --------------------------------------------------------------------------- fixtures
def _config(**kwargs) -> DispatcherConfig:
    defaults = dict(
        workspace_id="ws-1",
        lakehouse_id="lh-1",
        graphql_url="https://rayfin.example/api/graphql",
        poll_interval_s=0.0,
    )
    defaults.update(kwargs)
    return DispatcherConfig(**defaults)


def _source() -> SourceMapping:
    return SourceMapping(
        kql_cluster_uri="https://kusto.example",
        database="db",
        table="Timeseries",
        time_column="Timestamp",
        value_column="Value",
        tag_column="TagId",
    )


def _job(**kwargs) -> dict:
    job = {
        "id": "job-1",
        "name": "Repeating patterns",
        "signal_id": "pump-3-vib",
        "type": "MOTIF_MOMP",
        "windowStart": "2024-01-01T00:00:00Z",
        "windowEnd": "2024-01-07T00:00:00Z",
        "subLen": 128,
        "params": None,
        "status": "QUEUED",
    }
    job.update(kwargs)
    return job


# --------------------------------------------------------------------------- pure builders
def test_parse_params_tolerates_null_blank_and_bad_json():
    assert parse_params(None) == {}
    assert parse_params("") == {}
    assert parse_params("not json") == {}
    assert parse_params("[1,2,3]") == {}  # non-dict JSON
    assert parse_params('{"k": 3}') == {"k": 3}


def test_build_job_payload_maps_columns_and_source():
    source = _source().to_source_dict("pump-3-vib", "2024-01-01T00:00:00Z", "2024-01-07T00:00:00Z")
    payload = build_job_payload(_job(), source)
    assert payload["jobId"] == "job-1"
    assert payload["type"] == "MOTIF_MOMP"
    assert payload["subLen"] == 128
    assert payload["source"]["table"] == "Timeseries"
    assert payload["source"]["tagColumn"] == "TagId"
    assert payload["source"]["tag"] == "pump-3-vib"
    assert payload["source"]["windowStart"] == "2024-01-01T00:00:00Z"


def test_build_job_payload_pulls_optional_knobs_from_params():
    job = _job(subLen=None, params=json.dumps({"k": 3, "minlag": 50, "includeProfile": True, "nBlocks": 8, "m": 64}))
    source = _source().to_source_dict("t", None, None)
    payload = build_job_payload(job, source)
    # subLen falls back to params.m when the column is null (e.g. PAN_MP or param-driven).
    assert payload["subLen"] == 64
    assert payload["k"] == 3
    assert payload["minlag"] == 50
    assert payload["includeProfile"] is True
    assert payload["nBlocks"] == 8


def test_source_mapping_omits_tag_when_no_tag_column():
    source = SourceMapping(
        kql_cluster_uri="c", database="d", table="t",
        time_column="ts", value_column="v",
    ).to_source_dict("sig", None, None)
    assert "tag" not in source and "tagColumn" not in source


def test_build_livy_code_roundtrips_payload_via_base64():
    payload = {"jobId": "job-1", "type": "MOTIF_MOMP", "source": {"table": 'T"weird'}}
    code = build_livy_code(payload)
    assert "run_and_print" in code
    # Recover the embedded payload the same way the statement will.
    encoded = code.split('b64decode("')[1].split('")')[0]
    recovered = json.loads(base64.b64decode(encoded).decode("utf-8"))
    assert recovered == payload


# --------------------------------------------------------------------------- fakes
class FakeControlPlane:
    """Records claims + posted callbacks; serves a scripted queue of jobs."""

    def __init__(self, jobs: Optional[List[dict]] = None, claim_ok: bool = True) -> None:
        self._jobs = list(jobs or [])
        self.claim_ok = claim_ok
        self.claimed: List[str] = []
        self.posted: List[dict] = []

    def list_queued_jobs(self) -> List[dict]:
        return [j for j in self._jobs if j.get("status") == JobStatus.QUEUED]

    def claim_job(self, job_id: str) -> bool:
        if self.claim_ok:
            self.claimed.append(job_id)
            for j in self._jobs:
                if j["id"] == job_id:
                    j["status"] = JobStatus.RUNNING
        return self.claim_ok

    def post_callback(self, body: dict) -> None:
        self.posted.append(body["variables"]["patch"])


class FakeMonitor:
    """Stand-in for LivyJobMonitor.run: streams scripted statuses then returns terminal."""

    def __init__(self, stream: List[LivyStatus], terminal: LivyStatus, diag: LivyDiagnostics,
                 raise_exc: Optional[Exception] = None) -> None:
        self._stream = stream
        self._terminal = terminal
        self._diag = diag
        self._raise = raise_exc
        self.run_code: Optional[str] = None
        self.session_config: Optional[dict] = None

    def run(self, code, *, session_config=None, on_status=None, **_kw):
        self.run_code = code
        self.session_config = session_config
        if self._raise is not None:
            raise self._raise
        if on_status is not None:
            for s in self._stream:
                on_status(s)
            on_status(self._terminal)
        return self._terminal, self._diag


def _dispatcher(control_plane, monitor: FakeMonitor, **kwargs) -> JobDispatcher:
    return JobDispatcher(
        _config(),
        control_plane,
        _source(),
        livy_client_factory=lambda: object(),
        monitor_factory=lambda _client: monitor,
        sleep=lambda _s: None,
        log=lambda _m: None,
        **kwargs,
    )


# --------------------------------------------------------------------------- dispatch flow
def test_dispatch_job_streams_progress_then_posts_terminal_with_diagnostics():
    cp = FakeControlPlane()
    running = LivyStatus(job_status=JobStatus.RUNNING, stage="statement:running",
                         message="Analyzing…", progress_pct=40.0)
    terminal = LivyStatus(job_status=JobStatus.SUCCEEDED, stage="statement:available",
                          message="Analysis complete.", progress_pct=100.0, is_terminal=True)
    diag = LivyDiagnostics(session_id="7", statement_id="1", session_state="idle",
                           spark_ui_url="https://ui", driver_log_tail=["ok"])
    monitor = FakeMonitor(stream=[running], terminal=terminal, diag=diag)

    status = _dispatcher(cp, monitor).dispatch_job(_job())

    assert status.job_status == JobStatus.SUCCEEDED
    # A running progress update was streamed, and the final post carried the diagnostics.
    assert any(p.get("stage") == "statement:running" for p in cp.posted)
    final = cp.posted[-1]
    assert final["status"] == JobStatus.SUCCEEDED
    # Terminal completion carries diagnostics (final Livy state) for the troubleshooting panel.
    assert final.get("livyState") == "idle"
    # The Livy statement embedded the job payload.
    assert "run_and_print" in monitor.run_code


def test_dispatch_job_passes_environment_conf_when_configured():
    cp = FakeControlPlane()
    terminal = LivyStatus(job_status=JobStatus.SUCCEEDED, stage="statement:available",
                          message="done", progress_pct=100.0, is_terminal=True)
    monitor = FakeMonitor(stream=[], terminal=terminal, diag=LivyDiagnostics())
    dispatcher = JobDispatcher(
        _config(environment_id="env-42"),
        cp, _source(),
        livy_client_factory=lambda: object(),
        monitor_factory=lambda _c: monitor,
        sleep=lambda _s: None, log=lambda _m: None,
    )
    dispatcher.dispatch_job(_job())
    conf = monitor.session_config["conf"]["spark.fabric.environmentDetails"]
    assert json.loads(conf) == {"id": "env-42"}


def test_dispatch_job_reports_failure_on_monitor_exception():
    cp = FakeControlPlane()
    monitor = FakeMonitor(stream=[], terminal=LivyStatus(JobStatus.SUCCEEDED, "", ""),
                          diag=LivyDiagnostics(), raise_exc=RuntimeError("livy start timeout"))
    status = _dispatcher(cp, monitor).dispatch_job(_job())
    assert status.job_status == JobStatus.FAILED
    assert "livy start timeout" in (status.error_message or "")
    # A FAILED completion callback was posted so the UI stops "waiting" forever.
    assert cp.posted[-1]["status"] == JobStatus.FAILED
    assert "livy start timeout" in cp.posted[-1]["errorMessage"]


def test_dispatch_job_survives_callback_post_failure():
    class FlakyCP(FakeControlPlane):
        def post_callback(self, body):
            raise RuntimeError("network blip")

    cp = FlakyCP()
    terminal = LivyStatus(JobStatus.SUCCEEDED, "statement:available", "done",
                          progress_pct=100.0, is_terminal=True)
    monitor = FakeMonitor(stream=[], terminal=terminal, diag=LivyDiagnostics())
    # Should not raise even though every callback POST fails.
    status = _dispatcher(cp, monitor).dispatch_job(_job())
    assert status.job_status == JobStatus.SUCCEEDED


# --------------------------------------------------------------------------- poll loop
def test_poll_once_claims_and_dispatches_only_queued_jobs():
    jobs = [_job(id="a"), _job(id="b"), _job(id="c", status="RUNNING")]
    cp = FakeControlPlane(jobs=jobs)
    terminal = LivyStatus(JobStatus.SUCCEEDED, "statement:available", "done",
                          progress_pct=100.0, is_terminal=True)
    monitor = FakeMonitor(stream=[], terminal=terminal, diag=LivyDiagnostics())
    dispatched = _dispatcher(cp, monitor).poll_once()
    assert dispatched == 2
    assert set(cp.claimed) == {"a", "b"}


def test_poll_once_skips_jobs_it_cannot_claim():
    cp = FakeControlPlane(jobs=[_job(id="a")], claim_ok=False)
    terminal = LivyStatus(JobStatus.SUCCEEDED, "s", "d", progress_pct=100.0, is_terminal=True)
    monitor = FakeMonitor(stream=[], terminal=terminal, diag=LivyDiagnostics())
    assert _dispatcher(cp, monitor).poll_once() == 0


def test_run_forever_honours_max_iterations():
    cp = FakeControlPlane(jobs=[])
    monitor = FakeMonitor(stream=[], terminal=LivyStatus(JobStatus.SUCCEEDED, "", ""),
                          diag=LivyDiagnostics())
    calls = {"n": 0}

    dispatcher = _dispatcher(cp, monitor)
    orig = dispatcher.poll_once

    def counting():
        calls["n"] += 1
        return orig()

    dispatcher.poll_once = counting  # type: ignore[assignment]
    dispatcher.run_forever(max_iterations=3)
    assert calls["n"] == 3


def test_dispatcher_requires_token_or_client_factory():
    with pytest.raises(ValueError):
        JobDispatcher(_config(), FakeControlPlane(), _source())


# --------------------------------------------------------------------------- control-plane client
class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._payload


def test_control_plane_list_queued_filters_status(monkeypatch):
    client = ControlPlaneClient("https://x/graphql", token="t")
    captured = {}

    class _Requests:
        @staticmethod
        def post(url, headers=None, json=None, timeout=None):
            captured["url"] = url
            captured["auth"] = headers["Authorization"]
            return _FakeResp({"data": {"analysisJobs": [
                {"id": "a", "status": "QUEUED"},
                {"id": "b", "status": "RUNNING"},
                {"id": "c", "status": "QUEUED"},
            ]}})

    monkeypatch.setattr(ControlPlaneClient, "_requests", staticmethod(lambda: _Requests))
    queued = client.list_queued_jobs()
    assert [j["id"] for j in queued] == ["a", "c"]
    assert captured["auth"] == "Bearer t"


def test_control_plane_execute_raises_on_graphql_errors(monkeypatch):
    client = ControlPlaneClient("https://x/graphql", token="t")

    class _Requests:
        @staticmethod
        def post(url, headers=None, json=None, timeout=None):
            return _FakeResp({"errors": [{"message": "boom"}]})

    monkeypatch.setattr(ControlPlaneClient, "_requests", staticmethod(lambda: _Requests))
    with pytest.raises(RuntimeError) as exc:
        client.execute("query { x }")
    assert "boom" in str(exc.value)


def test_control_plane_claim_job_posts_running_patch(monkeypatch):
    client = ControlPlaneClient("https://x/graphql", token="t")
    posted = {}

    class _Requests:
        @staticmethod
        def post(url, headers=None, json=None, timeout=None):
            posted["variables"] = json["variables"]
            return _FakeResp({"data": {"updateAnalysisJob": {"id": "job-1"}}})

    monkeypatch.setattr(ControlPlaneClient, "_requests", staticmethod(lambda: _Requests))
    assert client.claim_job("job-1") is True
    assert posted["variables"]["patch"]["status"] == JobStatus.RUNNING


def test_control_plane_claim_job_returns_false_on_error(monkeypatch):
    client = ControlPlaneClient("https://x/graphql", token="t")

    class _Requests:
        @staticmethod
        def post(url, headers=None, json=None, timeout=None):
            return _FakeResp({"errors": [{"message": "conflict"}]})

    monkeypatch.setattr(ControlPlaneClient, "_requests", staticmethod(lambda: _Requests))
    assert client.claim_job("job-1") is False


# --------------------------------------------------------------------------- config from env
def test_config_from_env_reads_required_and_defaults():
    env = {
        "FABRIC_WORKSPACE_ID": "ws",
        "FABRIC_LAKEHOUSE_ID": "lh",
        "RAYFIN_GRAPHQL_URL": "https://x/graphql",
        "FABRIC_ENVIRONMENT_ID": "env-1",
        "DISPATCHER_POLL_INTERVAL_S": "5",
    }
    cfg = DispatcherConfig.from_env(env)
    assert cfg.workspace_id == "ws"
    assert cfg.environment_id == "env-1"
    assert cfg.poll_interval_s == 5.0
    assert cfg.max_runtime_s == 7200.0  # default


def test_config_from_env_raises_on_missing_required():
    with pytest.raises(RuntimeError) as exc:
        DispatcherConfig.from_env({"FABRIC_WORKSPACE_ID": "ws"})
    assert "FABRIC_LAKEHOUSE_ID" in str(exc.value)


def test_source_mapping_from_env():
    env = {
        "TSMP_KQL_CLUSTER_URI": "https://kusto",
        "TSMP_KQL_DATABASE": "db",
        "TSMP_SOURCE_TABLE": "Timeseries",
        "TSMP_TAG_COLUMN": "TagId",
    }
    src = SourceMapping.from_env(env)
    assert src.kql_cluster_uri == "https://kusto"
    assert src.tag_column == "TagId"
    assert src.time_column == "Timestamp"  # default


# --------------------------------------------------------------------------- preflight
class FakeLivyForPreflight:
    """Livy client stand-in whose list_sessions either returns a doc or raises."""

    def __init__(self, doc=None, error: Optional[Exception] = None) -> None:
        self._doc = doc if doc is not None else {"from": 0, "total": 0, "sessions": []}
        self._error = error

    def list_sessions(self) -> dict:
        if self._error is not None:
            raise self._error
        return self._doc


def _preflight_cp(jobs=None, error: Optional[Exception] = None):
    cp = FakeControlPlane(jobs=jobs or [])
    if error is not None:
        def _boom() -> List[dict]:
            raise error
        cp.list_queued_jobs = _boom  # type: ignore[assignment]
    return cp


def _names(results):
    return {r.name: r for r in results}


def test_preflight_all_pass_reports_queue_depth():
    cp = _preflight_cp(jobs=[_job(id="a"), _job(id="b")])
    logs: List[str] = []
    results = run_preflight(
        _config(),
        _source(),
        cp,
        fabric_token="a-token",
        livy_client_factory=lambda: FakeLivyForPreflight(
            {"total": 1, "sessions": [{"id": 1}]}
        ),
        log=logs.append,
    )
    by = _names(results)
    assert all(r.ok for r in results)
    assert by["fabric-token"].ok
    assert "1 live session" in by["livy"].detail
    assert "2 QUEUED" in by["control-plane"].detail
    assert any("all checks passed" in line for line in logs)


def test_preflight_flags_bad_token_and_still_probes_control_plane():
    def _bad_token() -> str:
        raise RuntimeError("AADSTS7000215 invalid client secret")

    cp = _preflight_cp(jobs=[])
    results = run_preflight(
        _config(),
        _source(),
        cp,
        fabric_token=_bad_token,
        # Livy factory not supplied: with a failing token we still want a livy FAIL, but
        # since no factory is given and the token is the thing under test, provide one that
        # would succeed to prove the token check is independent.
        livy_client_factory=lambda: FakeLivyForPreflight(),
        log=lambda _m: None,
    )
    by = _names(results)
    assert by["fabric-token"].ok is False
    assert "invalid client secret" in by["fabric-token"].detail
    # The control-plane probe still runs regardless of the token failure.
    assert by["control-plane"].ok is True


def test_preflight_livy_failure_gives_scope_hint():
    cp = _preflight_cp(jobs=[])
    results = run_preflight(
        _config(),
        _source(),
        cp,
        fabric_token="tok",
        livy_client_factory=lambda: FakeLivyForPreflight(
            error=RuntimeError("403 Forbidden")
        ),
        log=lambda _m: None,
    )
    by = _names(results)
    assert by["livy"].ok is False
    assert "403" in by["livy"].detail
    assert "Lakehouse.Execute.All" in by["livy"].detail


def test_preflight_control_plane_failure_flags_query_name():
    cp = _preflight_cp(error=RuntimeError("Cannot query field 'analysisJobs'"))
    results = run_preflight(
        _config(),
        _source(),
        cp,
        fabric_token="tok",
        livy_client_factory=lambda: FakeLivyForPreflight(),
        log=lambda _m: None,
    )
    by = _names(results)
    assert by["control-plane"].ok is False
    assert "analysisJobs" in by["control-plane"].detail


def test_preflight_config_check_flags_incomplete_source():
    incomplete = SourceMapping(
        kql_cluster_uri="https://kusto",
        database="",
        table="",
        time_column="Timestamp",
        value_column="Value",
    )
    results = run_preflight(
        _config(),
        incomplete,
        _preflight_cp(jobs=[]),
        fabric_token="tok",
        livy_client_factory=lambda: FakeLivyForPreflight(),
        log=lambda _m: None,
    )
    by = _names(results)
    assert by["config"].ok is False
    assert "TSMP_KQL_DATABASE" in by["config"].detail
    assert "TSMP_SOURCE_TABLE" in by["config"].detail


def test_poll_once_logs_queue_and_dispatch_counts():
    cp = FakeControlPlane(jobs=[_job(id="a")])
    terminal = LivyStatus(JobStatus.SUCCEEDED, "s", "d", progress_pct=100.0, is_terminal=True)
    monitor = FakeMonitor(stream=[], terminal=terminal, diag=LivyDiagnostics())
    logs: List[str] = []
    JobDispatcher(
        _config(),
        cp,
        _source(),
        livy_client_factory=lambda: object(),
        monitor_factory=lambda _client: monitor,
        sleep=lambda _s: None,
        log=logs.append,
    ).poll_once()
    assert any("poll: 1 queued, 1 dispatched" in line for line in logs)
