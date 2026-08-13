/**
 * Central, reviewable copy for the app's explainability features
 * (functional spec §Democratization).
 *
 * Each analytical page has an entry describing, in plain language:
 *  - `overview`      — what the page does and why you'd use it
 *  - `interpretation`— how to read the results
 *  - `technical`     — the underlying algorithms/KQL functions, for expert users
 *  - `inputs`        — per-control explanations (used by info icons)
 *  - `outputs`       — per-output descriptions (charts, tables, stat panels)
 *
 * Keeping the strings here (rather than inline in each page) makes the copy easy
 * to review, translate, and reuse. Copy is split into per-navigation-group
 * modules under `./explainers/` so it stays manageable and mergeable.
 *
 * NOTE: This copy is AI-drafted from existing in-app text and docs and is
 * flagged for domain-expert review.
 */

import { EXPLORE_EXPLAINERS } from './explainers/explore';
import { DIAGNOSE_EXPLAINERS } from './explainers/diagnose';
import { FORECAST_EXPLAINERS } from './explainers/forecast';
import { MONITOR_EXPLAINERS } from './explainers/monitor';
import { DATA_EXPLAINERS } from './explainers/data';

export interface PageExplainer {
  overview: string;
  interpretation?: string;
  technical?: string;
  inputs?: Record<string, string>;
  outputs?: Record<string, string>;
}

export const EXPLAINERS: Record<string, PageExplainer> = {
  ...EXPLORE_EXPLAINERS,
  ...DIAGNOSE_EXPLAINERS,
  ...FORECAST_EXPLAINERS,
  ...MONITOR_EXPLAINERS,
  ...DATA_EXPLAINERS,
};
