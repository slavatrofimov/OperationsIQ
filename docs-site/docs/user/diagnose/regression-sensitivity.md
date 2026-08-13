---
id: regression-sensitivity
title: Regression & sensitivity
sidebar_position: 3
---

# Regression & sensitivity

This module fits a model relating a **target** signal to one or more **driver**
signals, and shows how sensitive the target is to each driver.

## When to use it

- You want to quantify "how much does X change when Y changes?"
- You need to rank drivers by their impact on a target.
- You're building a simple predictive relationship for planning or monitoring.

## How to use it

1. Choose the target signal you want to explain.
2. Choose the driver signals to include.
3. Review the fitted relationship and the per-driver sensitivities.

## Reading the results

- Sensitivity tells you the direction and magnitude of each driver's effect.
- Model fit indicates how well the drivers explain the target — a poor fit means
  important drivers may be missing.

## Related

- [Root cause](./root-cause) for diagnosing a specific excursion.
- [Scenario / what-if](/user/planning/what-if) to test hypothetical driver values.
