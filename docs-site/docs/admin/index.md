---
id: index
title: Admin Guide
slug: /
sidebar_position: 1
---

# Operations IQ — Administrator Guide

This guide takes Operations IQ from source to a running deployment on Microsoft
Fabric, and covers day-2 operations: identity, permissions, configuration, and
governance.

## Who this is for

Administrators and operators responsible for deploying and running Operations IQ
in a Fabric tenant. It assumes familiarity with the Fabric portal, Entra ID
(app registrations), and basic command-line tooling.

## What you'll deploy

Operations IQ has four cooperating planes:

<ModuleCards items={[
  {title: 'Data plane', to: '/admin/eventhouse-deployment', desc: 'Fabric Eventhouse / KQL database holding time-series + SAX function library.'},
  {title: 'Compute plane', to: '/admin/spark-compute', desc: 'Spark job for Matrix Profile pattern discovery.'},
  {title: 'Control plane', to: '/admin/rayfin-backend', desc: 'Rayfin (Fabric Apps) backend: SQL + GraphQL + hosting.'},
  {title: 'Identity', to: '/admin/entra-app-registration', desc: 'Entra app registrations for Fabric SSO and Eventhouse access.'},
]} />

## Recommended order

1. [Prerequisites](/admin/prerequisites)
2. [Architecture](/admin/architecture)
3. [Eventhouse deployment](/admin/eventhouse-deployment)
4. [Entra app registration](/admin/entra-app-registration)
5. [Rayfin backend](/admin/rayfin-backend)
6. [Spark compute](/admin/spark-compute)
7. [Configuration](/admin/configuration)
8. [Permissions & governance](/admin/permissions-governance)

Prefer to automate it? The [Automated deployment](/admin/deploy/overview) section
drives all of the above from one modular orchestrator — deploy everything with a
single command, or run only the modules your permissions allow. For a condensed
manual checklist, see the [Deploy runbook](/admin/deploy-runbook).

:::info
This guide summarizes and links to the authoritative source docs in the repo
(`OperationsIQApp/README.md` and `OperationsIQApp/docs/runbook.md`). When in
doubt, those files — versioned alongside the code — are the source of truth.
:::
