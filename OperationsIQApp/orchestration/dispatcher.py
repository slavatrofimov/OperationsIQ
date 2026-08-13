"""The Livy job **dispatcher** — the missing runtime that actually submits jobs (design
spec §8).

Before this module, the control plane wrote an ``AnalysisJob(QUEUED)`` row and *nothing*
advanced it: no Spark session was ever created, so the UI's "waiting for a Spark session"
spinner ticked up forever and nothing appeared on the Livy endpoint. This module closes
that gap. It is the long-running service that:

1. polls the Rayfin GraphQL control plane for ``QUEUED`` jobs,
2. claims each one (``QUEUED -> RUNNING``) so it is dispatched exactly once,
3. resolves the job's data source, builds a PySpark statement, and runs it on Fabric
   Spark through :class:`orchestration.fabric_livy.LivyJobMonitor` (which enforces the
   session-start / statement / overall-runtime timeouts so a job can never hang forever),
4. streams transparent status (stage, Livy identifiers, Spark UI link, driver-log tail)
   back onto the job row via :func:`orchestration.fabric_livy.build_status_callback`, and
5. finalizes the job ``SUCCEEDED`` / ``FAILED`` with troubleshooting detail.

Design choices that keep this unit-testable without a live Fabric cluster or MSAL:

* All network dependencies (``requests``, ``azure-identity``) are imported lazily.
* The pure helpers — :func:`parse_params`, :func:`build_job_payload`,
  :func:`build_livy_code` — carry the interesting logic and are tested directly.
* :class:`JobDispatcher` takes injectable ``control_plane`` and monitor/client factories,
  so the whole claim -> dispatch -> callback flow is exercised with fakes in the tests.

Authentication (see ``orchestration/.env.dispatcher.example`` + the runbook): the Livy
calls need a Microsoft Entra token for ``https://api.fabric.microsoft.com/.default`` from a
service principal that is a **Contributor** on the workspace, the tenant **Livy API**
setting must be enabled, and the SPN needs the Livy scopes (``Lakehouse.Execute.All``,
``Lakehouse.Read.All``, ``Code.AccessFabric.All``, ``Code.AccessStorage.All``).
"""
from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Union

from orchestration.callbacks import completion_callback
from orchestration.fabric_livy import (
    FabricLivyClient,
    LivyJobMonitor,
    LivyStatus,
    build_status_callback,
)
from orchestration.state_machine import JobStatus

__all__ = [
    "TokenLike",
    "SourceMapping",
    "DispatcherConfig",
    "ControlPlaneClient",
    "JobDispatcher",
    "parse_params",
    "build_job_payload",
    "build_livy_code",
    "CheckResult",
    "run_preflight",
    "main",
]

TokenLike = Union[str, Callable[[], str]]

_FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default"

# Select only dispatcher fields and filter queued jobs in Python so the query
# stays schema-agnostic.
_LIST_JOBS_QUERY = """
query QueuedAnalysisJobs {
  analysisJobs {
    id
    name
    signal_id
    type
    windowStart
    windowEnd
    subLen
    params
    status
  }
}
""".strip()


def _resolve_token(token: TokenLike) -> str:
    return token() if callable(token) else token


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
@dataclass
class SourceMapping:
    """Resolved Eventhouse/KQL source the analysis reads from.

    The ``AnalysisJob`` row carries only the ``signal_id`` (a tag/point id), not a full
    data-source binding — the binding lives in the deployment's connection profile. The
    dispatcher therefore resolves the physical source from configuration and uses the
    job's ``signal_id`` as the ``tag`` filter.
    """

    kql_cluster_uri: str
    database: str
    table: str
    time_column: str
    value_column: str
    tag_column: Optional[str] = None
    auth: str = "managed_identity"
    result_cluster_uri: Optional[str] = None
    result_database: Optional[str] = None

    def to_source_dict(
        self, signal_id: str, window_start: Optional[str], window_end: Optional[str]
    ) -> dict:
        source: dict = {
            "kqlClusterUri": self.kql_cluster_uri,
            "database": self.database,
            "table": self.table,
            "timeColumn": self.time_column,
            "valueColumn": self.value_column,
        }
        if self.tag_column:
            source["tagColumn"] = self.tag_column
            source["tag"] = signal_id
        if window_start:
            source["windowStart"] = window_start
        if window_end:
            source["windowEnd"] = window_end
        return source

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "SourceMapping":
        env = env or os.environ
        return cls(
            kql_cluster_uri=_require(env, "TSMP_KQL_CLUSTER_URI"),
            database=_require(env, "TSMP_KQL_DATABASE"),
            table=_require(env, "TSMP_SOURCE_TABLE"),
            time_column=env.get("TSMP_TIME_COLUMN", "Timestamp"),
            value_column=env.get("TSMP_VALUE_COLUMN", "Value"),
            tag_column=env.get("TSMP_TAG_COLUMN") or None,
            auth=env.get("TSMP_KUSTO_AUTH", "managed_identity"),
            result_cluster_uri=env.get("TSMP_RESULT_CLUSTER_URI") or None,
            result_database=env.get("TSMP_RESULT_DATABASE") or None,
        )


@dataclass
class DispatcherConfig:
    """Everything the dispatcher needs to talk to Livy + the control plane."""

    workspace_id: str
    lakehouse_id: str
    graphql_url: str
    fabric_scope: str = _FABRIC_SCOPE
    environment_id: Optional[str] = None
    poll_interval_s: float = 15.0
    session_start_timeout_s: float = 300.0
    statement_timeout_s: float = 3600.0
    max_runtime_s: float = 7200.0

    @classmethod
    def from_env(cls, env: Optional[dict] = None) -> "DispatcherConfig":
        env = env or os.environ
        return cls(
            workspace_id=_require(env, "FABRIC_WORKSPACE_ID"),
            lakehouse_id=_require(env, "FABRIC_LAKEHOUSE_ID"),
            graphql_url=_require(env, "RAYFIN_GRAPHQL_URL"),
            fabric_scope=env.get("FABRIC_SCOPE", _FABRIC_SCOPE),
            environment_id=env.get("FABRIC_ENVIRONMENT_ID") or None,
            poll_interval_s=float(env.get("DISPATCHER_POLL_INTERVAL_S", "15")),
            session_start_timeout_s=float(env.get("LIVY_SESSION_START_TIMEOUT_S", "300")),
            statement_timeout_s=float(env.get("LIVY_STATEMENT_TIMEOUT_S", "3600")),
            max_runtime_s=float(env.get("LIVY_MAX_RUNTIME_S", "7200")),
        )


def _require(env: dict, key: str) -> str:
    value = env.get(key)
    if not value:
        raise RuntimeError(f"missing required environment variable: {key}")
    return value


# ---------------------------------------------------------------------------
# Pure payload / code builders
# ---------------------------------------------------------------------------
def parse_params(params: Optional[str]) -> dict:
    """Parse the job's stringified ``params`` JSON bag; tolerant of null/blank/bad JSON."""
    if not params:
        return {}
    try:
        parsed = json.loads(params)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def build_job_payload(job: dict, source: dict) -> dict:
    """Merge an ``AnalysisJob`` row + resolved ``source`` into the Spark job spec payload.

    The result matches what :func:`tsmp.jobs.spark_entry.run_payload` expects. Analysis
    tuning lives in the free-form ``params`` bag (``k``, ``minlag``, ``includeProfile``,
    ``buildOverview``, ``lengthMin/Max/Step``, ``nBlocks``); job columns win over params
    for the structural fields (type, subLen).
    """
    params = parse_params(job.get("params"))

    payload: dict = {
        "jobId": job["id"],
        "type": job["type"],
        "source": source,
    }

    sub_len = job.get("subLen")
    if sub_len is None:
        sub_len = params.get("subLen", params.get("m"))
    if sub_len is not None:
        payload["subLen"] = int(sub_len)

    # Optional analysis knobs, taken from params when present.
    for src_key, dst_key, caster in (
        ("k", "k", int),
        ("minlag", "minlag", int),
        ("includeProfile", "includeProfile", bool),
        ("buildOverview", "buildOverview", bool),
        ("lengthMin", "lengthMin", int),
        ("lengthMax", "lengthMax", int),
        ("lengthStep", "lengthStep", int),
        ("nBlocks", "nBlocks", int),
    ):
        if params.get(src_key) is not None:
            payload[dst_key] = caster(params[src_key])

    return payload


def build_livy_code(payload: dict) -> str:
    """Return the PySpark statement that runs one analysis on the Livy session.

    The payload is base64-encoded into the statement so no amount of quoting in table
    names / ids / ISO timestamps can break the generated code. The statement calls the
    tested :func:`tsmp.jobs.spark_entry.run_and_print`, which prints a tagged JSON result
    line the dispatcher can recover from the statement output, or a
    ``TSMP_TRACEBACK_BEGIN``/``_END``-bracketed full traceback (to stdout and stderr) on
    failure before re-raising.
    """
    encoded = base64.b64encode(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).decode("ascii")
    return (
        "import base64, json\n"
        "from tsmp.jobs.spark_entry import run_and_print\n"
        f'_payload = json.loads(base64.b64decode("{encoded}").decode("utf-8"))\n'
        "run_and_print(_payload)\n"
    )


# ---------------------------------------------------------------------------
# Control-plane (Rayfin GraphQL) client
# ---------------------------------------------------------------------------
class ControlPlaneClient:
    """Thin GraphQL client for the Rayfin Data API used to list/claim/update jobs."""

    def __init__(
        self,
        graphql_url: str,
        token: TokenLike,
        *,
        list_query: str = _LIST_JOBS_QUERY,
        timeout_s: float = 60.0,
    ) -> None:
        self.graphql_url = graphql_url
        self._token = token
        self.list_query = list_query
        self.timeout_s = timeout_s

    @staticmethod
    def _requests():
        import requests  # noqa: PLC0415 — deliberate lazy import

        return requests

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {_resolve_token(self._token)}",
            "Content-Type": "application/json",
        }

    def execute(self, query: str, variables: Optional[dict] = None) -> dict:
        """POST a GraphQL operation, returning ``data`` and raising on transport/errors."""
        requests = self._requests()
        resp = requests.post(
            self.graphql_url,
            headers=self._headers(),
            json={"query": query, "variables": variables or {}},
            timeout=self.timeout_s,
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("errors"):
            raise RuntimeError(f"GraphQL errors: {json.dumps(body['errors'])}")
        return body.get("data") or {}

    def list_queued_jobs(self) -> List[dict]:
        """Return the ``QUEUED`` analysis jobs awaiting dispatch."""
        data = self.execute(self.list_query)
        jobs = data.get("analysisJobs") or []
        return [j for j in jobs if str(j.get("status")) == JobStatus.QUEUED]

    def claim_job(self, job_id: str) -> bool:
        """Move a job ``QUEUED -> RUNNING`` so it is dispatched once. Returns success.

        This is an optimistic claim (the control plane's row-level policy + a single
        dispatcher instance keep it exactly-once in practice). It records ``startedAt`` and
        an initial stage so the UI immediately reflects that the job was picked up.
        """
        body = build_status_callback(
            job_id,
            LivyStatus(
                job_status=JobStatus.RUNNING,
                stage="dispatch:claimed",
                message="Picked up by the dispatcher — creating a Spark session…",
                progress_pct=0.0,
            ),
        )
        try:
            self.execute(body["query"], body["variables"])
            return True
        except Exception:  # noqa: BLE001 — a failed claim just means skip this job now
            return False

    def post_callback(self, body: dict) -> None:
        """POST a prepared callback body (from the callback builders) to the control plane."""
        self.execute(body["query"], body["variables"])


# ---------------------------------------------------------------------------
# The dispatcher
# ---------------------------------------------------------------------------
class JobDispatcher:
    """Polls for QUEUED jobs and drives each one to completion over Livy."""

    def __init__(
        self,
        config: DispatcherConfig,
        control_plane: ControlPlaneClient,
        source: SourceMapping,
        *,
        fabric_token: Optional[TokenLike] = None,
        livy_client_factory: Optional[Callable[[], FabricLivyClient]] = None,
        monitor_factory: Optional[Callable[[FabricLivyClient], LivyJobMonitor]] = None,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
    ) -> None:
        self.config = config
        self.control_plane = control_plane
        self.source = source
        self._sleep = sleep
        self._log = log

        if livy_client_factory is None:
            if fabric_token is None:
                raise ValueError("provide either fabric_token or livy_client_factory")

            def livy_client_factory() -> FabricLivyClient:  # type: ignore[misc]
                return FabricLivyClient(
                    config.workspace_id, config.lakehouse_id, token=fabric_token
                )

        if monitor_factory is None:

            def monitor_factory(client: FabricLivyClient) -> LivyJobMonitor:  # type: ignore[misc]
                return LivyJobMonitor(
                    client,
                    poll_interval_s=config.poll_interval_s,
                    session_start_timeout_s=config.session_start_timeout_s,
                    statement_timeout_s=config.statement_timeout_s,
                    max_runtime_s=config.max_runtime_s,
                )

        self._livy_client_factory = livy_client_factory
        self._monitor_factory = monitor_factory

    # -- session config ---------------------------------------------------------
    def _session_config(self) -> dict:
        """Base Livy session config, wiring a Fabric Environment when configured."""
        config: dict = {"kind": "pyspark"}
        if self.config.environment_id:
            config["conf"] = {
                "spark.fabric.environmentDetails": json.dumps(
                    {"id": self.config.environment_id}
                )
            }
        return config

    # -- one job ----------------------------------------------------------------
    def dispatch_job(self, job: dict) -> LivyStatus:
        """Run a single claimed job end-to-end, streaming status back to the control plane.

        Returns the terminal :class:`LivyStatus`. Never raises for a job-level failure — a
        failed job is reported via a FAILED completion callback so one bad job cannot take
        down the polling loop.
        """
        job_id = job["id"]
        source = self.source.to_source_dict(
            job["signal_id"], job.get("windowStart"), job.get("windowEnd")
        )
        payload = build_job_payload(job, source)
        code = build_livy_code(payload)

        client = self._livy_client_factory()
        monitor = self._monitor_factory(client)

        def on_status(status: LivyStatus) -> None:
            # Post non-terminal updates immediately; terminal status waits for
            # diagnostics so the troubleshooting panel is populated.
            if not status.is_terminal:
                self._safe_post(build_status_callback(job_id, status))

        try:
            status, diag = monitor.run(
                code,
                session_config=self._session_config(),
                on_status=on_status,
            )
            self._safe_post(build_status_callback(job_id, status, diag))
            self._log(f"[dispatcher] job {job_id} finished: {status.job_status} ({status.stage})")
            return status
        except Exception as exc:  # noqa: BLE001
            message = f"Dispatch failed: {exc}"
            self._safe_post(
                completion_callback(job_id, JobStatus.FAILED, error_message=message)
            )
            self._log(f"[dispatcher] job {job_id} FAILED: {message}")
            return LivyStatus(
                job_status=JobStatus.FAILED,
                stage="dispatch:error",
                message=message,
                is_terminal=True,
                error_message=message,
            )

    def _safe_post(self, body: dict) -> None:
        try:
            self.control_plane.post_callback(body)
        except Exception as exc:  # noqa: BLE001 — a dropped status update must not abort a run
            self._log(f"[dispatcher] warning: failed to post callback: {exc}")

    # -- polling ----------------------------------------------------------------
    def poll_once(self) -> int:
        """List queued jobs, claim, and dispatch each. Returns the number dispatched."""
        try:
            jobs = self.control_plane.list_queued_jobs()
        except Exception as exc:  # noqa: BLE001
            self._log(f"[dispatcher] warning: failed to list queued jobs: {exc}")
            return 0

        dispatched = 0
        for job in jobs:
            job_id = job.get("id")
            if not job_id:
                continue
            if not self.control_plane.claim_job(job_id):
                self._log(f"[dispatcher] could not claim job {job_id}; skipping")
                continue
            self.dispatch_job(job)
            dispatched += 1
        # Always log the pass outcome: a steady "0 queued" while a job is stuck in the UI
        # is the fingerprint of a control-plane/list-query mismatch (nothing is being seen).
        self._log(f"[dispatcher] poll: {len(jobs)} queued, {dispatched} dispatched")
        return dispatched

    def run_forever(self, max_iterations: Optional[int] = None) -> None:
        """Poll indefinitely (or ``max_iterations`` times), sleeping between passes."""
        self._log(
            f"[dispatcher] starting: workspace={self.config.workspace_id} "
            f"lakehouse={self.config.lakehouse_id} poll={self.config.poll_interval_s}s"
        )
        iterations = 0
        while max_iterations is None or iterations < max_iterations:
            self.poll_once()
            iterations += 1
            if max_iterations is not None and iterations >= max_iterations:
                break
            self._sleep(self.config.poll_interval_s)


# ---------------------------------------------------------------------------
# Preflight / doctor — verify the whole dispatch chain without a real job
# ---------------------------------------------------------------------------
@dataclass
class CheckResult:
    """One preflight probe result. ``ok`` drives the overall exit status."""

    name: str
    ok: bool
    detail: str

    def format(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        return f"[{mark}] {self.name}: {self.detail}"


def run_preflight(
    config: DispatcherConfig,
    source: SourceMapping,
    control_plane: "ControlPlaneClient",
    *,
    fabric_token: Optional[TokenLike] = None,
    livy_client_factory: Optional[Callable[[], FabricLivyClient]] = None,
    log: Callable[[str], None] = print,
) -> List[CheckResult]:
    """Probe every link in the dispatch chain and return per-step results.

    The stuck-"waiting for a Spark session" symptom with *nothing* on the Livy endpoint
    means the job row is never even claimed, so the fault is upstream of Spark. These checks
    isolate exactly which link is broken, in order:

    1. **config** — required ids/URLs and the source mapping are present.
    2. **fabric-token** — the Entra SPN can mint a Fabric token (isolates auth failures
       from endpoint failures).
    3. **livy** — a non-destructive ``GET /sessions`` succeeds, proving the token carries
       the Livy scopes, the tenant Livy API setting is on, and the workspace/lakehouse ids
       are right.
    4. **control-plane** — the GraphQL list query returns (proving the URL, auth, and the
       ``analysisJobs`` query name are correct) and reports how many QUEUED jobs are waiting.

    Never raises: every probe is captured into a :class:`CheckResult` so the caller can
    print the full report and exit non-zero on any failure.
    """
    results: List[CheckResult] = []

    # 1. config -----------------------------------------------------------------
    missing_source = [
        label
        for label, value in (
            ("TSMP_KQL_CLUSTER_URI", source.kql_cluster_uri),
            ("TSMP_KQL_DATABASE", source.database),
            ("TSMP_SOURCE_TABLE", source.table),
        )
        if not value
    ]
    if missing_source:
        results.append(
            CheckResult(
                "config",
                False,
                f"source mapping incomplete; missing {', '.join(missing_source)}",
            )
        )
    else:
        results.append(
            CheckResult(
                "config",
                True,
                f"workspace={config.workspace_id} lakehouse={config.lakehouse_id} "
                f"graphql={config.graphql_url} source={source.database}/{source.table}",
            )
        )

    # 2. fabric token -----------------------------------------------------------
    livy_factory = livy_client_factory
    if fabric_token is not None:
        try:
            token = _resolve_token(fabric_token)
            if not token:
                raise RuntimeError("token provider returned an empty token")
            results.append(
                CheckResult("fabric-token", True, "minted a Fabric access token")
            )
        except Exception as exc:  # noqa: BLE001 — report, don't abort the report
            results.append(
                CheckResult(
                    "fabric-token",
                    False,
                    f"could not mint an Entra token ({exc}); check "
                    "AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET",
                )
            )
        if livy_factory is None:
            def livy_factory() -> FabricLivyClient:  # type: ignore[misc]
                return FabricLivyClient(
                    config.workspace_id, config.lakehouse_id, token=fabric_token
                )

    # 3. livy endpoint ----------------------------------------------------------
    if livy_factory is None:
        results.append(
            CheckResult(
                "livy", False, "no Fabric token or Livy client factory provided"
            )
        )
    else:
        try:
            doc = livy_factory().list_sessions()
            total = doc.get("total", len(doc.get("sessions", []) or []))
            results.append(
                CheckResult(
                    "livy",
                    True,
                    f"reached the Livy endpoint ({total} live session(s))",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(
                CheckResult(
                    "livy",
                    False,
                    f"GET /sessions failed ({exc}). A 401/403 => missing Livy scopes "
                    "(Lakehouse.Execute.All, Lakehouse.Read.All, Code.AccessFabric.All, "
                    "Code.AccessStorage.All), SPN not a workspace Contributor, or the "
                    "tenant Livy API setting is off. A 404 => wrong workspace/lakehouse id",
                )
            )

    # 4. control plane ----------------------------------------------------------
    try:
        jobs = control_plane.list_queued_jobs()
        results.append(
            CheckResult(
                "control-plane",
                True,
                f"GraphQL list query OK; {len(jobs)} QUEUED job(s) awaiting dispatch",
            )
        )
    except Exception as exc:  # noqa: BLE001
        results.append(
            CheckResult(
                "control-plane",
                False,
                f"list_queued_jobs failed ({exc}). Check RAYFIN_GRAPHQL_URL, the "
                "control-plane token, and that the generated list query is named "
                "'analysisJobs' (override list_query on ControlPlaneClient if not)",
            )
        )

    for result in results:
        log(result.format())
    ok = all(r.ok for r in results)
    log(
        "[preflight] all checks passed — the dispatcher can reach every dependency"
        if ok
        else "[preflight] one or more checks FAILED — see above; the dispatcher cannot "
        "dispatch jobs until these are fixed"
    )
    return results


# ---------------------------------------------------------------------------
# Default token provider + CLI entry
# ---------------------------------------------------------------------------
def _client_secret_token_provider(scope: str, env: Optional[dict] = None) -> Callable[[], str]:
    """Build a zero-arg token callable using an Entra SPN (client-credentials flow).

    Lazily uses ``azure-identity`` so importing this module never requires it. Reads
    ``AZURE_TENANT_ID`` / ``AZURE_CLIENT_ID`` / ``AZURE_CLIENT_SECRET`` from the env.
    """
    env = env or os.environ
    tenant = _require(env, "AZURE_TENANT_ID")
    client_id = _require(env, "AZURE_CLIENT_ID")
    client_secret = _require(env, "AZURE_CLIENT_SECRET")

    def provider() -> str:
        from azure.identity import ClientSecretCredential  # noqa: PLC0415 — lazy

        credential = ClientSecretCredential(tenant, client_id, client_secret)
        return credential.get_token(scope).token

    return provider


def main(argv: Optional[list] = None) -> None:  # pragma: no cover - live service entry
    """CLI entry point.

    * ``python -m orchestration.dispatcher`` (or ``... run``) — run the polling loop.
    * ``python -m orchestration.dispatcher preflight`` — probe config, the SPN token, the
      Livy endpoint, and the control plane, print a PASS/FAIL report, and exit non-zero if
      any link is broken. Use this first when jobs are stuck "waiting for a Spark session"
      with nothing on the Livy endpoint.

    Config + token providers are built from the environment (see
    ``orchestration/.env.dispatcher.example``).
    """
    import argparse
    import sys

    parser = argparse.ArgumentParser(
        prog="python -m orchestration.dispatcher",
        description="Livy job dispatcher for Operations IQ analyses.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="run",
        choices=("run", "preflight", "doctor"),
        help="'run' the polling loop (default), or 'preflight'/'doctor' to check connectivity.",
    )
    args = parser.parse_args(argv)

    config = DispatcherConfig.from_env()
    source = SourceMapping.from_env()

    fabric_token = _client_secret_token_provider(config.fabric_scope)

    # The control plane accepts either a dedicated static API token or the same SPN token.
    api_token_env = os.environ.get("RAYFIN_API_TOKEN")
    control_token: TokenLike = (
        api_token_env
        if api_token_env
        else _client_secret_token_provider(
            os.environ.get("RAYFIN_API_SCOPE", config.fabric_scope)
        )
    )

    control_plane = ControlPlaneClient(config.graphql_url, control_token)

    if args.command in ("preflight", "doctor"):
        results = run_preflight(
            config, source, control_plane, fabric_token=fabric_token
        )
        sys.exit(0 if all(r.ok for r in results) else 1)

    dispatcher = JobDispatcher(
        config, control_plane, source, fabric_token=fabric_token
    )
    dispatcher.run_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
