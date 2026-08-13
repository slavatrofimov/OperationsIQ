---
id: navigation-and-personas
title: Navigation & personas
sidebar_position: 3
---

# Navigation & personas

The top navigation bar groups modules by the kind of work you're doing:

- **Explore** — visualize and search signals, including a real-time **Live view**.
- **Diagnose** — explain relationships and monitor health.
- **Diagnose** — explain relationships and monitor health, including
  **Diagnostic Findings** (the recorded-findings review queue).
- **Planning** — forecast and run scenarios.
- **Patterns** — discover motifs, anomalies, segments, and classifiers.
- **Playbooks** — expert-authored, industry-specific operational playbooks that
  hand off to the Operations Advisor. See [Playbooks](./playbooks).
- **Activator Alerts** — manage the scheduled Fabric Activator alerts you create
  from a similarity search.
- **Investigations** — your saved case studies.

## Personas

Operations IQ tailors the navigation to your role. Choose the persona that best
matches how you work; it reorders and emphasizes the modules most relevant to
you (you can still reach everything):

- **Production engineer** — day-to-day operations, health monitoring, and quick
  diagnosis.
- **Operations analyst** — deeper exploration, pattern discovery, forecasting,
  and reporting.
- **Field technician** — focused, task-oriented views for on-site work.

See the [persona walkthroughs](/user/personas/) for role-based tours.

## Presets and deep links

Some navigation entries open a module in a specific **preset** — for example
Patterns → **Anomalies** opens the discovery module, where you scan a single
signal for rare subsequences (shape discords) or run a multivariate anomaly scan
across two or more signals, and the Matrix Profile recipes (Normal cycles, Regime change,
Slow degradation, etc.) open the Patterns wizard preconfigured for that goal.

## Connections

Which Eventhouse and signals you see is determined by the active **connection
profile**. Open the **settings** control in the top bar to switch profiles or
open the **Connections** screen, where you can add or edit a profile (its
Eventhouse endpoint, database, and the queries that populate the signal browser).
When you set up a profile, the Connections screen can **auto-discover** your Fabric
workspaces, Eventhouses, and KQL databases and lists them alphabetically so they're
easy to pick. Setting up profiles is usually an administrator task — see
[Admin → Configuration](/admin/configuration).
