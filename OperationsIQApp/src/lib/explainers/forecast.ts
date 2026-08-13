import type { PageExplainer } from '../explainers';

/**
 * Explainer copy for the "Forecast" navigation group:
 * forecast, scenario.
 */
export const FORECAST_EXPLAINERS: Record<string, PageExplainer> = {
  forecast: {
    overview:
      'Forecast projects a signal into the future from its recent history, so you can anticipate where a value is heading and how likely it is to cross a limit you care about. Pick a signal and a history window, choose how far ahead to look, and the app extrapolates the trend and repeating cycles it has learned.',
    interpretation:
      'The solid line is the most likely future path; the shaded band around it shows the range of plausible outcomes — it widens further out because uncertainty grows the further ahead you look. If you set a threshold, the breach probability tells you how likely the signal is to cross that limit within the horizon, and when it first becomes likely.',
    technical:
      'Historical values are decomposed into seasonal, level/trend, and residual components. The repeating seasonal pattern is projected forward on top of a roughly flat average level; by default the model does not extrapolate a rising or falling trend line. Prediction bands are sized from the in-sample residual standard deviation (σ) — a rough error estimate, not a backtested forecast error — widened by the square root of steps ahead under a random-walk, approximately-normal error assumption and scaled by the z-score for the chosen confidence (wider confidence → wider band). Breach probabilities assume approximately-normal, independent per-step errors, so they are approximate and can over- or under-estimate risk; they are not a guaranteed upper bound.',
    inputs: {
      tag: 'The signal to forecast. Its recent history over the selected range is used to learn the trend and seasonal pattern.',
      range: 'The history window used to fit the forecast. Longer windows capture more seasonality but weight older behavior more heavily.',
      horizon: 'How many future bins (time steps) to project. One bin equals the current binning interval, so the real horizon depends on your bin width.',
      confidence: 'The confidence level for the prediction band. Higher confidence (e.g. 95%) produces a wider band that is more likely to contain the actual value.',
      threshold: 'An optional limit value. When set, the app estimates the probability the forecast crosses it within the horizon.',
      direction: 'Whether a breach means the signal goes above or below the threshold.',
      quantiles: 'Overlay the P10 / P50 / P90 lines — the 10th, 50th (median), and 90th percentile paths — to see the spread explicitly.',
      seasonality:
        'The length of the repeating cycle, in bins (for example, 24 bins for a daily cycle on hourly data). Leave blank to let the forecast auto-detect the dominant period, or use "Detect cycles" to find candidate periods and apply one.',
    },
    outputs: {
      chart:
        'The forecast chart shows recent history and the projected path. The line is the expected value; the shaded band is the prediction interval at your chosen confidence. Any threshold you set is drawn as a reference line.',
      exceedance:
        'This readout summarizes threshold risk: the peak per-bin breach probability, when it occurs, and the first time the signal is more likely than not (≥50%) to have breached.',
    },
  },
  scenario: {
    overview:
      'What-if lets you start from a real signal history and test simple operating changes before taking action. You can scale, offset, ramp, or cap the baseline values and immediately see how the alternative path changes key business and operating metrics. The page is meant for transparent scenario planning, not automatic control.',
    interpretation:
      'Compare the baseline and scenario lines to see when your adjustment matters most. The Key Performance Indicator (KPI) table shows the practical impact in averages, peaks, total exposure, and time near limits; risk flags call out changes that may deserve operator review.',
    technical:
      'The baseline signal is aligned to an even time grid, then deterministic point-by-point adjustments apply scaling, offsets, ramps, and clamps. KPI comparisons summarize levels, exposure, and limit time before and after adjustment, while simple rule checks flag scenarios that may need review. There is no hidden predictive model.',
    inputs: {
      tag: 'The real signal used as the baseline for the scenario. The scenario starts from this history and applies your selected adjustments point by point.',
      range: 'The time window used for the baseline. Choose a period that represents the operating condition you want to test.',
      upperLimit: 'An optional upper operating limit. It is drawn on the chart and used to calculate time above limit and risk flags.',
      lowerLimit: 'An optional lower operating limit. It is used to flag scenario values that fall below an acceptable floor.',
      scale: 'Multiplies every baseline value by this factor when the scale adjustment is enabled. Use values above 1 to increase the signal and below 1 to reduce it.',
      offset: 'Adds this constant amount to every baseline value when the offset adjustment is enabled.',
      ramp: 'Adds a gradually increasing change from the start of the window to this final amount at the end.',
      min: 'The lowest value allowed by the clamp adjustment. Values below this floor are lifted to the minimum.',
      max: 'The highest value allowed by the clamp adjustment. Values above this ceiling are capped at the maximum.',
      name: 'A human-readable name for the scenario run so it can be recognized later.',
    },
    outputs: {
      chart:
        'The chart overlays the original baseline and the adjusted scenario on the same time axis. Limit lines, when provided, show where either path approaches or crosses an operating boundary.',
      kpis:
        'The KPI comparison translates the scenario into operational measures: average, peak, minimum, total value over time, and time above the upper limit when one is set.',
      flags:
        'Risk flags are simple rule-based warnings from the scenario results. Treat them as prompts for review, not as automated decisions.',
    },
  },
};
