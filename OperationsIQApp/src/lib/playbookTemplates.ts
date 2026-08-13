import type { PageKey } from './pages';

/**
 * Playbook templates (functional spec §Playbooks / §Configurability).
 *
 * A *template* is an industry-agnostic operational pattern — "investigate an
 * anomaly", "diagnose underperformance", "detect drift" — expressed as an
 * ordered sequence of app steps. Domain playbooks (see playbooks.ts) implement
 * a template for a specific industry, re-using its steps but re-describing
 * them in that industry's terminology.
 *
 * Keeping the operational logic in a small set of templates — and the domain
 * flavour in many lightweight playbook definitions — is what lets the tool
 * serve numerous industries without duplicating the underlying playbooks.
 */

// ---------------------------------------------------------------------------
// Template model
// ---------------------------------------------------------------------------

/**
 * Broad operational category used to group templates and filter playbooks.
 */
export type TemplateCategory =
  | 'anomaly'
  | 'underperformance'
  | 'drift'
  | 'sensor_health'
  | 'balance_loss'
  | 'predictive_maintenance'
  | 'quality'
  | 'optimization'
  | 'forecasting'
  | 'benchmarking'
  | 'correlation'
  | 'transient'
  | 'vibration'
  | 'operating_regime'
  | 'regime_shift'
  | 'seasonality';

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  anomaly: 'Anomaly investigation',
  underperformance: 'Underperformance',
  drift: 'Drift detection',
  sensor_health: 'Sensor health',
  balance_loss: 'Balance / loss',
  predictive_maintenance: 'Predictive maintenance',
  quality: 'Quality excursion',
  optimization: 'Optimization',
  forecasting: 'Threshold forecasting',
  benchmarking: 'Benchmarking',
  correlation: 'Event correlation',
  transient: 'Transient / startup',
  vibration: 'Vibration & spectral analysis',
  operating_regime: 'Operating regime & cycles',
  regime_shift: 'Regime-shift investigation',
  seasonality: 'Seasonality & cycles',
};

export interface TemplateStep {
  page: PageKey;
  title: string;
  /** Generic, industry-agnostic instruction (domains may override). */
  detail: string;
}

export interface PlaybookTemplate {
  id: string;
  title: string;
  category: TemplateCategory;
  summary: string;
  whyItMatters: string;
  startPage: PageKey;
  steps: TemplateStep[];
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TEMPLATES: PlaybookTemplate[] = [
  {
    id: 'anomaly_investigation',
    title: 'Anomaly investigation',
    category: 'anomaly',
    summary: 'Investigate abnormal behavior on an asset and shortlist the likely drivers.',
    whyItMatters:
      'Early, evidence-based anomaly triage prevents unplanned downtime and lets teams act before a small deviation becomes a failure.',
    startPage: 'monitor',
    steps: [
      { page: 'monitor', title: 'Check the deviation band', detail: 'Watch the signal against its expected band and note when and how far it breaches.' },
      { page: 'changepoints', title: 'Pin the onset', detail: 'Locate the single most significant change point so you know exactly when the deviation began — line it up against events, setpoint changes, or maintenance before correlating drivers.' },
      { page: 'controlchart', title: 'Confirm a special-cause signal', detail: 'Plot the signal on a control chart and let the run-rules confirm this is a genuine special cause, not normal common-cause variation.' },
      { page: 'discover', title: 'Scan for unusual shapes & joint anomalies', detail: 'On a single signal, rank the most unusual (discord) windows by how different their shape is from the rest of the series. With two or more signals selected, run a multivariate anomaly scan (MVAD) to catch windows where the signals jointly deviate — coordinated multi-signal fault signatures a single-signal shape scan can miss — and read which signals contributed most.' },
      { page: 'rootcause', title: 'Correlate candidate drivers', detail: 'Rank upstream signals by lagged correlation to see what moved before the anomaly.' },
      { page: 'alerts', title: 'Hand off the finding', detail: 'If you recorded this deviation as a finding from Monitor or Control Chart, triage that entry here — acknowledge, suppress, or close it, and export an evidence bundle or work-order document for handoff.' },
    ],
  },
  {
    id: 'underperformance_diagnosis',
    title: 'Underperformance diagnosis',
    category: 'underperformance',
    summary: 'Diagnose why output is running below its expected rate.',
    whyItMatters:
      'Sustained underperformance is lost throughput and often the first visible symptom of a developing problem.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Review the output trend', detail: 'Plot the output signal over the recent window and compare it to prior periods.' },
      { page: 'changepoints', title: 'Date the shortfall onset', detail: 'Find the change point where output stepped down or began sloping off, so you can pin when the shortfall started and whether it was sudden or gradual.' },
      { page: 'forecast', title: 'Compare to expected', detail: 'Forecast the expected output and measure how far actuals fall below the band.' },
      { page: 'rootcause', title: 'Find candidate contributors', detail: 'Rank upstream signals by lagged correlation to the shortfall.' },
      { page: 'regression', title: 'Quantify associations', detail: 'Regress output on operating variables to estimate which factors explain the most variation in the gap.' },
      { page: 'investigations', title: 'Assemble the case', detail: 'Collect the trend, expected-vs-actual, and driver evidence into an investigation for review and handoff.' },
    ],
  },
  {
    id: 'drift_detection',
    title: 'Drift detection',
    category: 'drift',
    summary: 'Detect slow drift away from a baseline before it trips hard limits.',
    whyItMatters:
      'Gradual drift erodes yield, quality, or efficiency long before it triggers an alarm; catching it early protects margin.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Inspect baseline & trend', detail: 'Overlay the baseline and trend to reveal slow movement.' },
      { page: 'decompose', title: 'Separate trend from noise', detail: 'Decompose the signal to isolate the trend from seasonality and residual noise.' },
      { page: 'changepoints', title: 'Locate the onset (step vs ramp)', detail: 'Fit a two-line change point to tell a sudden level shift apart from a gradual slope-break drift, and pin when the movement began.' },
      { page: 'controlchart', title: 'Detect the drift as a signal', detail: 'Monitor against a governed baseline; run- and zone-rules flag a slow, sustained drift long before it reaches a hard limit.' },
      { page: 'forecast', title: 'Project the drift', detail: 'Forecast where the signal is heading relative to its limits.' },
      { page: 'regression', title: 'Attribute the drift', detail: 'Regress the KPI on operating variables to attribute the change.' },
    ],
  },
  {
    id: 'sensor_validation',
    title: 'Sensor validation',
    category: 'sensor_health',
    summary: 'Decide whether a reading is a real process change or a bad sensor.',
    whyItMatters:
      'Acting on a faulty sensor causes wrong decisions and false alarms; validating the signal first preserves trust in the data.',
    startPage: 'monitor',
    steps: [
      { page: 'monitor', title: 'Characterize the reading', detail: 'Check whether the value is out-of-band and how it behaves over time.' },
      { page: 'validation', title: 'Cross-check against peers', detail: 'Estimate the signal from correlated peers and inspect the residual.' },
      { page: 'rootcause', title: 'Check for a lone divergence', detail: 'Check whether only this sensor disagrees with its redundant neighbors.' },
      { page: 'alerts', title: 'Hand off inspection evidence', detail: 'If you recorded a sensor-health finding from Monitor, triage that entry here and export its evidence for inspection follow-up.' },
      { page: 'investigations', title: 'Document the evidence', detail: 'Capture the peer estimate, residual, and verdict into an investigation to support the calibration or maintenance decision.' },
    ],
  },
  {
    id: 'balance_loss',
    title: 'Balance / loss detection',
    category: 'balance_loss',
    summary: 'Find a mass or energy imbalance that indicates a leak or loss.',
    whyItMatters:
      'Imbalances are safety-, environment-, and cost-critical; fast, evidence-based triage reduces loss volume and exposure.',
    startPage: 'derived',
    steps: [
      { page: 'derived', title: 'Build the balance signal', detail: 'Compute the in-vs-out balance (inflow − outflow) as a derived metric so the imbalance is a single signal to watch.' },
      { page: 'monitor', title: 'Watch the balance', detail: 'Monitor the in-vs-out balance for a sustained divergence.' },
      { page: 'rootcause', title: 'Bracket the change', detail: 'Order segment signals by when they moved to narrow the candidate loss area.' },
      { page: 'decompose', title: 'Separate transient vs sustained', detail: 'Decompose to distinguish a transient swing from a persistent loss.' },
      { page: 'alerts', title: 'Hand off the deviation', detail: 'If you recorded the balance deviation as a finding from Monitor, triage that entry here and export an evidence bundle or work-order document for the field crew.' },
    ],
  },
  {
    id: 'predictive_maintenance',
    title: 'Predictive maintenance',
    category: 'predictive_maintenance',
    summary: 'Catch equipment degradation early and estimate whether it is approaching a limit.',
    whyItMatters:
      'Fixing on a forecast rather than a failure avoids unplanned downtime and lets maintenance be scheduled at the right time.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Trend health indicators', detail: 'Plot the condition indicators (vibration, temperature, current) over time.' },
      { page: 'discover', title: 'Scan for joint condition anomalies', detail: 'With two or more condition indicators selected, run a multivariate anomaly scan (MVAD) to catch early windows where they jointly deviate — coordinated changes across vibration, temperature, and current that a single-signal trend can miss — and see which contributed most.' },
      { page: 'spectrum', title: 'Find the fault frequency', detail: 'Transform the vibration/current signal to the frequency domain to pick out the bearing or rotating-element frequency and its harmonics; watch the spectrogram for a peak that grows or drifts as wear develops.' },
      { page: 'patterns', title: 'Find the degradation pattern', detail: 'Run a Matrix Profile slow-degradation analysis to surface the developing wear pattern in the condition indicator.' },
      { page: 'decompose', title: 'Extract the degradation trend', detail: 'Decompose to isolate the slow degradation trend from operating noise.' },
      { page: 'forecast', title: 'Estimate threshold risk', detail: 'Forecast the indicator and read whether, and roughly when, it approaches or crosses the alarm limit within the horizon.' },
      { page: 'scenario', title: 'Compare a simple scenario', detail: 'Apply a simple scale, offset, ramp, or clamp to the baseline signal and compare KPIs and limit exposure; treat this as planning support, not an optimized maintenance schedule.' },
    ],
  },
  {
    id: 'quality_excursion',
    title: 'Quality excursion',
    category: 'quality',
    summary: 'Investigate product/output quality that has moved out of spec.',
    whyItMatters:
      'Out-of-spec output risks scrap, rework, recalls, and compliance findings; ranking candidate drivers helps limit follow-up to the affected batch.',
    startPage: 'controlchart',
    steps: [
      { page: 'controlchart', title: 'Detect the excursion', detail: 'Chart the quality variable against its spec and control limits; special-cause rules flag the excursion and process capability (Cp/Cpk) shows whether the process can hold spec.' },
      { page: 'rootcause', title: 'Find candidate process drivers', detail: 'Rank process signals by lagged correlation to the excursion.' },
      { page: 'regression', title: 'Quantify the sensitivity', detail: 'Regress the quality variable on process settings to quantify sensitivity.' },
      { page: 'alerts', title: 'Triage the excursion entry', detail: 'If you recorded the excursion as a finding from Control Chart, triage that entry here — acknowledge or close it and export evidence for disposition.' },
    ],
  },
  {
    id: 'efficiency_optimization',
    title: 'Efficiency optimization',
    category: 'optimization',
    summary: 'Find efficiency loss and compare simple adjustment scenarios.',
    whyItMatters:
      'Small, sustained efficiency gains compound into large energy and cost savings across a fleet.',
    startPage: 'derived',
    steps: [
      { page: 'derived', title: 'Build the efficiency KPI', detail: 'Combine the relevant signals into the efficiency KPI (e.g. a ratio such as energy per unit of output) so you optimize the right number.' },
      { page: 'explore', title: 'Trend the efficiency KPI', detail: 'Plot the efficiency KPI and compare it to its best sustained periods.' },
      { page: 'regression', title: 'Find candidate loss drivers', detail: 'Regress the KPI on operating variables to identify factors associated with lower efficiency.' },
      { page: 'scenario', title: 'Compare simple adjustments', detail: 'Apply simple scale, offset, ramp, or clamp assumptions to the KPI baseline and compare resulting KPIs before discussing any operator change.' },
    ],
  },
  {
    id: 'threshold_breach_forecast',
    title: 'Threshold-breach forecast',
    category: 'forecasting',
    summary: 'Forecast whether and when a signal will breach a limit.',
    whyItMatters:
      'Forecasting threshold risk gives operators a decision-support readout before a limit is actually crossed.',
    startPage: 'forecast',
    steps: [
      { page: 'forecast', title: 'Forecast the signal', detail: 'Forecast the signal and read the estimated exceedance probability against the limit.' },
      { page: 'explore', title: 'Review the recent trend', detail: 'Confirm the recent trajectory supports the forecasted breach.' },
      { page: 'scenario', title: 'Compare a simple mitigation assumption', detail: 'Apply a simple adjustment to the same signal and compare limit exposure; this does not model closed-loop control or how another variable will respond.' },
      { page: 'investigations', title: 'Capture the forecast risk', detail: 'Save the forecast, threshold readout, recent trend, and scenario assumptions into an investigation for review.' },
    ],
  },
  {
    id: 'comparative_benchmarking',
    title: 'Comparative benchmarking',
    category: 'benchmarking',
    summary: 'Compare peer assets to find and explain the outlier.',
    whyItMatters:
      'Benchmarking similar assets surfaces the worst performer and the practices worth replicating across the fleet.',
    startPage: 'compare',
    steps: [
      { page: 'compare', title: 'Overlay peer assets', detail: 'Overlay the same signal across peer assets to spot the outlier.' },
      { page: 'calendar', title: 'Compare time-of-day patterns', detail: 'Use heatmaps to compare peers by hour-of-day, weekday, or season and reveal when the outlier diverges.' },
      { page: 'explore', title: 'Inspect the outlier', detail: 'Open the outlier asset and inspect its behavior in detail.' },
      { page: 'rootcause', title: 'Look for candidate drivers', detail: 'Correlate operating variables to identify factors associated with the outlier.' },
    ],
  },
  {
    id: 'event_correlation',
    title: 'Event correlation',
    category: 'correlation',
    summary: 'Correlate an event across many signals to rank candidate leading signals.',
    whyItMatters:
      'When many signals move together, lead/lag screening helps separate earlier-moving candidates from later symptoms.',
    startPage: 'causality',
    steps: [
      { page: 'causality', title: 'Map predictive influence', detail: 'Build the influence map to see which signals tend to move ahead of others; treat edges as hypotheses, not proof.' },
      { page: 'rootcause', title: 'Order by lead/lag', detail: 'Rank signals by how early they moved to identify candidate leading signals.' },
      { page: 'patterns', title: 'Confirm the multi-sensor event', detail: 'Run a multi-sensor Matrix Profile analysis to confirm the signals move together as one event and locate its recurrences.' },
      { page: 'discover', title: 'Detect the joint anomaly', detail: 'Run a multivariate anomaly scan (MVAD) across the correlated signals together to pinpoint the windows where they jointly deviate, confirming the event as one coordinated multi-signal anomaly and ranking the signals that contributed most.' },
      { page: 'explore', title: 'Confirm on the timeline', detail: 'Overlay the leading signals on the timeline to confirm the sequence.' },
    ],
  },
  {
    id: 'transient_validation',
    title: 'Transient / startup validation',
    category: 'transient',
    summary: 'Validate startup, shutdown, or transition behavior against a good run.',
    whyItMatters:
      'Transients are where equipment is most stressed; validating them against a known-good run catches abnormal sequences early.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Isolate the transient', detail: 'Zoom to the startup/shutdown window and inspect the transition.' },
      { page: 'compare', title: 'Compare to a good run', detail: 'Overlay a known-good transient to spot timing or amplitude differences.' },
      { page: 'patterns', title: 'Match against reference shapes', detail: 'Use Matrix Profile to compare the transient against known-good runs and highlight where its shape diverges.' },
      { page: 'segmentation', title: 'Segment the phases', detail: 'Segment the transient into phases and check each against expectation.' },
      { page: 'processmining', title: 'Mine the phase sequence', detail: 'Discretize the transient into operating states and mine the phase sequence (order and dwell time of each state) so uncommon or over-long phases stand out.' },
      { page: 'investigations', title: 'Capture abnormal-transient evidence', detail: 'Save the comparison, Matrix Profile result, segmentation, and mined sequence evidence into an investigation.' },
    ],
  },
  {
    id: 'vibration_diagnosis',
    title: 'Vibration & spectral diagnosis',
    category: 'vibration',
    summary: 'Diagnose a rotating-equipment fault from its vibration spectrum.',
    whyItMatters:
      'A developing bearing, imbalance, or misalignment fault shows up as a distinctive frequency long before it trips a level alarm; catching the frequency early enables a planned repair instead of a failure.',
    startPage: 'spectrum',
    steps: [
      { page: 'explore', title: 'Trend the vibration signal', detail: 'Plot the vibration (or motor-current) signal and note when its level or character changes.' },
      { page: 'spectrum', title: 'Identify the dominant frequency', detail: 'Transform to the frequency domain, read the dominant peak and its harmonics, and use the spectrogram to see whether a peak is drifting up or newly appearing.' },
      { page: 'patterns', title: 'Confirm the signature recurs', detail: 'Use Matrix Profile to find recurrences of the vibration signature and locate when it first appeared.' },
      { page: 'rootcause', title: 'Compare with operating conditions', detail: 'Correlate speed, load, and temperature to the frequency to judge whether a mechanical explanation is plausible.' },
      { page: 'investigations', title: 'Document the frequency evidence', detail: 'Save the dominant frequency, harmonics, recurrence evidence, and operating-condition correlations into an investigation.' },
    ],
  },
  {
    id: 'operating_cycle_analysis',
    title: 'Operating-cycle analysis',
    category: 'operating_regime',
    summary: 'Discover the operating states and cycles an asset actually runs.',
    whyItMatters:
      'Understanding the real sequence of operating states — and how long each takes — reveals abnormal paths, short-cycling, and dwell-time losses that raw trends hide.',
    startPage: 'processmining',
    steps: [
      { page: 'explore', title: 'Review the signal & pick bands', detail: 'Inspect the value distribution to choose sensible operating bands (e.g. off / idle / run / overload).' },
      { page: 'processmining', title: 'Mine the operating sequences', detail: 'Discretize the signal into operating states and mine the recurring sequences (startup ramps, duty cycles) with their counts and typical durations.' },
      { page: 'segmentation', title: 'Examine the phases', detail: 'Segment the timeline into phases and inspect the behavior within each state.' },
      { page: 'compare', title: 'Compare cycle to cycle', detail: 'Overlay cycles — or compare against a golden cycle — to spot abnormal dwell times or an out-of-order sequence.' },
      { page: 'investigations', title: 'Capture dwell & cycle times', detail: 'Save the state timeline and cycle-time evidence into an investigation for review and handoff.' },
    ],
  },
  {
    id: 'regime_shift_investigation',
    title: 'Regime-shift investigation',
    category: 'regime_shift',
    summary: 'Pin down when a process moved to a new operating point and why.',
    whyItMatters:
      'When a signal settles at a new level or trend, dating the break and correlating it to events or setpoint changes helps separate a deliberate change from a developing problem.',
    startPage: 'changepoints',
    steps: [
      { page: 'explore', title: 'Bracket the suspected shift', detail: 'Zoom to the window around the suspected change and confirm it sits within one broad operating context.' },
      { page: 'changepoints', title: 'Locate & classify the break', detail: 'Find the single most significant change point, read whether it is a level shift or a slope break, and check how cleanly the two-line model fits (R²).' },
      { page: 'decompose', title: 'Confirm it is structural', detail: 'Decompose to check the break is a real level/trend change rather than seasonality or noise.' },
      { page: 'rootcause', title: 'Look for signals that moved at the break', detail: 'Correlate other signals around the break time to compare it with events, setpoint changes, or maintenance.' },
      { page: 'investigations', title: 'Document the shift', detail: 'Capture the dated break and candidate drivers into an investigation.' },
    ],
  },

  // --- Cross-industry business templates -----------------------------------
  {
    id: 'kpi_target_forecast',
    title: 'KPI forecast & target pacing',
    category: 'forecasting',
    summary: 'Forecast a business KPI and see whether you are on pace to hit the target.',
    whyItMatters:
      'Knowing early that you will miss (or breach) a number gives time to act — reallocate spend, add staff, or reset expectations — instead of explaining the miss after the period closes.',
    startPage: 'forecast',
    steps: [
      { page: 'explore', title: 'Review the KPI trend', detail: 'Plot the metric over recent periods and note its run-rate and recent direction.' },
      { page: 'decompose', title: 'Strip out seasonality', detail: 'Separate the underlying trend from weekly/seasonal effects so the true run-rate is clear.' },
      { page: 'forecast', title: 'Project to the target', detail: 'Forecast to period-end with the target as a threshold and read the estimated target-hit or breach probability.' },
      { page: 'scenario', title: 'Compare a simple planning assumption', detail: 'Apply a scale, offset, ramp, or cap to the KPI baseline to represent an assumed planning change, then compare KPIs; this does not estimate how one business variable causes another to respond.' },
      { page: 'investigations', title: 'Capture the pacing evidence', detail: 'Save the trend, forecast threshold readout, and scenario assumptions into an investigation for planning review.' },
    ],
  },
  {
    id: 'kpi_anomaly_diagnosis',
    title: 'KPI anomaly investigation',
    category: 'anomaly',
    summary: 'Investigate a sudden move in a business metric and find what drove it.',
    whyItMatters:
      'A sharp change in a KPI is either an opportunity or a problem; dating it and ranking candidate drivers turns a surprise in the monthly review into a focused follow-up.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Spot the move', detail: 'Plot the metric and mark the sudden change that needs explaining.' },
      { page: 'changepoints', title: 'Date the break', detail: 'Pin exactly when the metric shifted and whether it was a one-off step or a change in trend.' },
      { page: 'controlchart', title: 'Real signal or noise?', detail: 'Chart the metric with control limits so run-rules confirm a genuine special cause rather than normal variation.' },
      { page: 'rootcause', title: 'Find candidate drivers', detail: 'Rank related metrics by lagged correlation to see what moved first around the break.' },
      { page: 'investigations', title: 'Assemble the case', detail: 'Capture the trend, the dated break, and candidate drivers into a shareable investigation.' },
    ],
  },
  {
    id: 'seasonality_planning',
    title: 'Seasonality & pattern planning',
    category: 'seasonality',
    summary: 'Understand the repeating patterns in a business series to plan around them.',
    whyItMatters:
      'Staffing, inventory, cash, and campaigns all hinge on when demand and activity peak; making the hour-of-day, day-of-week, and seasonal patterns explicit turns guesswork into a plan.',
    startPage: 'calendar',
    steps: [
      { page: 'explore', title: 'Review the series', detail: 'Plot the metric across enough history to reveal repeating patterns.' },
      { page: 'calendar', title: 'Map the patterns', detail: 'Use hour-of-day, day-of-week, and seasonal heatmaps to see when activity peaks and dips.' },
      { page: 'decompose', title: 'Separate trend & seasonality', detail: 'Split the series into trend, seasonal, and residual so each can be planned for separately.' },
      { page: 'forecast', title: 'Project with seasonality', detail: 'Produce a seasonally-aware forecast for staffing, inventory, or budget.' },
      { page: 'investigations', title: 'Document the plan', detail: 'Save the pattern and forecast as evidence behind the planning decision.' },
    ],
  },
  {
    id: 'intervention_impact',
    title: 'Intervention / change impact',
    category: 'regime_shift',
    summary: 'Assess whether a campaign, price, or policy change coincided with a measurable metric shift.',
    whyItMatters:
      'Pairing a dated break with before/after comparison and regression context helps avoid assuming a change caused a move that was already underway.',
    startPage: 'changepoints',
    steps: [
      { page: 'explore', title: 'Bracket before & after', detail: 'Zoom to the window around the campaign, price, or policy change.' },
      { page: 'changepoints', title: 'Detect & date the shift', detail: 'Find the most significant break and classify it as a level shift or a change in trend rate.' },
      { page: 'compare', title: 'Compare the periods', detail: 'Overlay the before and after periods to quantify the lift or the drop.' },
      { page: 'regression', title: 'Check other drivers', detail: 'Regress the KPI on other factors to see whether they also explain the before/after difference.' },
      { page: 'investigations', title: 'Report the evidence', detail: 'Capture the measured shift, related factors, and caveats into an investigation.' },
    ],
  },
  {
    id: 'segment_benchmarking',
    title: 'Segment benchmarking',
    category: 'benchmarking',
    summary: 'Compare segments — regions, reps, channels, teams — to find leaders and laggards.',
    whyItMatters:
      'Ranking comparable segments surfaces both the outlier that needs help and the practices worth copying everywhere else.',
    startPage: 'compare',
    steps: [
      { page: 'compare', title: 'Overlay the segments', detail: 'Compare the same metric across regions, reps, channels, or teams to spot the outlier.' },
      { page: 'calendar', title: 'Compare timing patterns', detail: 'Use heatmaps to see when a segment diverges — by hour, day, or season.' },
      { page: 'explore', title: 'Inspect the outlier', detail: 'Open the outlier segment and examine its behavior in detail.' },
      { page: 'regression', title: 'Look for associated drivers', detail: 'Correlate candidate drivers to see which factors are associated with the leader or laggard.' },
    ],
  },
  {
    id: 'metric_erosion_earlywarning',
    title: 'Metric erosion early warning',
    category: 'drift',
    summary: 'Catch a gradual decline — margin, retention, engagement, lead-time — before it becomes a loss.',
    whyItMatters:
      'Slow erosion rarely trips an alarm; it just quietly compounds. Catching the slide while there is still time to act protects the number before it shows up as a bad quarter.',
    startPage: 'explore',
    steps: [
      { page: 'explore', title: 'Inspect baseline & trend', detail: 'Overlay the baseline and the recent trend to reveal a slow decline.' },
      { page: 'decompose', title: 'Isolate the slow trend', detail: 'Separate the gradual erosion from noise and seasonality.' },
      { page: 'changepoints', title: 'Step or slow slide?', detail: 'Determine whether the metric stepped down once or is steadily sliding, and when it began.' },
      { page: 'forecast', title: 'Project the erosion', detail: 'Forecast where the metric is heading relative to a threshold you care about.' },
      { page: 'investigations', title: 'Capture the early-warning evidence', detail: 'Save the baseline, trend, change point, and forecast threshold readout into an investigation for review.' },
    ],
  },
  {
    id: 'kpi_driver_analysis',
    title: 'KPI driver analysis',
    category: 'correlation',
    summary: 'Find which factors are associated with movements in a business KPI.',
    whyItMatters:
      'Screening candidate drivers helps focus follow-up analysis on factors with the strongest association or lead/lag relationship to the KPI.',
    startPage: 'regression',
    steps: [
      { page: 'explore', title: 'Frame the target metric', detail: 'Plot the KPI you want to explain (e.g. conversion, CAC, churn, throughput).' },
      { page: 'regression', title: 'Rank candidate drivers', detail: 'Regress the KPI on candidate factors to rank which explain the most variation.' },
      { page: 'causality', title: 'Map lead/lag influence', detail: 'Build an influence map to see which candidate drivers tend to move ahead of the KPI rather than alongside it.' },
      { page: 'scenario', title: 'Compare a KPI scenario', detail: 'Apply an assumed scale, offset, ramp, or cap to the KPI baseline and compare resulting metrics; use regression and lead/lag evidence to judge whether the assumption is plausible.' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getTemplate(id: string): PlaybookTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
