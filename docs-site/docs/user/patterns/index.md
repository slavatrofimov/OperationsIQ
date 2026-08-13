---
id: index
title: Patterns
sidebar_position: 0
---

# Patterns

The Patterns modules **discover structure automatically** — recurring shapes
(motifs), rare events (discords/anomalies), regimes, and trainable classifiers —
without you having to hand-pick a query.

## Quick interactive discovery

Fast, interactive tools that run against the Eventhouse:

<ModuleCards items={[
  {title: 'Anomalies', to: '/user/patterns/anomalies', desc: 'Find the rarest, most unusual subsequences (discords).'},
  {title: 'Classifiers', to: '/user/patterns/classifiers', desc: 'Train and apply interpretable SAX-VSM classifiers.'},
  {title: 'Segmentation', to: '/user/patterns/segmentation', desc: 'Break a signal into distinct regimes.'},
  {title: 'Process mining', to: '/user/patterns/process-mining', desc: 'Discover event-driven process flows.'},
]} />

## Deep discovery (Matrix Profile)

Spark-powered, wizard-driven discovery over long windows:

<ModuleCards items={[
  {title: 'Matrix Profile', to: '/user/patterns/matrix-profile', desc: 'Motif & discord discovery with recipes, run history, annotations, and a convergence meter.'},
]} />
