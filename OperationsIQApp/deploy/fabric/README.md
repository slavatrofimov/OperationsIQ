# Fabric item deployment (fabric-cicd + REST fallback)

`deploy_fabric.py` publishes the item definitions under `items/` into an
existing Fabric workspace with [fabric-cicd](https://microsoft.github.io/fabric-cicd/),
then resolves the created item ids via the Fabric REST API and prints them as a
`RESULT_JSON={...}` line the orchestrator captures.

## Install

```bash
python -m pip install -r requirements.txt
az login   # AzureCliCredential is used by default; or set FABRIC_TOKEN
```

## Run

```bash
# Lakehouse (M2a)
python deploy_fabric.py --workspace-id <guid> --items lakehouse

# New Eventhouse + child KQL database (M2c)
python deploy_fabric.py --workspace-id <guid> --items eventhouse \
    --kql-database-name OperationsIQSample

# Multiple
python deploy_fabric.py --workspace-id <guid> --items lakehouse,sparkjob
```

## Items

| Folder | Type | Orchestrator module |
|--------|------|---------------------|
| `items/OperationsIQ.Lakehouse` | Lakehouse | `lakehouse` (M2a) |
| `items/OperationsIQ.SparkJobDefinition` | SparkJobDefinition | `spark-job` (M2b, optional) |
| `items/OperationsIQ.Eventhouse` | Eventhouse | `eventhouse-new` (M2c, optional) |

All items use the display name `OperationsIQ`; the driver resolves ids by
`(type, displayName)`. Adjust `parameter.yml` for environment-specific
substitutions (e.g. binding the Spark Job Definition to a lakehouse id).

## App Backend (RayFin) — not fabric-cicd

fabric-cicd does not support the Fabric App backend. Use the rayfin CLI
(`npm run rayfin:up`, recommended — it also applies the SQL schema). The
`rest/create_app_backend.py` script is the lower-level fallback that only creates
the item; you still run `npm run rayfin:db:apply` afterwards.
