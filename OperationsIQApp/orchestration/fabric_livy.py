"""Fabric **Livy** session dispatch + transparent monitoring (design spec §4, §8).

This is the Livy-based sibling of :mod:`orchestration.fabric_spark`. Where
``fabric_spark`` triggers a *Spark Job Definition* run, this module drives the Fabric
**Livy REST endpoint** directly: it creates an interactive Spark **session**, submits the
MOMP/DAMP analysis as a **statement**, and then reports *transparent, granular* status the
whole way through.

Why this module exists
----------------------
Jobs submitted from the Patterns tab were getting stuck in a "waiting" state forever with
no visible progress. The usual root cause is a Livy **session that never leaves
``starting``/``not_started``** (no capacity, a bad payload, a pool that won't spin up) —
and nothing was watching for it. This module fixes that with:

* a **pure** :func:`interpret_livy_status` that turns raw Livy session/statement documents
  into the app's ``QUEUED/RUNNING/SUCCEEDED/FAILED`` state plus a human-readable stage and
  message — so it is fully unit-testable without a live cluster;
* a :class:`LivyJobMonitor` poll loop with an explicit **session-start timeout** (so a
  session that never becomes ``idle`` fails fast with a clear reason instead of hanging),
  a statement timeout, and an overall max-runtime guard; and
* first-class **troubleshooting**: :class:`LivyDiagnostics` bundles the session id, Spark
  application id, current state, the tail of the driver log, and any statement error
  traceback, and :meth:`LivyJobMonitor.diagnose` gathers it on demand.

Only the network shell lazily imports ``requests``; importing this module stays
dependency-free, exactly like ``fabric_spark``.

References
----------
- Fabric REST — Livy sessions: POST/GET ``.../livyApi/versions/2023-12-01/sessions``
- Livy statements:            POST/GET ``.../sessions/{id}/statements``
- Livy session log:           GET      ``.../sessions/{id}/log``
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence, Union

from orchestration.state_machine import JobStatus

_FABRIC_BASE = "https://api.fabric.microsoft.com/v1"
_LIVY_API_VERSION = "2023-12-01"

# ---------------------------------------------------------------------------
# Livy state vocabulary (see Livy docs). Kept as plain string constants + sets so the
# interpretation logic below is a pure, table-driven mapping that tests can pin exactly.
# ---------------------------------------------------------------------------


class LivySessionState:
    NOT_STARTED = "not_started"
    STARTING = "starting"
    IDLE = "idle"
    BUSY = "busy"
    SHUTTING_DOWN = "shutting_down"
    ERROR = "error"
    DEAD = "dead"
    KILLED = "killed"
    SUCCESS = "success"
    RECOVERING = "recovering"


class LivyStatementState:
    WAITING = "waiting"
    RUNNING = "running"
    AVAILABLE = "available"
    ERROR = "error"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"


# The session is still spinning up — nothing is running yet. This is the state that used
# to hang forever, so it gets its own bucket and an explicit start timeout.
_SESSION_STARTING = frozenset(
    {LivySessionState.NOT_STARTED, LivySessionState.STARTING, LivySessionState.RECOVERING}
)
# The session is alive and can run / is running statements.
_SESSION_READY = frozenset({LivySessionState.IDLE, LivySessionState.BUSY})
# The session died before / during the work.
_SESSION_FAILED = frozenset(
    {LivySessionState.ERROR, LivySessionState.DEAD, LivySessionState.KILLED}
)
# The session has ended/closed. If the analysis statement has not already produced a
# successful result by now, the session ended too early and the job cannot complete.
_SESSION_ENDED = frozenset(
    {LivySessionState.SHUTTING_DOWN, LivySessionState.SUCCESS}
)

_STATEMENT_RUNNING = frozenset({LivyStatementState.WAITING, LivyStatementState.RUNNING})
_STATEMENT_FAILED = frozenset(
    {LivyStatementState.ERROR, LivyStatementState.CANCELLED, LivyStatementState.CANCELLING}
)

TokenLike = Union[str, Callable[[], str]]


def _resolve_token(token: TokenLike) -> str:
    return token() if callable(token) else token


# ---------------------------------------------------------------------------
# Pure status interpretation + diagnostics (no network — unit-testable).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LivyStatus:
    """A transparent snapshot of where a Livy-backed job is right now.

    ``job_status`` is the app's coarse state machine value; ``stage`` and ``message`` give
    the user a plain-language "why is this still waiting?" answer; ``progress_pct`` is a
    best-effort hint (Livy has no native percentage, so this is coarse but honest).
    """

    job_status: str
    stage: str
    message: str
    progress_pct: float = 0.0
    is_terminal: bool = False
    error_message: Optional[str] = None


@dataclass
class LivyDiagnostics:
    """Everything a user/operator needs to troubleshoot a submitted Livy session."""

    session_id: Optional[str] = None
    statement_id: Optional[str] = None
    session_state: Optional[str] = None
    statement_state: Optional[str] = None
    spark_app_id: Optional[str] = None
    spark_ui_url: Optional[str] = None
    driver_log_tail: List[str] = field(default_factory=list)
    error_message: Optional[str] = None
    error_traceback: List[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "sessionId": self.session_id,
            "statementId": self.statement_id,
            "sessionState": self.session_state,
            "statementState": self.statement_state,
            "sparkAppId": self.spark_app_id,
            "sparkUiUrl": self.spark_ui_url,
            "driverLogTail": list(self.driver_log_tail),
            "errorMessage": self.error_message,
            "errorTraceback": list(self.error_traceback),
        }


def _statement_error(statement_doc: dict) -> Optional[tuple[str, List[str]]]:
    """Pull an (error message, traceback) pair out of a Livy statement output block."""
    output = statement_doc.get("output") or {}
    if output.get("status") == "error" or statement_doc.get("state") == LivyStatementState.ERROR:
        ename = output.get("ename") or "Error"
        evalue = output.get("evalue") or statement_doc.get("state") or "statement failed"
        traceback = output.get("traceback") or []
        if not isinstance(traceback, list):
            traceback = [str(traceback)]
        return f"{ename}: {evalue}".strip(), [str(line) for line in traceback]
    return None


def interpret_livy_status(
    session_doc: Optional[dict],
    statement_doc: Optional[dict] = None,
) -> LivyStatus:
    """Map raw Livy session/statement documents to a transparent :class:`LivyStatus`.

    Pure and defensive: unknown/missing fields degrade to an informative "unknown" status
    rather than raising, because a monitor must never crash on a surprising payload.
    """
    if not session_doc:
        return LivyStatus(
            job_status=JobStatus.QUEUED,
            stage="submitting",
            message="Submitting the analysis to Spark…",
        )

    session_state = str(session_doc.get("state", "")).lower()

    # 1. Session still spinning up — the classic "stuck waiting" case.
    if session_state in _SESSION_STARTING:
        return LivyStatus(
            job_status=JobStatus.QUEUED,
            stage=f"session:{session_state}",
            message="Waiting for a Spark session to start (acquiring capacity)…",
            progress_pct=0.0,
        )

    # 2. Session failed to start / died.
    if session_state in _SESSION_FAILED:
        err = _session_failure_message(session_doc, session_state)
        return LivyStatus(
            job_status=JobStatus.FAILED,
            stage=f"session:{session_state}",
            message=f"The Spark session {session_state} before the analysis finished.",
            is_terminal=True,
            error_message=err,
        )

    # 3. Session is alive — now the statement drives the status.
    if statement_doc:
        statement_state = str(statement_doc.get("state", "")).lower()

        if statement_state == LivyStatementState.AVAILABLE:
            err = _statement_error(statement_doc)
            if err is not None:
                message, traceback = err
                return LivyStatus(
                    job_status=JobStatus.FAILED,
                    stage="statement:error",
                    message="The analysis ran but reported an error.",
                    is_terminal=True,
                    error_message="\n".join([message, *traceback]).strip(),
                )
            return LivyStatus(
                job_status=JobStatus.SUCCEEDED,
                stage="statement:available",
                message="Analysis complete.",
                progress_pct=100.0,
                is_terminal=True,
            )

        if statement_state in _STATEMENT_FAILED:
            err = _statement_error(statement_doc)
            error_message = None
            if err is not None:
                message, traceback = err
                error_message = "\n".join([message, *traceback]).strip()
            terminal = statement_state == LivyStatementState.CANCELLED
            return LivyStatus(
                job_status=JobStatus.FAILED if statement_state == LivyStatementState.ERROR
                else JobStatus.CANCELLED if terminal else JobStatus.RUNNING,
                stage=f"statement:{statement_state}",
                message="The analysis was cancelled."
                if terminal
                else "The analysis reported an error." if statement_state == LivyStatementState.ERROR
                else "Cancelling the analysis…",
                is_terminal=statement_state in (LivyStatementState.ERROR, LivyStatementState.CANCELLED),
                error_message=error_message,
            )

        if statement_state in _STATEMENT_RUNNING:
            # A statement still "running" while the session has already ended means the
            # session closed out from under the analysis — treat it as a terminal failure
            # rather than reporting perpetual progress.
            if session_state in _SESSION_ENDED:
                return LivyStatus(
                    job_status=JobStatus.FAILED,
                    stage=f"session:{session_state}",
                    message="The Spark session ended before the analysis finished.",
                    is_terminal=True,
                    error_message=_session_failure_message(session_doc, session_state),
                )
            pct = _statement_progress(statement_doc)
            waiting = statement_state == LivyStatementState.WAITING
            return LivyStatus(
                job_status=JobStatus.RUNNING,
                stage=f"statement:{statement_state}",
                message="Queued behind another statement on this session…"
                if waiting
                else "Analyzing the signal on Spark…",
                progress_pct=pct,
            )

    # 4. Session ready but no statement yet (or an unrecognized statement state).
    if session_state in _SESSION_READY:
        return LivyStatus(
            job_status=JobStatus.RUNNING,
            stage=f"session:{session_state}",
            message="Spark session ready — starting the analysis…",
            progress_pct=1.0,
        )

    # 5. Session ended/closed without a completed statement — cannot finish the job.
    if session_state in _SESSION_ENDED:
        return LivyStatus(
            job_status=JobStatus.FAILED,
            stage=f"session:{session_state}",
            message="The Spark session ended before the analysis produced a result.",
            is_terminal=True,
            error_message=_session_failure_message(session_doc, session_state),
        )

    return LivyStatus(
        job_status=JobStatus.QUEUED,
        stage=f"session:{session_state or 'unknown'}",
        message="Waiting on the Spark session…",
    )


def _statement_progress(statement_doc: dict) -> float:
    """Best-effort statement progress in 0..100 (Livy reports 0..1 when available)."""
    raw = statement_doc.get("progress")
    try:
        pct = float(raw) * 100.0 if raw is not None else 0.0
    except (TypeError, ValueError):
        pct = 0.0
    return max(0.0, min(100.0, pct))


def _session_failure_message(session_doc: dict, session_state: str) -> str:
    log = session_doc.get("log")
    if isinstance(log, list) and log:
        tail = "\n".join(str(line) for line in log[-8:])
        return f"Spark session {session_state}. Last log lines:\n{tail}"
    return f"Spark session {session_state}."


# ---------------------------------------------------------------------------
# Network client + monitor.
# ---------------------------------------------------------------------------


class LivyStartTimeout(TimeoutError):
    """Raised when a Livy session never leaves the starting state in time."""


class LivyStatementTimeout(TimeoutError):
    """Raised when a running statement exceeds its wall-clock budget."""


class FabricLivyClient:
    """Submit and monitor a Fabric Livy interactive session + statement.

    Parameters
    ----------
    workspace_id, lakehouse_id:
        Identify the Fabric workspace and the Lakehouse whose Livy endpoint runs the
        session.
    token:
        Bearer string or a zero-arg callable returning one (so it can refresh).
    base_url:
        Override for sovereign clouds / testing.
    """

    def __init__(
        self,
        workspace_id: str,
        lakehouse_id: str,
        token: TokenLike,
        base_url: str = _FABRIC_BASE,
        api_version: str = _LIVY_API_VERSION,
    ) -> None:
        self.workspace_id = workspace_id
        self.lakehouse_id = lakehouse_id
        self._token = token
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version

    # -- lazily import requests so importing the package stays dependency-free -------
    @staticmethod
    def _requests():
        import requests  # noqa: PLC0415 — deliberate lazy import

        return requests

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {_resolve_token(self._token)}",
            "Content-Type": "application/json",
        }

    @property
    def _livy_root(self) -> str:
        return (
            f"{self.base_url}/workspaces/{self.workspace_id}"
            f"/lakehouses/{self.lakehouse_id}/livyApi/versions/{self.api_version}"
        )

    # -- sessions ---------------------------------------------------------------
    def list_sessions(self) -> dict:
        """List Livy sessions on the lakehouse; return the raw ``{from,total,sessions}`` doc.

        This is a cheap, non-destructive probe (no Spark capacity is consumed) that a
        preflight check uses to prove the whole request path works end to end: the Entra
        token is valid and carries the Livy scopes, the tenant Livy API setting is enabled,
        and the workspace/lakehouse ids are correct. A 401/403 here points at auth/scopes
        or the tenant setting; a 404 points at a wrong workspace/lakehouse id.
        """
        requests = self._requests()
        url = f"{self._livy_root}/sessions"
        resp = requests.get(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        return resp.json()

    def create_session(self, config: Optional[dict] = None) -> dict:
        """Create an interactive Spark session; return the raw session document."""
        requests = self._requests()
        url = f"{self._livy_root}/sessions"
        body = {"kind": "pyspark", **(config or {})}
        resp = requests.post(url, headers=self._headers(), json=body, timeout=60)
        resp.raise_for_status()
        return resp.json()

    def get_session(self, session_id: Union[str, int]) -> dict:
        requests = self._requests()
        url = f"{self._livy_root}/sessions/{session_id}"
        resp = requests.get(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        return resp.json()

    def get_session_log(self, session_id: Union[str, int], size: int = 100) -> List[str]:
        """Return the tail of the driver log for troubleshooting."""
        requests = self._requests()
        url = f"{self._livy_root}/sessions/{session_id}/log?size={size}"
        resp = requests.get(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        doc = resp.json()
        log = doc.get("log", [])
        return [str(line) for line in log] if isinstance(log, list) else [str(log)]

    def delete_session(self, session_id: Union[str, int]) -> None:
        requests = self._requests()
        url = f"{self._livy_root}/sessions/{session_id}"
        resp = requests.delete(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()

    # -- statements -------------------------------------------------------------
    def submit_statement(self, session_id: Union[str, int], code: str) -> dict:
        requests = self._requests()
        url = f"{self._livy_root}/sessions/{session_id}/statements"
        resp = requests.post(
            url, headers=self._headers(), json={"code": code}, timeout=60
        )
        resp.raise_for_status()
        return resp.json()

    def get_statement(self, session_id: Union[str, int], statement_id: Union[str, int]) -> dict:
        requests = self._requests()
        url = f"{self._livy_root}/sessions/{session_id}/statements/{statement_id}"
        resp = requests.get(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        return resp.json()

    def cancel_statement(self, session_id: Union[str, int], statement_id: Union[str, int]) -> None:
        requests = self._requests()
        url = (
            f"{self._livy_root}/sessions/{session_id}"
            f"/statements/{statement_id}/cancel"
        )
        resp = requests.post(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()


def _spark_ui_url(session_doc: dict) -> Optional[str]:
    """Extract a Spark UI / app URL from a session document if present."""
    app_info = session_doc.get("appInfo") or {}
    for key in ("sparkUiUrl", "driverLogUrl"):
        if app_info.get(key):
            return str(app_info[key])
    return None


class LivyJobMonitor:
    """Robust, transparent poll loop around :class:`FabricLivyClient`.

    Fixes the "waiting forever" bug with three independent guards:

    * ``session_start_timeout_s`` — a Livy session that never leaves ``starting`` fails
      fast with :class:`LivyStartTimeout` and a captured driver-log tail.
    * ``statement_timeout_s`` — a statement that runs past its budget raises
      :class:`LivyStatementTimeout` (orphan/runaway protection).
    * ``max_runtime_s`` — an overall wall-clock ceiling for the whole submit→result flow.

    ``on_status`` is invoked with every fresh :class:`LivyStatus` so a caller can stream
    transparent progress back to the UI (via the GraphQL progress callback).
    """

    def __init__(
        self,
        client: FabricLivyClient,
        *,
        poll_interval_s: float = 5.0,
        session_start_timeout_s: float = 300.0,
        statement_timeout_s: float = 3600.0,
        max_runtime_s: float = 7200.0,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.poll_interval_s = poll_interval_s
        self.session_start_timeout_s = session_start_timeout_s
        self.statement_timeout_s = statement_timeout_s
        self.max_runtime_s = max_runtime_s
        self._sleep = sleep
        self._monotonic = monotonic

    def diagnose(
        self,
        session_id: Optional[Union[str, int]],
        statement_id: Optional[Union[str, int]] = None,
        *,
        log_size: int = 100,
    ) -> LivyDiagnostics:
        """Gather troubleshooting detail for a (possibly stuck/failed) session."""
        diag = LivyDiagnostics(
            session_id=str(session_id) if session_id is not None else None,
            statement_id=str(statement_id) if statement_id is not None else None,
        )
        if session_id is None:
            return diag

        try:
            session_doc = self.client.get_session(session_id)
            diag.session_state = str(session_doc.get("state")) if session_doc.get("state") else None
            diag.spark_app_id = session_doc.get("appId") or None
            diag.spark_ui_url = _spark_ui_url(session_doc)
        except Exception as exc:  # noqa: BLE001 — diagnostics must never raise
            diag.error_message = f"Could not read session: {exc}"

        try:
            diag.driver_log_tail = self.client.get_session_log(session_id, size=log_size)
        except Exception as exc:  # noqa: BLE001
            diag.driver_log_tail = [f"Could not read session log: {exc}"]

        if statement_id is not None:
            try:
                statement_doc = self.client.get_statement(session_id, statement_id)
                diag.statement_state = (
                    str(statement_doc.get("state")) if statement_doc.get("state") else None
                )
                err = _statement_error(statement_doc)
                if err is not None:
                    diag.error_message, diag.error_traceback = err
            except Exception as exc:  # noqa: BLE001
                diag.error_message = diag.error_message or f"Could not read statement: {exc}"

        return diag

    def await_session_ready(
        self,
        session_id: Union[str, int],
        overall_deadline: Optional[float] = None,
    ) -> dict:
        """Block until the session is ``idle``/``busy`` or fail fast on start timeout.

        Honors both the per-phase ``session_start_timeout_s`` and, when provided, the
        overall ``overall_deadline`` so a slow start cannot blow past the job's total
        runtime budget.
        """
        deadline = self._monotonic() + self.session_start_timeout_s
        if overall_deadline is not None:
            deadline = min(deadline, overall_deadline)
        while True:
            session_doc = self.client.get_session(session_id)
            state = str(session_doc.get("state", "")).lower()
            if state in _SESSION_READY:
                return session_doc
            if state in _SESSION_FAILED or state in _SESSION_ENDED:
                diag = self.diagnose(session_id)
                raise LivyStartTimeout(
                    _session_failure_message(
                        {"log": diag.driver_log_tail}, state
                    )
                )
            if self._monotonic() >= deadline:
                diag = self.diagnose(session_id)
                tail = "\n".join(diag.driver_log_tail[-8:])
                raise LivyStartTimeout(
                    f"Spark session {session_id} did not start within "
                    f"{self.session_start_timeout_s:.0f}s (last state: {state or 'unknown'}). "
                    f"Recent log:\n{tail}"
                )
            self._sleep(self.poll_interval_s)

    def await_statement(
        self,
        session_id: Union[str, int],
        statement_id: Union[str, int],
        on_status: Optional[Callable[[LivyStatus], None]] = None,
        overall_deadline: Optional[float] = None,
    ) -> LivyStatus:
        """Block until a statement reaches a terminal :class:`LivyStatus`.

        Enforces the per-statement ``statement_timeout_s`` and, when provided, the overall
        ``overall_deadline``. On timeout it cancels the statement and captures diagnostics
        *before* raising, so troubleshooting detail (log tail, statement state) survives the
        caller's session cleanup.
        """
        deadline = self._monotonic() + self.statement_timeout_s
        if overall_deadline is not None:
            deadline = min(deadline, overall_deadline)
        last_stage: Optional[str] = None
        while True:
            session_doc = self.client.get_session(session_id)
            statement_doc = self.client.get_statement(session_id, statement_id)
            status = interpret_livy_status(session_doc, statement_doc)
            if on_status is not None and status.stage != last_stage:
                on_status(status)
                last_stage = status.stage
            if status.is_terminal:
                return status
            if self._monotonic() >= deadline:
                self._try_cancel(session_id, statement_id)
                diag = self.diagnose(session_id, statement_id)
                tail = "\n".join(diag.driver_log_tail[-8:])
                raise LivyStatementTimeout(
                    f"statement {statement_id} on session {session_id} exceeded "
                    f"{self.statement_timeout_s:.0f}s (last stage: {status.stage}). "
                    f"Recent log:\n{tail}"
                )
            self._sleep(self.poll_interval_s)

    def run(
        self,
        code: str,
        *,
        session_config: Optional[dict] = None,
        on_status: Optional[Callable[[LivyStatus], None]] = None,
        reuse_session_id: Optional[Union[str, int]] = None,
        close_session: bool = True,
    ) -> tuple[LivyStatus, LivyDiagnostics]:
        """Full submit → wait-ready → run statement → terminal flow.

        Returns the terminal :class:`LivyStatus` plus a :class:`LivyDiagnostics` snapshot,
        so callers always get troubleshooting detail even on the happy path. The overall
        ``max_runtime_s`` ceiling is threaded into *both* wait loops so no single phase can
        exceed the job's total budget.
        """
        overall_deadline = self._monotonic() + self.max_runtime_s
        session_id: Optional[Union[str, int]] = reuse_session_id
        statement_id: Optional[Union[str, int]] = None
        try:
            if session_id is None:
                session = self.client.create_session(session_config)
                session_id = session.get("id")
                if on_status is not None:
                    on_status(interpret_livy_status(session))

            self.await_session_ready(session_id, overall_deadline=overall_deadline)

            statement = self.client.submit_statement(session_id, code)
            statement_id = statement.get("id")
            status = self.await_statement(
                session_id, statement_id, on_status=on_status,
                overall_deadline=overall_deadline,
            )

            diag = self.diagnose(session_id, statement_id)
            return status, diag
        finally:
            if close_session and session_id is not None:
                try:
                    self.client.delete_session(session_id)
                except Exception:  # noqa: BLE001 — best-effort cleanup
                    pass

    # -- internals --------------------------------------------------------------
    def _try_cancel(
        self,
        session_id: Optional[Union[str, int]],
        statement_id: Optional[Union[str, int]],
    ) -> None:
        if session_id is None or statement_id is None:
            return
        try:
            self.client.cancel_statement(session_id, statement_id)
        except Exception:  # noqa: BLE001 — cancellation is best-effort
            pass


def build_status_callback(
    job_id: str,
    status: LivyStatus,
    diagnostics: Optional[LivyDiagnostics] = None,
) -> dict:
    """Turn a monitored :class:`LivyStatus` (+optional diagnostics) into the GraphQL
    callback body the control plane POSTs to flip/refresh the job row.

    This is the glue that makes the transparent monitoring real end-to-end: a dispatcher
    can pass this straight to its HTTP POST on every ``on_status`` tick and at completion,
    and the UI's session-details panel lights up with the live stage + Livy identifiers.
    Pure (imports the pure callback builders lazily to avoid an import cycle) so it is
    unit-testable without a network.
    """
    from orchestration.callbacks import completion_callback, progress_callback

    diag = diagnostics or LivyDiagnostics()
    if status.is_terminal:
        return completion_callback(
            job_id,
            status.job_status,
            compute_seconds=None,
            error_message=status.error_message,
            driver_log_tail=diag.driver_log_tail or None,
            spark_ui_url=diag.spark_ui_url,
            livy_state=diag.session_state,
        )
    return progress_callback(
        job_id,
        status.progress_pct,
        status=status.job_status,
        stage=status.stage,
        livy_session_id=diag.session_id,
        livy_statement_id=diag.statement_id,
        livy_state=diag.session_state,
        spark_app_id=diag.spark_app_id,
        spark_ui_url=diag.spark_ui_url,
    )


__all__ = [
    "LivySessionState",
    "LivyStatementState",
    "LivyStatus",
    "LivyDiagnostics",
    "LivyStartTimeout",
    "LivyStatementTimeout",
    "FabricLivyClient",
    "LivyJobMonitor",
    "interpret_livy_status",
    "build_status_callback",
]
