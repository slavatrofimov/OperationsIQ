"""Async job orchestration for the Motif & Discord Explorer (design spec §8).

Pure, dependency-free logic (state machine + callback payload builders) that the
control plane and any dispatcher share, plus a lazily-imported Fabric Spark REST client
for the actual submit/poll. Importing this package never requires network libraries.
"""
from orchestration.state_machine import (
    JobStatus,
    JobState,
    InvalidTransition,
    TERMINAL,
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
from orchestration.cost import (
    estimate_compute_seconds,
    estimate_cu_cost,
    QuotaLedger,
    cache_key,
)
from orchestration.fabric_livy import (
    FabricLivyClient,
    LivyJobMonitor,
    LivyStatus,
    LivyDiagnostics,
    LivySessionState,
    LivyStatementState,
    LivyStartTimeout,
    LivyStatementTimeout,
    interpret_livy_status,
    build_status_callback,
)
from orchestration.dispatcher import (
    ControlPlaneClient,
    DispatcherConfig,
    JobDispatcher,
    SourceMapping,
    CheckResult,
    build_job_payload,
    build_livy_code,
    parse_params,
    run_preflight,
)

__all__ = [
    "JobStatus",
    "JobState",
    "InvalidTransition",
    "TERMINAL",
    "is_terminal",
    "can_transition",
    "transition",
    "start",
    "report_progress",
    "succeed",
    "fail",
    "cancel",
    "progress_callback",
    "completion_callback",
    "update_job_mutation",
    "estimate_compute_seconds",
    "estimate_cu_cost",
    "QuotaLedger",
    "cache_key",
    "FabricLivyClient",
    "LivyJobMonitor",
    "LivyStatus",
    "LivyDiagnostics",
    "LivySessionState",
    "LivyStatementState",
    "LivyStartTimeout",
    "LivyStatementTimeout",
    "interpret_livy_status",
    "build_status_callback",
    "ControlPlaneClient",
    "DispatcherConfig",
    "JobDispatcher",
    "SourceMapping",
    "CheckResult",
    "build_job_payload",
    "build_livy_code",
    "parse_params",
    "run_preflight",
]
