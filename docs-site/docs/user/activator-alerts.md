---
id: activator-alerts
title: Activator Alerts
sidebar_position: 7
---

# Activator Alerts

**Activator Alerts** are standing, server-side alerts that run entirely inside
Microsoft Fabric. Each one is a scheduled KQL **similarity search** that runs on a
frequency you choose and **emails you on each new match** — no app or browser
needs to be open for it to fire.

Activator Alerts are a top-level menu item (the former **Alert Center** grouping
is gone). The page lists the alerts you've created and guides you through two ways
to set one up. Alerts can be created from both a
[Similarity search](/user/explore/similarity-search) and from anomaly detection on
the [Anomalies](/user/patterns/anomalies#alerting-on-anomalies) page — both the
multi-signal MVAD detectors and single-signal SAX discords (with a detection
window enabled).

## Creating an alert

You create an Activator Alert from a completed
[Similarity search](/user/explore/similarity-search#create-an-activator-alert-from-a-search).
Two setup paths lead there:

- **Search for a shape you already know** — run a Similarity search, then choose
  **Create an Activator Alert**.
- **Discover an unknown pattern first** — find a shape via **Deep discovery** in
  the [Patterns](/user/patterns/) menu, use **Find more like these** to seed a
  Similarity search, then create the alert.

When you create the alert you set its name, run **frequency**, a minimum
**similarity threshold** (so weak matches don't fire), and the email subject and
message. The alert then runs in Fabric on that schedule.

:::note
Creating an Activator Alert requires a connection profile that was linked to
Fabric via **Discover from Fabric** (it stores the workspace and source KQL
database identifiers). Profiles set up by manual endpoint entry can't create
alerts until you re-run **Discover from Fabric** on them in Settings.
:::

## Managing alerts

Each row shows the alert name, the connection profile it runs against, its run
frequency, and the signals it watches. Use **Open in Fabric** to manage the rule,
change its action (email, Teams, pipeline), or disable it.

**Deleting a pointer.** Deleting an alert here removes only the app-side pointer —
the Fabric Activator item, its rule, and its schedule are left running. To stop an
alert entirely, open it in Fabric and disable or delete the rule there.

## Related

- [Similarity search](/user/explore/similarity-search) — where alerts are created.
- [Diagnostic Findings](/user/diagnose/diagnostic-findings) — the human-curated
  review queue for diagnostics you record in-app (distinct from Activator Alerts).
