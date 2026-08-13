"""Unit tests for the fabric-cicd driver and REST fallback argument/response
shaping. Network calls are mocked; no live Fabric access is required.

Run with:  python -m pytest deploy/fabric/tests
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

_FAB = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


df = _load("deploy_fabric", _FAB / "deploy_fabric.py")
cab = _load("create_app_backend", _FAB / "rest" / "create_app_backend.py")


# ---------------------------------------------------------------------------
# deploy_fabric.py
# ---------------------------------------------------------------------------


def test_item_type_mapping_is_consistent():
    # Every mapped item key resolves to a type that has a result key.
    for _key, (type_name, folder) in df.ITEM_TYPES.items():
        assert type_name in df.RESULT_KEY
        assert folder.startswith("OperationsIQ.")


def test_resolve_ids_matches_by_type_and_display_name(monkeypatch):
    items = [
        {"id": "lh-1", "type": "Lakehouse", "displayName": "OperationsIQ"},
        {"id": "other", "type": "Lakehouse", "displayName": "SomethingElse"},
        {"id": "eh-1", "type": "Eventhouse", "displayName": "OperationsIQ"},
    ]
    monkeypatch.setattr(df, "list_items", lambda ws, tok: items)
    result = df.resolve_ids("ws", "tok", ["Lakehouse", "Eventhouse"])
    assert result == {"lakehouseId": "lh-1", "eventhouseId": "eh-1"}


def test_resolve_ids_skips_unresolved(monkeypatch):
    monkeypatch.setattr(df, "list_items", lambda ws, tok: [])
    result = df.resolve_ids("ws", "tok", ["Lakehouse"])
    assert result == {}


def test_create_kql_database_reuses_existing(monkeypatch):
    calls = []

    def fake_rest(method, url, token, body=None):
        calls.append((method, url, body))
        if method == "GET":
            return {"value": [{"id": "kql-9", "displayName": "OperationsIQSample"}]}
        raise AssertionError("should not POST when the database already exists")

    monkeypatch.setattr(df, "rest", fake_rest)
    got = df.create_kql_database("ws", "eh", "OperationsIQSample", "tok")
    assert got == "kql-9"
    assert all(c[0] == "GET" for c in calls)


def test_create_kql_database_creates_when_absent(monkeypatch):
    state = {"created": False}

    def fake_rest(method, url, token, body=None):
        if method == "POST":
            state["created"] = True
            # POST body must reference the parent Eventhouse + ReadWrite type.
            assert body["creationPayload"]["parentEventhouseItemId"] == "eh"
            assert body["creationPayload"]["databaseType"] == "ReadWrite"
            assert body["displayName"] == "NewDb"
            return {}
        # GET: absent before create, present after.
        if state["created"]:
            return {"value": [{"id": "kql-new", "displayName": "NewDb"}]}
        return {"value": []}

    monkeypatch.setattr(df, "time", types.SimpleNamespace(time=lambda: 0.0, sleep=lambda s: None))
    monkeypatch.setattr(df, "rest", fake_rest)
    got = df.create_kql_database("ws", "eh", "NewDb", "tok")
    assert got == "kql-new"
    assert state["created"] is True


# ---------------------------------------------------------------------------
# create_app_backend.py
# ---------------------------------------------------------------------------


class _Resp:
    def __init__(self, status_code=200, payload=None, headers=None, text="x"):
        self.status_code = status_code
        self._payload = payload or {}
        self.headers = headers or {}
        self.text = text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"status {self.status_code}")


def _fake_requests(monkeypatch, *, get=None, post=None):
    fake = types.ModuleType("requests")
    fake.get = get or (lambda *a, **k: _Resp())
    fake.post = post or (lambda *a, **k: _Resp())
    monkeypatch.setitem(sys.modules, "requests", fake)
    return fake


def test_find_existing_matches_display_name(monkeypatch):
    payload = {"value": [{"id": "app-1", "displayName": "Operations IQ"}]}
    _fake_requests(monkeypatch, get=lambda *a, **k: _Resp(200, payload))
    item = cab.find_existing("ws", "Operations IQ", "tok")
    assert item and item["id"] == "app-1"


def test_find_existing_returns_none_on_404(monkeypatch):
    _fake_requests(monkeypatch, get=lambda *a, **k: _Resp(404, text=""))
    assert cab.find_existing("ws", "Operations IQ", "tok") is None


def test_create_posts_expected_body(monkeypatch):
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["json"] = json
        return _Resp(201, {"id": "app-created"})

    _fake_requests(monkeypatch, post=fake_post)
    item = cab.create("ws-guid", "Operations IQ", "desc", "tok")
    assert item["id"] == "app-created"
    assert captured["url"].endswith("/workspaces/ws-guid/appBackends")
    assert captured["json"] == {"displayName": "Operations IQ", "description": "desc"}
