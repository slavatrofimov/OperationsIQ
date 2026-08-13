import type { PageExplainer } from '../explainers';

/**
 * Explainer copy for the "Data" and standalone pages:
 * derived, models, playbooks, investigations, config.
 *
 * Copy is intentionally plain-language first, with technical notes only where
 * the page runs a specific method or lifecycle operation.
 */
export const DATA_EXPLAINERS: Record<string, PageExplainer> = {
  derived: {
    overview:
      'Derived metrics let you combine one or more existing signals into a new calculated series. Use them when the raw tags do not directly answer the business question, such as comparing two sensors, calculating a ratio, or smoothing a noisy value. The chart shows the selected source signals alongside the derived result so you can confirm the calculation makes sense.',
    interpretation:
      'Aliases such as A, B, and C represent the base tags you selected. The derived line is the formula evaluated at each aligned time bin; missing or invalid inputs leave a gap rather than inventing a value. Rate of change highlights movement from one bin to the next, while rolling mean smooths short-term noise.',
    technical:
      'Base signals are resampled onto a shared time grid and aligned by timestamp before the formula is evaluated for each bin. Invalid or missing inputs propagate as gaps. Optional post-processing can compute bin-to-bin rate of change or a rolling mean, and summary statistics are calculated from the valid derived values.',
    inputs: {
      baseTags:
        'The source signals used in the calculation. They are assigned aliases A, B, C, and so on, which you reference in the formula.',
      range:
        'The time window to load for every base signal. All selected tags are aligned to the same bins before the formula is evaluated.',
      formula:
        'The calculation to run for each time bin, using aliases like A and B plus supported math functions. For example, A - B shows the difference between two signals.',
      transform:
        'An optional post-processing step for the derived result. Use rate of change to see movement between bins, or rolling mean to smooth the series.',
      window:
        'The number of bins included in the rolling mean. Larger windows produce smoother results but can hide short-lived changes.',
      metricName:
        'A friendly name used when saving this formula for reuse with the current connection profile.',
    },
    outputs: {
      savedMetrics:
        'Saved metrics are reusable formulas tied to the active connection profile. Loading one restores its base tags, formula, transform, and binning settings.',
      chart:
        'The chart overlays the base signals and the calculated result. Use it to verify that the formula tracks the expected behavior and to spot gaps caused by missing input data.',
      stats:
        'These statistics summarize the derived result only: how many bins produced values, the range, the average and median, and how much the result varies.',
    },
  },
  playbooks: {
    overview:
      'Playbooks help you choose the right analysis path without having to know every page in the app. Each card is an expert-authored playbook for a common operational question and shows the steps in the recommended order. Playbooks can be filtered by industry and category, or found quickly with the keyword search.',
    interpretation:
      'Start with the playbook that best matches your situation, review its steps, and use Configure only if you need to tune the defaults before launching.',
  },
  investigations: {
    overview:
      'Investigations collect evidence from analysis pages into a shared case file. Use this page to review captured notes, charts, and exported data in one place instead of searching across separate views.',
    interpretation:
      'Open an investigation to review its evidence, download chart artifacts when needed, and delete items that no longer belong in the case.',
  },
  config: {
    overview:
      'Connections define where the app reads time-series data and how that data maps to the app’s standard fields. Use this page to discover Fabric Eventhouses, enter a database manually, test the connection, and adjust query or terminology settings. Saving a connection profile makes the rest of the app use that data source.',
    interpretation:
      'Start with Fabric discovery when available, then use Test Connection before saving. Only adjust the default queries or labels when your source schema uses different names or needs custom mapping.',
  },
};
