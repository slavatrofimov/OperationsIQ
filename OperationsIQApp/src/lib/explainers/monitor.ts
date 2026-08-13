import type { PageExplainer } from '../explainers';

/**
 * Explainer copy for the "Monitor" navigation group:
 * monitor, alerts, validation.
 */
export const MONITOR_EXPLAINERS: Record<string, PageExplainer> = {
  controlchart: {
    overview:
      'Control chart plots a signal against statistically derived control limits to separate normal common-cause variation from special-cause signals that warrant investigation. Choose Individuals & Moving Range for one reading per period, or X\u0304-R / X\u0304-S when readings arrive in rational subgroups. Use it to establish a baseline of stable behavior and then monitor new data against it.',
    interpretation:
      'Points inside the control limits with no special-cause pattern indicate a process in statistical control. Points beyond 3\u03c3 (UCL/LCL) or matching a run/zone rule are flagged as signals to investigate. Control limits describe how the process actually behaves; specification limits (LSL/USL) describe what the product requires \u2014 a process can be in control yet still not meet spec, so the two are drawn separately.',
    technical:
      'Limits use standard Shewhart estimators: I-MR derives \u03c3 from the average moving range (MR\u0304/d\u2082), while X\u0304-R and X\u0304-S size the mean-chart limits from R\u0304 (A\u2082) or S\u0304 (A\u2083) and the variation-chart limits from D\u2083/D\u2084 or B\u2083/B\u2084. Special-cause detection runs a configurable Nelson / Western Electric / Minitab rule profile over the plotted statistics. In Phase I (establish limits) the limits are estimated from a baseline window; in Phase II (monitor against frozen limits) those limits are frozen and applied to new data without recomputation.',
    inputs: {
      tag: 'The signal to chart. Its binned readings become individual points (I-MR) or are grouped into rational subgroups (X\u0304 charts).',
      rules: 'The special-cause rule profile. Basic uses only the 3\u03c3 limit test; broader profiles (Western Electric, Nelson, Minitab 1\u20138) add zone, run, and trend tests. More tests catch smaller shifts sooner but also raise the false-alarm rate.',
      appliedRules: 'The individual special-cause tests applied within the selected rule set. Every test in the set is enabled by default; clear a box to exclude that test. Applying fewer tests lowers the false-alarm rate but may miss some patterns. Changing the rule set resets this selection to all of the new set\u2019s tests.',
      baseline: 'Which portion of the data estimates the control limits. Phase I (establish limits): use a baseline window to estimate the limits \u2014 "All data" runs a Phase I study over everything. Phase II (monitor against frozen limits): choosing a leading fraction freezes the limits from that window and monitors the remaining data against them to detect shifts, mirroring how baselines are governed operationally.',
      spec: 'Optional specification limits (LSL/USL) and target. These are customer/engineering requirements, drawn separately from the control limits because being in control is not the same as being capable.',
    },
    outputs: {
      kpis:
        'The summary cards show the phase (I or II), the percent of points in control, how many special-cause signals were found, and the center line and control limits.',
      chart:
        'The primary chart plots each point with the center line (CL), control limits (UCL/LCL), and 1\u03c3/2\u03c3 zone lines. Flagged points are marked in red; hover a point to see which rule(s) fired and why. Any specification limits and target appear as separate reference lines, and the Phase I (limit-establishing) baseline window is shaded when a Phase II (monitoring) split is in effect.',
      variation:
        'The variation chart (Moving Range, Range, or Std dev) monitors process spread. Points beyond its upper limit indicate the variation itself changed, which must be stable before the mean chart can be trusted.',
      signals:
        'The signals table lists each special-cause violation with its time, which chart it occurred on, the rule number and name, the side of the center line, and a plain-language description for follow-up.',
      baseline:
        'Save the currently displayed control limits, chart configuration, rule profile, and specification limits as a governed baseline. A baseline is created as a draft; approving it freezes the limits and stamps an audit entry. Saving under an existing name creates a new version rather than overwriting, so limits never change silently. Load an approved baseline to monitor new data against its frozen Phase II (monitoring) limits.',
      capability:
        'Process capability compares the process spread with the specification limits (Cp/Cpk from the short-term within-subgroup spread; Pp/Ppk and Cpm from the overall spread), and estimates the expected out-of-spec rate in parts-per-million. Because capability is only meaningful for a stable process, the indices are gated on statistical control \u2014 an out-of-control process must be stabilized first, or shown explicitly as exploratory.',
    },
  },
  monitor: {
    overview:
      'Monitor compares a signal with its expected normal behavior and highlights periods that fall outside the normal band. Use it to watch for deviations that may indicate process drift, equipment issues, or a sensor behaving differently than usual. Results can be recorded as a finding when operator follow-up is needed.',
    interpretation:
      'A high in-band percentage means the signal mostly behaved as expected for the chosen window and confidence level. Breach spans show when the actual value moved outside the band; the breach table summarizes when each run started, ended, and how large the worst deviation was.',
    technical:
      'The selected signal is resampled onto an even time grid and missing values are linearly interpolated. The seasonal detector estimates an expected baseline with seasonal-trend decomposition and sizes a confidence band from the residual standard deviation (σ) via a z-score multiplier. The robust detector instead scores each bin with Tukey\u2019s fences (series_outliers, custom-Tukey 10th/90th-percentile IQR) and draws the whisker envelope — the most extreme non-outlier value on each side — around the series median. In both modes, consecutive out-of-band bins are grouped into breach spans and can be recorded as alert evidence.',
    inputs: {
      tag: 'The signal to monitor for deviations from its expected baseline.',
      range: 'The time window used to estimate expected behavior and evaluate breaches.',
      confidence: 'Controls the width of the normal band. Higher confidence makes the band wider and reduces sensitivity to smaller deviations.',
      detector:
        'How the normal band is derived. "Seasonal baseline" fits trend and seasonality (series_decompose_anomalies) and is best for periodic signals. "Robust (Tukey)" makes no seasonal assumption — it scores each bin with Tukey\u2019s fences (series_outliers) and suits aperiodic signals, level shifts, and spiky data where a seasonal model would misfit.',
      sensitivity:
        'For the robust detector, the Tukey score magnitude above which a bin is flagged as an outlier. Lower values (1.5) flag more points; higher values (3.0) flag only the most extreme excursions.',
    },
    outputs: {
      kpis:
        'The Key Performance Indicator (KPI) summary cards show how much of the signal stayed in band, how many breach runs were found, the largest deviation, and the band width used for this run.',
      chart:
        'The chart overlays actual values, the expected baseline, and the normal band. Shaded areas mark contiguous times when the signal was outside the band.',
      breaches:
        'The breach table lists each out-of-band run with timing, direction, duration, peak value, and peak deviation so an operator can prioritize follow-up.',
    },
  },
  alerts: {
    overview:
      'Findings is the review queue for findings a person records from the Monitor and Control chart pages. It groups repeated submissions of the same finding, shows active and historical entries, and gives operators actions for acknowledgement, suppression, closure, evidence export, and work-order handoff. It does not evaluate incoming data on its own or raise alerts automatically.',
    interpretation:
      'Use the badges to understand the current queue pressure and the table to triage individual entries. Acknowledged entries remain active but owned, suppressed entries reduce noise for a limited time, and closed entries are removed from the active queue unless reopened.',
    technical:
      'Each submitted entry is grouped by a deduplication key so repeated submissions update occurrence counts instead of creating separate work items. State transitions for acknowledgement, suppression, closure, reopening, evidence export, and work-order handoff maintain an auditable lifecycle for each entry.',
    inputs: {
      filter: 'Switches between the active operating queue and all entries, including closed history.',
    },
    outputs: {
      summary:
        'The queue badges summarize open, acknowledged, and critical active entries so operators can quickly assess workload and severity.',
      queue:
        'The table lists each entry, current status, occurrence count, last activity, and available actions. Repeated submissions of the same finding are collapsed into one row.',
    },
  },
  validation: {
    overview:
      'Signal validation checks whether a target sensor agrees with related reference sensors. It learns a virtual estimate of the target from the references, then compares the real reading with that estimate to spot drift, bias, or likely sensor faults. This helps distinguish a bad sensor from a real process movement.',
    interpretation:
      'A valid verdict means the target mostly tracks what its peers predict. Suspect or faulty verdicts mean the residual is large, biased, or often outside expected bounds; review the chart and peer selection before deciding whether the sensor needs calibration or maintenance.',
    technical:
      'Reference and target sensors are aligned on a common time grid. The training portion fits a transparent virtual sensor with least-squares regression, using the references to estimate the target. Residuals are scored in training standard-deviation units (z-scores), then thresholded into valid, suspect, or faulty verdicts.',
    inputs: {
      target: 'The sensor being checked for drift or fault.',
      refs: 'Correlated reference sensors used to estimate what the target should read. Choose peers that physically move with the target during healthy operation.',
      range: 'The window used for training and evaluation. The first Train % portion is treated as the healthy training region.',
      trainPct: 'The percentage of the selected window used to fit the virtual sensor before evaluating the remaining period.',
    },
    outputs: {
      chart:
        'The chart compares the actual target with the virtual-sensor estimate and shows the residual in z-score units. The shaded region marks the training period; ±3 residual lines show common investigation thresholds.',
      stats:
        'The badges summarize fit quality, training residual spread, bias, maximum residual z-score, and percent out of bounds so analysts can judge sensor health quickly.',
    },
  },
};
