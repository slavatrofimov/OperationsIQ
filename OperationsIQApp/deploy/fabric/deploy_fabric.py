#!/usr/bin/env python3
"""fabric-cicd driver for the Operations IQ Fabric items.

Publishes the selected item types (Lakehouse, Spark Job Definition, Eventhouse)
into an existing Fabric workspace using the ``fabric-cicd`` library, then
resolves the created item ids by querying the Fabric REST API and prints them as
a single machine-readable line the PowerShell orchestrator captures:

    RESULT_JSON={"lakehouseId": "...", ...}

For the optional new-Eventhouse path it also creates a child KQL database (the
payload fabric-cicd does not express directly) via the REST API, mirroring
eventhouse/deploy/Retrofit-Eventhouse.ps1.

Auth: uses AzureCliCredential (``az login``) by default so it shares the same
identity as the rest of the toolchain. Set FABRIC_TOKEN to override.

Usage:
    python deploy_fabric.py --workspace-id <guid> --items lakehouse
    python deploy_fabric.py --workspace-id <guid> --items eventhouse \
        --kql-database-name OperationsIQSample
    python deploy_fabric.py --workspace-id <guid> --items lakehouse,sparkjob
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

FABRIC_BASE = "https://api.fabric.microsoft.com/v1"
FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default"

# Map our short item keys to (fabric-cicd item type, source folder name).
ITEM_TYPES = {
    "lakehouse": ("Lakehouse", "OperationsIQ.Lakehouse"),
    "sparkjob": ("SparkJobDefinition", "OperationsIQ.SparkJobDefinition"),
    "eventhouse": ("Eventhouse", "OperationsIQ.Eventhouse"),
}

# Result key per item type.
RESULT_KEY = {
    "Lakehouse": "lakehouseId",
    "SparkJobDefinition": "sparkJobDefId",
    "Eventhouse": "eventhouseId",
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def get_token() -> str:
    token = os.environ.get("FABRIC_TOKEN", "").strip()
    if token:
        return token
    from azure.identity import AzureCliCredential

    cred = AzureCliCredential()
    return cred.get_token(FABRIC_SCOPE).token


def _credential():
    if os.environ.get("FABRIC_TOKEN", "").strip():
        return None
    from azure.identity import AzureCliCredential

    return AzureCliCredential()


def rest(method: str, url: str, token: str, body: dict | None = None) -> dict:
    import requests

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    resp = requests.request(method, url, headers=headers, json=body, timeout=120)
    if resp.status_code == 202:
        # Long-running operation: poll the operation location until done.
        return _poll_lro(resp, token)
    if not resp.ok:
        raise RuntimeError(f"{method} {url} -> {resp.status_code}: {resp.text}")
    if resp.text:
        return resp.json()
    return {}


def _poll_lro(resp, token: str) -> dict:
    import requests

    op_url = resp.headers.get("Location")
    if not op_url:
        return {}
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(5)
        poll = requests.get(op_url, headers=headers, timeout=60)
        if poll.status_code in (200, 201):
            state = poll.json().get("status", "").lower()
            if state in ("succeeded", "completed"):
                result_url = poll.headers.get("Location") or op_url
                final = requests.get(result_url, headers=headers, timeout=60)
                return final.json() if final.text else {}
            if state in ("failed", "cancelled"):
                raise RuntimeError(f"Fabric operation {state}: {poll.text}")
    raise RuntimeError("Timed out waiting for Fabric long-running operation.")


def publish_items(workspace_id: str, item_type_names: list[str]) -> None:
    """Publish the requested item types with fabric-cicd."""
    from fabric_cicd import FabricWorkspace, publish_all_items

    repo_dir = str(Path(__file__).parent / "items")
    cred = _credential()
    kwargs = dict(
        workspace_id=workspace_id,
        repository_directory=repo_dir,
        item_type_in_scope=item_type_names,
    )
    if cred is not None:
        kwargs["token_credential"] = cred
    log(f"Publishing {item_type_names} from {repo_dir} into workspace {workspace_id}...")
    workspace = FabricWorkspace(**kwargs)
    publish_all_items(workspace)


def list_items(workspace_id: str, token: str) -> list[dict]:
    items: list[dict] = []
    url = f"{FABRIC_BASE}/workspaces/{workspace_id}/items"
    import requests

    headers = {"Authorization": f"Bearer {token}"}
    while url:
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        items.extend(data.get("value", []))
        url = data.get("continuationUri")
    return items


def resolve_ids(workspace_id: str, token: str, item_type_names: list[str]) -> dict:
    """Find the published items by type + our known display name."""
    items = list_items(workspace_id, token)
    result: dict[str, str] = {}
    for t in item_type_names:
        match = next(
            (
                it
                for it in items
                if it.get("type") == t and it.get("displayName") == "OperationsIQ"
            ),
            None,
        )
        if match:
            result[RESULT_KEY[t]] = match["id"]
        else:
            log(f"WARNING: could not resolve id for {t} (displayName 'OperationsIQ').")
    return result


def eventhouse_query_uri(workspace_id: str, eventhouse_id: str, token: str) -> str | None:
    url = f"{FABRIC_BASE}/workspaces/{workspace_id}/eventhouses/{eventhouse_id}"
    data = rest("GET", url, token)
    props = data.get("properties", {})
    return props.get("queryServiceUri") or props.get("queryServiceUrl")


def create_kql_database(
    workspace_id: str, eventhouse_id: str, db_name: str, token: str
) -> str | None:
    """Create (or reuse) a KQL database under the Eventhouse. Returns its id."""
    list_url = f"{FABRIC_BASE}/workspaces/{workspace_id}/kqlDatabases"
    existing = rest("GET", list_url, token).get("value", [])
    match = next((d for d in existing if d.get("displayName") == db_name), None)
    if match:
        log(f"KQL database '{db_name}' already exists ({match['id']}); reusing.")
        return match["id"]
    body = {
        "displayName": db_name,
        "creationPayload": {
            "databaseType": "ReadWrite",
            "parentEventhouseItemId": eventhouse_id,
        },
    }
    log(f"Creating KQL database '{db_name}'...")
    rest("POST", list_url, token, body)
    deadline = time.time() + 300
    while time.time() < deadline:
        time.sleep(5)
        existing = rest("GET", list_url, token).get("value", [])
        match = next((d for d in existing if d.get("displayName") == db_name), None)
        if match:
            return match["id"]
    raise RuntimeError(f"Timed out creating KQL database '{db_name}'.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Operations IQ fabric-cicd driver.")
    ap.add_argument("--workspace-id", required=True)
    ap.add_argument("--items", required=True, help="comma list: lakehouse,sparkjob,eventhouse")
    ap.add_argument("--kql-database-name", default="OperationsIQSample")
    args = ap.parse_args()

    keys = [k.strip().lower() for k in args.items.split(",") if k.strip()]
    unknown = [k for k in keys if k not in ITEM_TYPES]
    if unknown:
        log(f"Unknown item keys: {unknown}. Valid: {list(ITEM_TYPES)}")
        return 2

    type_names = [ITEM_TYPES[k][0] for k in keys]

    publish_items(args.workspace_id, type_names)

    token = get_token()
    result = resolve_ids(args.workspace_id, token, type_names)

    # New-Eventhouse path: resolve cluster URI + create the child KQL database.
    if "eventhouse" in keys and result.get("eventhouseId"):
        eh_id = result["eventhouseId"]
        uri = eventhouse_query_uri(args.workspace_id, eh_id, token)
        if uri:
            result["clusterUri"] = uri
        kql_id = create_kql_database(
            args.workspace_id, eh_id, args.kql_database_name, token
        )
        if kql_id:
            result["kqlDatabaseId"] = kql_id

    print("RESULT_JSON=" + json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
