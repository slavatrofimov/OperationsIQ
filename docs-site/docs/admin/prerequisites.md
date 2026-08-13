---
id: prerequisites
title: Prerequisites
sidebar_position: 3
---

# Prerequisites

Before deploying Operations IQ, make sure the following are in place.

## Fabric tenant & capacity

- A **Microsoft Fabric** tenant with the **Fabric Apps (Rayfin)** workload enabled.
- A Fabric **capacity** to host the app, lakehouse, and Eventhouse.
- An **Eventhouse / KQL database** holding (or ready to hold) sensor time series.
- The tenant **Livy API** admin setting **enabled** (required for the Patterns /
  Spark path).

## Identity & permissions

- Rights to create **Entra ID app registrations** (or an admin who can), for both
  the Fabric SSO client and the Eventhouse (MSAL) SPA client.
- The ability to **grant admin consent** for delegated permissions (recommended,
  to avoid per-user consent prompts).
- The deploying user should be a **Contributor** on the workspace that hosts the
  lakehouse (Livy endpoint) and the Eventhouse.

## Local tooling

- **Node.js ≥ 20**
- **Python ≥ 3.10** (for the Spark job core and optional dispatcher)
- The **Rayfin CLI**: `npm i -g @microsoft/rayfin`
- **Azure CLI** (`az`) logged in to the target tenant. Entra app scope for
  provisioning: `https://api.fabric.microsoft.com/.default`.

### For the automated deployment orchestrator

The [automated deployment](./deploy/overview) modules add two tools on top of the
above (only needed for the modules you actually run):

- **Terraform ≥ 1.6** — for the `foundry`, `entra`, and `deploy-sp` modules
  (Azure + Entra resources). Install from
  [developer.hashicorp.com/terraform/install](https://developer.hashicorp.com/terraform/install).
- **fabric-cicd** (Python package) — for the `lakehouse`, `spark-job`, and
  `eventhouse-new` modules. Install with
  `pip install -r OperationsIQApp/deploy/fabric/requirements.txt`.

The `preflight` module checks all of these and reports what's missing before a
run.

## Source

- A clone of the repository, working in `OperationsIQApp/`.

## Next

Once prerequisites are met, continue with
[Eventhouse deployment](./eventhouse-deployment).
