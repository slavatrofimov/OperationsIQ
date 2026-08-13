---
id: index
title: User Guide
slug: /
sidebar_position: 1
---

# Operations IQ — User Guide

Operations IQ turns operational time-series data into business-ready
intelligence. It helps you **explore** signals, **diagnose** problems,
**plan** ahead with forecasts, **discover** recurring patterns and anomalies,
raise **alerts**, and capture your findings as **investigations**.

The app queries a Fabric **Eventhouse** (KQL) for time-series reads and persists
your work (labels, saved searches, models, investigations) to the **Rayfin**
backend. Everything you do in the browser is read-only against the Eventhouse —
your findings and annotations are saved separately.

## Find your way

The guide is organized to mirror the app's navigation, so the docs match what
you see on screen.

<ModuleCards items={[
  {title: 'Getting started', to: '/user/getting-started/overview', desc: 'Sign in, pick a persona, read charts, and select signals.'},
  {title: 'Explore', to: '/user/explore/', desc: 'Overview, trends, spectrum, similarity search, compare, heatmaps.'},
  {title: 'Diagnose', to: '/user/diagnose/', desc: 'Explain relationships, monitor signal health, and triage recorded findings.'},
  {title: 'Planning', to: '/user/planning/', desc: 'Forecast signals and run what-if scenarios.'},
  {title: 'Patterns', to: '/user/patterns/', desc: 'Discover anomalies, classifiers, segments, and motifs.'},
  {title: 'Activator Alerts', to: '/user/activator-alerts', desc: 'Manage scheduled Fabric alerts that email you on new matches.'},
  {title: 'Investigations', to: '/user/investigations', desc: 'Capture analysis into named case studies.'},
  {title: 'Personas', to: '/user/personas/', desc: 'Guided walkthroughs for common roles.'},
]} />

## Annotate what you see

Most analysis charts support **annotations** — your own notes pinned to a
point or shaded across a time span, alongside any Eventhouse events. Look for
the **Annotate** toolbar button, then drag across the chart (or click a single
point) to add one. Annotations are available on: Explore, Monitor, Forecast,
Change Points, Decomposition, Discover, Control Chart, Segmentation, Derived,
Signal Validation, Scenario, and Live View. A **timeline table** below each
chart lists all markers so you can filter, edit, or delete your own.

## New here?

Start with **[Getting started](/user/getting-started/overview)** for the basics,
then follow the **[persona walkthrough](/user/personas/)** that matches your
role. Unfamiliar terms are defined in the **[Glossary](/user/glossary)**.
