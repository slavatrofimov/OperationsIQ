"""The AnalysisJob state machine (design spec §5, §8).

`QUEUED -> RUNNING -> (SUCCEEDED | FAILED | CANCELLED)`, with cancellation allowed from
either non-terminal state. All transitions are validated so an orchestrator can never
push a job into an illegal state (e.g. resurrecting a finished job or skipping RUNNING).

The functions are pure: they take a :class:`JobState` and return a *new* one, so they are
trivially testable and safe to use inside idempotent retry loops.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional


class JobStatus:
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


TERMINAL = frozenset({JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED})

_ALLOWED: dict[str, frozenset[str]] = {
    JobStatus.QUEUED: frozenset({JobStatus.RUNNING, JobStatus.CANCELLED, JobStatus.FAILED}),
    JobStatus.RUNNING: frozenset(
        {JobStatus.SUCCEEDED, JobStatus.FAILED, JobStatus.CANCELLED}
    ),
    JobStatus.SUCCEEDED: frozenset(),
    JobStatus.FAILED: frozenset(),
    JobStatus.CANCELLED: frozenset(),
}


class InvalidTransition(Exception):
    """Raised when a requested status change violates the state machine."""


@dataclass(frozen=True)
class JobState:
    """A minimal view of an AnalysisJob row for orchestration."""

    job_id: str
    status: str = JobStatus.QUEUED
    progress_pct: float = 0.0
    spark_app_id: Optional[str] = None
    error_message: Optional[str] = None


def is_terminal(status: str) -> bool:
    return status in TERMINAL


def can_transition(src: str, dst: str) -> bool:
    return dst in _ALLOWED.get(src, frozenset())


def transition(state: JobState, dst: str, **updates) -> JobState:
    """Return a new state moved to ``dst``, or raise :class:`InvalidTransition`."""
    if dst not in _ALLOWED:
        raise InvalidTransition(f"unknown status {dst!r}")
    if not can_transition(state.status, dst):
        raise InvalidTransition(
            f"cannot move job {state.job_id} from {state.status} to {dst}"
        )
    return replace(state, status=dst, **updates)


def start(state: JobState, spark_app_id: Optional[str] = None) -> JobState:
    """QUEUED -> RUNNING, recording the Spark application id."""
    return transition(state, JobStatus.RUNNING, spark_app_id=spark_app_id, progress_pct=0.0)


def report_progress(state: JobState, pct: float) -> JobState:
    """Update progress while RUNNING (monotonic, clamped to 0..100). No status change."""
    if state.status != JobStatus.RUNNING:
        raise InvalidTransition(f"cannot report progress on a {state.status} job")
    clamped = max(0.0, min(100.0, float(pct)))
    # Progress never goes backwards — anytime refinement only improves.
    return replace(state, progress_pct=max(state.progress_pct, clamped))


def succeed(state: JobState) -> JobState:
    """RUNNING -> SUCCEEDED at 100%."""
    return transition(state, JobStatus.SUCCEEDED, progress_pct=100.0)


def fail(state: JobState, error_message: str) -> JobState:
    """-> FAILED with an error message (allowed from QUEUED or RUNNING)."""
    return transition(state, JobStatus.FAILED, error_message=error_message)


def cancel(state: JobState) -> JobState:
    """-> CANCELLED (allowed from QUEUED or RUNNING)."""
    return transition(state, JobStatus.CANCELLED)
