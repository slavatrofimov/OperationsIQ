"""Thin Kusto read/ingest execution layer (design spec §5.1, §8).

This module lazily imports the ``azure-kusto-data`` / ``azure-kusto-ingest`` SDKs so
that importing :mod:`tsmp` (for pure compute or query-building) never requires them.
It is intentionally *not* exercised by the unit tests — there is no cluster in CI — but
it gives Spark a single, documented entry point for reading source series and writing
result rows into the KQL tables defined in ``kql/result_schema.kql``.

Typical Spark usage::

    client = KustoResultClient(cluster_uri, database)
    df = client.read_dataframe(bulk_series_query(table, tcol, vcol, tagcol, tag))
    ...compute...
    client.ingest_rows("mp_result", mp_result_rows(job_id, profile))

Authentication is selected by ``auth``: on Fabric Spark use ``"fabric_token"`` (a
token provider backed by ``notebookutils.credentials.getToken("kusto")``), since
Fabric Spark has no IMDS endpoint for managed identity and ``getToken`` only accepts
the fixed audience keyword ``"kusto"`` for the KQL DB resource (not the cluster URI);
``"managed_identity"`` and ``"az_cli"`` remain for non-Fabric hosts and local development.
"""
from __future__ import annotations

from typing import Any, Iterable, Sequence

__all__ = ["KustoResultClient"]


def _require(module: str, package: str) -> Any:
    try:
        return __import__(module, fromlist=["*"])
    except ImportError as exc:  # pragma: no cover - depends on optional SDK
        raise ImportError(
            f"{package} is required for Kusto execution. "
            f"Install it with `pip install {package}`."
        ) from exc


class KustoResultClient:
    """Reads source series and ingests result rows into a KQL database.

    All SDK objects are created lazily on first use so this class can be constructed in
    environments (tests, pure-compute driver code) where the SDK is absent.
    """

    def __init__(
        self,
        cluster_uri: str,
        database: str,
        auth: str = "az_cli",
        client_id: str | None = None,
        ingest_mode: str = "managed_streaming",
    ) -> None:
        self.cluster_uri = cluster_uri
        self.database = database
        self.auth = auth
        self.client_id = client_id
        # "managed_streaming" (default) streams small payloads for near-real-time
        # latency and auto-falls-back to queued for >4 MB writes or transient
        # errors; "queued" forces the classic batched path. See _get_ingest_client.
        self.ingest_mode = ingest_mode
        self._query_client = None
        self._ingest_client = None

    # ------------------------------------------------------------------ auth

    # Fabric's ``notebookutils.credentials.getToken`` accepts only a fixed set of
    # audience *keywords* -- "storage", "pbi", "keyvault" and "kusto" -- NOT the
    # full resource URI. The KQL DB / ADX resource is "kusto". Passing the cluster
    # URI (e.g. https://<cluster>.kusto.fabric.microsoft.com) is rejected: it maps
    # to a resource the delegated user token has no scope for, surfacing as
    # ``REQUEST_INVALID_RESOURCE_NONRETRIABLE`` / "Resource is not valid" and a
    # recurring background token-refresh failure in the Spark driver log.
    KUSTO_TOKEN_AUDIENCE = "kusto"

    @classmethod
    def _fabric_notebook_token(cls) -> str:
        """Return an AAD access token for the KQL DB resource via notebookutils.

        On Fabric Spark the cluster has **no IMDS endpoint**, so managed-identity
        auth to Kusto fails ("no response from the IMDS endpoint"). Fabric instead
        exposes the running user's/workspace token through ``notebookutils`` (aka
        the legacy ``mssparkutils``). Per the Fabric docs, ``getToken`` only accepts
        the audience keyword ``"kusto"`` for the KQL DB / ADX resource (the raw
        cluster URI is not a valid audience). Returns the raw bearer token string
        (some runtimes return a dict).
        """
        try:
            import notebookutils  # type: ignore

            get_token = notebookutils.credentials.getToken
        except Exception:  # pragma: no cover - alternate notebookutils export
            from notebookutils import mssparkutils  # type: ignore

            get_token = mssparkutils.credentials.getToken

        token = get_token(cls.KUSTO_TOKEN_AUDIENCE)
        if not token:
            raise RuntimeError(
                "notebookutils.credentials.getToken('kusto') returned no token"
            )
        if isinstance(token, dict):  # pragma: no cover - shape varies by runtime
            return token.get("accessToken") or token.get("token") or ""
        return str(token)

    def _fabric_token_provider(self):
        """A no-arg callable returning a fresh Kusto token (for with_token_provider)."""

        def provider() -> str:
            return self._fabric_notebook_token()

        return provider

    def _connection_string(self, endpoint: str):
        kdata = _require("azure.kusto.data", "azure-kusto-data")
        kcsb = kdata.KustoConnectionStringBuilder
        if self.auth == "az_cli":
            return kcsb.with_az_cli_authentication(endpoint)
        if self.auth == "managed_identity":
            return kcsb.with_aad_managed_service_identity_authentication(
                endpoint, client_id=self.client_id
            )
        if self.auth in ("fabric_token", "notebookutils", "fabric"):
            # Token is scoped to the cluster resource but valid for the ingest
            # endpoint too (same AAD resource), so both clients share the provider.
            return kcsb.with_token_provider(endpoint, self._fabric_token_provider())
        raise ValueError(f"unsupported auth mode: {self.auth!r}")

    # ------------------------------------------------------------------ read

    def _get_query_client(self):
        if self._query_client is None:
            kdata = _require("azure.kusto.data", "azure-kusto-data")
            csb = self._connection_string(self.cluster_uri)
            self._query_client = kdata.KustoClient(csb)
        return self._query_client

    def read(self, query: str):
        """Execute ``query`` and return the primary result table."""
        client = self._get_query_client()
        response = client.execute(self.database, query)
        return response.primary_results[0]

    def read_dataframe(self, query: str):
        """Execute ``query`` and return a pandas ``DataFrame``."""
        helpers = _require("azure.kusto.data.helpers", "azure-kusto-data")
        client = self._get_query_client()
        response = client.execute(self.database, query)
        return helpers.dataframe_from_result_table(response.primary_results[0])

    # ---------------------------------------------------------------- ingest

    def _get_ingest_client(self):
        if self._ingest_client is None:
            kingest = _require("azure.kusto.ingest", "azure-kusto-ingest")
            # The Data Management (queued) endpoint lives at the ``ingest-``-prefixed
            # host; streaming ingestion targets the plain engine/query host.
            ingest_uri = self.cluster_uri.replace("https://", "https://ingest-", 1)
            dm_csb = self._connection_string(ingest_uri)

            if self.ingest_mode == "queued":
                self._ingest_client = kingest.QueuedIngestClient(dm_csb)
            else:
                # Managed streaming: attempt streaming ingestion against the engine
                # endpoint (seconds-scale latency, ideal for our small result
                # tables) and transparently fall back to the queued DM path for
                # payloads over the 4 MB streaming limit, when a table has no
                # streaming ingestion policy, or on transient streaming errors.
                engine_csb = self._connection_string(self.cluster_uri)
                self._ingest_client = self._build_managed_streaming_client(
                    kingest, engine_csb, dm_csb
                )
        return self._ingest_client

    @staticmethod
    def _build_managed_streaming_client(kingest, engine_csb, dm_csb):
        """Construct a ManagedStreamingIngestClient, tolerant of SDK constructor shape.

        Newer ``azure-kusto-ingest`` releases expose the explicit
        ``ManagedStreamingIngestClient(engine_kcsb, dm_kcsb)`` constructor; some
        versions only surface the ``from_engine_kcsb`` factory (which derives the
        DM endpoint by adding the ``ingest-`` prefix itself). Fall back to a plain
        queued client if the managed streaming client is unavailable.
        """
        managed = getattr(kingest, "ManagedStreamingIngestClient", None)
        if managed is None:  # pragma: no cover - very old SDK
            return kingest.QueuedIngestClient(dm_csb)
        try:
            return managed(engine_csb, dm_csb)
        except TypeError:  # pragma: no cover - signature varies by SDK version
            return managed.from_engine_kcsb(engine_csb)

    @staticmethod
    def _data_format_csv():
        """Return the CSV ``DataFormat`` enum, tolerant of SDK layout changes.

        In current ``azure-kusto-data``/``azure-kusto-ingest`` releases ``DataFormat``
        lives in :mod:`azure.kusto.data.data_format`; older versions re-exported it
        from :mod:`azure.kusto.ingest`. Try the modern location first, then fall back.
        """
        try:
            from azure.kusto.data.data_format import DataFormat  # type: ignore

            return DataFormat.CSV
        except Exception:  # pragma: no cover - depends on installed SDK version
            kingest = _require("azure.kusto.ingest", "azure-kusto-ingest")
            return kingest.DataFormat.CSV

    def ingest_rows(
        self,
        table: str,
        rows: Iterable[dict],
        columns: Sequence[str] | None = None,
    ) -> int:
        """Ingest ``rows`` (list of dicts) into ``table``. Returns row count.

        Uses the client's configured ingest mode (managed streaming by default, so
        small result sets land within seconds; large payloads fall back to queued).
        """
        pd = _require("pandas", "pandas")
        kingest = _require("azure.kusto.ingest", "azure-kusto-ingest")
        rows = list(rows)
        if not rows:
            return 0
        frame = pd.DataFrame(rows, columns=columns) if columns else pd.DataFrame(rows)
        props = kingest.IngestionProperties(
            database=self.database,
            table=table,
            data_format=self._data_format_csv(),
        )
        client = self._get_ingest_client()
        client.ingest_from_dataframe(frame, ingestion_properties=props)
        return len(rows)
