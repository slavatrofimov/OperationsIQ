---
id: fabric-items
title: Fabric items (manual)
sidebar_position: 6
---

# Fabric items — manual alternative

Three modules publish Fabric items with **fabric-cicd** (`deploy/fabric/deploy_fabric.py`),
falling back to the Fabric REST API where fabric-cicd doesn't cover an item type:

| Module | Item | Optional |
|--------|------|----------|
| `lakehouse` | Lakehouse (runs the Livy/Spark pattern analyses) | no |
| `spark-job` | Spark Job Definition (headless analysis path) | yes |
| `eventhouse-new` | New Eventhouse + KQL database (seeded sample) | yes |

All three target an **existing Fabric workspace on an existing capacity** — the
capacity is never provisioned. Supply the workspace id via config
(`workspaceId`) or `outputs/*.json`.

## fabric-cicd path

```powershell
cd OperationsIQApp/deploy/fabric
pip install -r requirements.txt
python deploy_fabric.py --workspace-id <workspace-guid> --items Lakehouse
```

The driver publishes the item folders under `deploy/fabric/items/`
(`OperationsIQ.Lakehouse`, `OperationsIQ.SparkJobDefinition`,
`OperationsIQ.Eventhouse`), then resolves each item's id from the Fabric REST
API by `(type, displayName)` and prints a `RESULT_JSON=` line the orchestrator
parses. Authentication uses `AzureCliCredential` (so `az login` first).

## Manual portal path

### Lakehouse
1. In the workspace, **New → Lakehouse**, name it `OperationsIQ`.
2. Copy its **item id** from the URL or item settings.

### Spark Job Definition (optional)
1. **New → Spark Job Definition**; point it at the packaged analysis
   (`deploy/fabric/items/OperationsIQ.SparkJobDefinition/pattern_analysis.py`).
2. This path is opt-in — the SPA already inlines the `tsmp` package into each
   Livy statement, so the standard deployment doesn't need it.

### Eventhouse + KQL DB (optional, sample/demo only)
1. **New → Eventhouse**, name it `OperationsIQ`; a default KQL database is
   created with it.
2. Note the **query URI** (`https://<cluster>.kusto.fabric.microsoft.com`), the
   **Eventhouse item id**, and the **KQL database name**.
3. Follow [Eventhouse deployment](../eventhouse-deployment) to load the schema
   and the [sample data](../eventhouse-deployment). When driven by the pipeline,
   set `"eventhouseMode": "greenfield-sample"`.

## Outputs to hand off

- `outputs/lakehouse.json`: `{ "lakehouseId": "…", "workspaceId": "…" }`
- `outputs/spark-job.json`: `{ "sparkJobDefId": "…" }`
- `outputs/eventhouse-new.json`: `{ "eventhouseId": "…", "clusterUri": "…", "kqlDatabaseId": "…", "sampleDatabaseName": "OperationsIQSample" }`
