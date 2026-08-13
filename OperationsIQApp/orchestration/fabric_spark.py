"""Fabric Spark dispatch via REST (design spec §4, §8).

Thin, lazily-imported client that submits the MOMP/DAMP Spark Job Definition to Fabric
and polls it to completion. It is intentionally not unit-tested here: it requires a live
Fabric workspace + Entra token, which is unavailable in this environment. The pure state
machine (:mod:`orchestration.state_machine`) and payload builders
(:mod:`orchestration.callbacks`) hold all the testable logic; this module is the network
shell around them.

Auth: pass a bearer token (Entra ID, scope ``https://api.fabric.microsoft.com/.default``)
or a callable that returns one. Uses the Fabric Spark Job Definition *run on-demand* +
*item job instance* REST surface.

References:
- Fabric REST — Spark Job Definition: POST .../jobs/instances?jobType=sparkjob
- Fabric REST — job instance status: GET  .../jobs/instances/{jobInstanceId}
"""
from __future__ import annotations

import time
from typing import Callable, Optional, Union

_FABRIC_BASE = "https://api.fabric.microsoft.com/v1"
_RUNNING_STATES = frozenset({"NotStarted", "InProgress", "Deduped"})
_SUCCESS_STATES = frozenset({"Completed"})
_FAILURE_STATES = frozenset({"Failed", "Cancelled"})

TokenLike = Union[str, Callable[[], str]]


def _resolve_token(token: TokenLike) -> str:
    return token() if callable(token) else token


class FabricSparkClient:
    """Submit and poll a Fabric Spark Job Definition run.

    Parameters
    ----------
    workspace_id, spark_job_definition_id:
        Identify the deployed Spark Job Definition that runs ``jobs/spark_entry.py``.
    token:
        Bearer token string or a zero-arg callable returning one (so it can refresh).
    base_url:
        Override for sovereign clouds / testing.
    """

    def __init__(
        self,
        workspace_id: str,
        spark_job_definition_id: str,
        token: TokenLike,
        base_url: str = _FABRIC_BASE,
    ) -> None:
        self.workspace_id = workspace_id
        self.spark_job_definition_id = spark_job_definition_id
        self._token = token
        self.base_url = base_url.rstrip("/")

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

    def submit(self, execution_data: Optional[dict] = None) -> str:
        """Trigger an on-demand run; return the job instance id (Location header tail)."""
        requests = self._requests()
        url = (
            f"{self.base_url}/workspaces/{self.workspace_id}"
            f"/items/{self.spark_job_definition_id}/jobs/instances?jobType=sparkjob"
        )
        body = {"executionData": execution_data or {}}
        resp = requests.post(url, headers=self._headers(), json=body, timeout=60)
        resp.raise_for_status()
        # 202 Accepted with a Location header pointing at the job instance.
        location = resp.headers.get("Location", "")
        return location.rstrip("/").rsplit("/", 1)[-1]

    def status(self, job_instance_id: str) -> dict:
        """Return the raw job-instance status document."""
        requests = self._requests()
        url = (
            f"{self.base_url}/workspaces/{self.workspace_id}"
            f"/items/{self.spark_job_definition_id}/jobs/instances/{job_instance_id}"
        )
        resp = requests.get(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()
        return resp.json()

    def cancel(self, job_instance_id: str) -> None:
        requests = self._requests()
        url = (
            f"{self.base_url}/workspaces/{self.workspace_id}"
            f"/items/{self.spark_job_definition_id}/jobs/instances/{job_instance_id}/cancel"
        )
        resp = requests.post(url, headers=self._headers(), timeout=60)
        resp.raise_for_status()

    def poll_until_done(
        self,
        job_instance_id: str,
        interval_s: float = 10.0,
        timeout_s: float = 3600.0,
        on_status: Optional[Callable[[str], None]] = None,
    ) -> str:
        """Block until the run reaches a terminal state; return that state string.

        A max-runtime guard (``timeout_s``) protects against orphaned runs (spec §8).
        """
        deadline = time.monotonic() + timeout_s
        while True:
            doc = self.status(job_instance_id)
            state = doc.get("status", "Unknown")
            if on_status is not None:
                on_status(state)
            if state in _SUCCESS_STATES or state in _FAILURE_STATES:
                return state
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"job instance {job_instance_id} exceeded {timeout_s}s (last={state})"
                )
            time.sleep(interval_s)
