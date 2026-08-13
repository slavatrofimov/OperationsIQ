#!/usr/bin/env python3
"""REST fallback for creating a Fabric App Backend item.

fabric-cicd does not support the Fabric App (RayFin) backend, so the RECOMMENDED
path is the rayfin CLI (`npm run rayfin:up`), which also applies the SQL schema.
This script is the lower-level fallback for environments where the CLI can't run:
it creates the App Backend item via the REST API cited in the Fabric docs

    POST https://api.fabric.microsoft.com/v1/workspaces/{workspaceId}/appBackends

Note: this ONLY creates the item. You must still apply the entity schema
afterwards with `npm run rayfin:db:apply`.

Auth: AzureCliCredential (`az login`) by default; set FABRIC_TOKEN to override.

Usage:
    python create_app_backend.py --workspace-id <guid> --display-name "Operations IQ"
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

FABRIC_BASE = "https://api.fabric.microsoft.com/v1"
FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default"


def get_token() -> str:
    token = os.environ.get("FABRIC_TOKEN", "").strip()
    if token:
        return token
    from azure.identity import AzureCliCredential

    return AzureCliCredential().get_token(FABRIC_SCOPE).token


def find_existing(workspace_id: str, display_name: str, token: str):
    import requests

    url = f"{FABRIC_BASE}/workspaces/{workspace_id}/appBackends"
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.get(url, headers=headers, timeout=60)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    for item in resp.json().get("value", []):
        if item.get("displayName") == display_name:
            return item
    return None


def create(workspace_id: str, display_name: str, description: str, token: str) -> dict:
    import requests

    url = f"{FABRIC_BASE}/workspaces/{workspace_id}/appBackends"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = {"displayName": display_name, "description": description}
    resp = requests.post(url, headers=headers, json=body, timeout=120)

    if resp.status_code in (200, 201):
        return resp.json()
    if resp.status_code == 202:
        # Long-running operation.
        op_url = resp.headers.get("Location")
        deadline = time.time() + 600
        while op_url and time.time() < deadline:
            time.sleep(5)
            poll = requests.get(op_url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
            status = poll.json().get("status", "").lower() if poll.text else ""
            if status in ("succeeded", "completed"):
                result_url = poll.headers.get("Location") or op_url
                final = requests.get(result_url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
                return final.json() if final.text else {}
            if status in ("failed", "cancelled"):
                raise RuntimeError(f"App backend creation {status}: {poll.text}")
        raise RuntimeError("Timed out creating the App Backend item.")
    raise RuntimeError(f"Create failed {resp.status_code}: {resp.text}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Create a Fabric App Backend item (REST fallback).")
    ap.add_argument("--workspace-id", required=True)
    ap.add_argument("--display-name", default="Operations IQ")
    ap.add_argument("--description", default="Operations IQ control plane (Fabric App backend).")
    args = ap.parse_args()

    token = get_token()
    existing = find_existing(args.workspace_id, args.display_name, token)
    if existing:
        print(f"App Backend '{args.display_name}' already exists ({existing.get('id')}); reusing.", file=sys.stderr)
        item = existing
    else:
        item = create(args.workspace_id, args.display_name, args.description, token)

    print("RESULT_JSON=" + json.dumps({"fabricItemId": item.get("id")}))
    print(
        "NOTE: the REST path does not apply the SQL schema. Run 'npm run rayfin:db:apply' next.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
