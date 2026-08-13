import type { PageExplainer } from '../explainers';

/**
 * Explainer copy for the "Diagnose" navigation group:
 * rootcause, causality, regression, decompose, segmentation, patterns.
 */
export const DIAGNOSE_EXPLAINERS: Record<string, PageExplainer> = {
  rootcause: {
    overview:
      'Root cause explains one signal you already care about. Given a target signal and an incident window, it ranks candidate driver signals by how early and how strongly their movement matches the target, so you can turn a long list of suspects into a short, ordered set of hypotheses. Use it once you know what to explain — if you do not yet know which signals are involved, start with the Influence map to shortlist candidates. The results are decision support, not an automatic verdict.',
    interpretation:
      'Start with candidates that lead the target and have the strongest absolute correlation. A positive or negative correlation can both be meaningful: the key question is whether the candidate moved first and whether that relationship makes operational sense.',
    technical:
      'Signals are aggregated onto a shared time grid, gaps are linearly interpolated, and candidate drivers are compared with the target across a range of positive and negative lags. Ranking favors drivers whose movement leads the target and has strong absolute cross-correlation. Directional edges are hypotheses based on timing and correlation, not proof of causation.',
    inputs: {
      targetSignal: 'The signal whose change or incident you want to explain.',
      candidateDrivers:
        'Signals that might have contributed to the target change. Include likely upstream process variables, control settings, and related measurements.',
      range:
        'The incident window used for the comparison. Choose a window that covers the lead-up and the target movement, but avoids unrelated operating modes.',
      maxLagBins:
        'The largest lead or delay, measured in binned samples, to test between a candidate and the target. Larger values can find slower propagation but may also surface coincidental relationships.',
      mode:
        'Rank drivers ranks candidates by lagged cross-correlation. Diagnose anomalies flags the target’s anomalous bins and uses the diffpatterns plugin to find which driver operating regimes are over-represented when the target is anomalous.',
      sensitivity:
        'Controls how aggressively the target’s bins are flagged as anomalous before comparing driver regimes. Higher sensitivity flags more bins; lower sensitivity flags only the strongest deviations.',
      binning:
        'How raw samples are aggregated onto the shared time grid before comparing signals. The bin width determines the timing resolution of lead/lag results.',
    },
    outputs: {
      rankedCauses:
        'Candidates are sorted with leading drivers first, then by correlation strength. The lead/lag column shows whether each candidate moved before the target, which is required for a plausible driver hypothesis.',
      graph:
        'The graph shows strong directed relationships from candidate drivers toward the target. Arrow thickness reflects correlation strength, and the propagation order lists leading signals from earliest to latest.',
      contributingFactors:
        'Each row is a combination of driver operating regimes (high / normal / low relative to each driver’s own mean) and how much more often it appears in anomalous bins than in normal ones. A large positive contribution means that regime combination tends to accompany the target’s anomalies — a hypothesis to investigate, not proof of causation.',
    },
  },
  causality: {
    overview:
      'The Influence map screens a whole set of signals to discover which ones tend to drive which — a system-wide picture of predictive influence. It compares every pair to see whether one signal’s recent history helps predict another’s future, with no single target singled out. Start here when you don’t yet know where a problem originates: use it to shortlist likely drivers, then switch to Root cause to explain a specific target or incident in detail. Treat the output as predictive evidence, not proof of a physical mechanism.',
    interpretation:
      'Read the matrix as row → column: a higher score means the row signal’s past improved prediction of the column signal. The influence graph keeps only scores above the threshold so the strongest directional relationships are easier to review.',
    technical:
      'Signals are aligned onto a common time grid, then each ordered pair is tested with linear Granger-style models. A baseline autoregressive model using the target\'s own history is compared with a model that also includes lagged source values. The score is the proportional reduction in residual error; higher scores indicate the source\'s past added predictive information.',
    inputs: {
      signals:
        'The set of signals to compare. Select two or more related measurements that may influence one another.',
      range:
        'The time window used to learn directional relationships. Choose a period with representative operating behavior and enough samples for the selected lag.',
      lag:
        'How many previous binned samples each model can use. Larger lag values can capture slower effects but require more data and can dilute short relationships.',
      edgeThreshold:
        'The minimum causality score shown in the influence graph. Raise it to focus on only the strongest links; lower it to inspect weaker hypotheses.',
      binning:
        'How raw samples are aggregated onto a common time grid before causality is computed. The bin width controls the meaning of one lag step.',
    },
    outputs: {
      matrix:
        'Each heatmap cell scores a possible source → target relationship. Darker or hotter cells indicate that the source’s recent values helped predict the target more than the target’s own history alone.',
      graph:
        'The graph turns matrix cells above the threshold into arrows. Use it to spot likely influence chains, then validate them against engineering or process knowledge.',
    },
  },
  decompose: {
    overview:
      'Decomposition splits a single signal into three easier-to-read parts: a slow-moving trend, a repeating seasonal cycle, and the leftover residual. Separating these makes it much easier to see whether a change is long-term drift, a normal daily/weekly cycle, or an unexpected event.',
    interpretation:
      'Read the panels top to bottom: Trend shows slow drift, Seasonal shows the repeating pattern, and Residual isolates what the model cannot explain — that is where transient anomalies show up as spikes. All panels share one time axis, so zooming one zooms them together.',
    technical:
      'Seasonal-trend decomposition estimates a baseline by separating slow trend, repeating seasonality, and residual variation. A linear trend model provides the long-term component, while recurring cycles explain periodic behavior. "Variance explained" is the share captured by trend plus seasonality; residual standard deviation (σ) and max residual σ quantify leftover spikes.',
    inputs: {
      tag: 'The single signal to decompose into trend, seasonal, and residual components.',
      range: 'The time window to analyze. Include at least a few full seasonal cycles so the seasonal component can be estimated reliably.',
      binning: 'How raw samples are aggregated into evenly spaced bins before decomposition. The bin width sets the resolution of the analysis.',
      seasonality:
        'The length of the repeating cycle, in bins (for example, 24 bins for a daily cycle on hourly data). Leave blank to let the algorithm auto-detect the dominant period, or use "Detect cycles" to find candidate periods and apply one.',
    },
    outputs: {
      chart:
        'Four stacked panels sharing one time axis: the original signal with its baseline, the extracted trend, the repeating seasonal component, and the residual (with a zero reference line). Spikes in the residual panel are the clearest sign of anomalies.',
      stats:
        "These badges summarize the decomposition: how much of the signal's variance the trend and seasonal parts explain, the typical size of the residual (σ), and the largest residual seen (in σ) — a value above 3σ suggests a notable anomaly.",
    },
  },
  changepoints: {
    overview:
      'Change points finds the single most significant moment a signal changed behavior — either a level shift (a step up or down) or a slope break (the trend rate changed). Use it to pin down when a process moved to a new operating point or began drifting, so you can line the break up against events, setpoint changes, or maintenance.',
    interpretation:
      'The chart overlays two fitted line segments on the signal and marks the break with a vertical line. The split-strength badge (R²) says how cleanly the two-line model fits: high values mean a distinct break, low values mean the change is gradual or noisy. The change kind and the level-shift / slope-change figures tell you whether the signal jumped, bent, or both.',
    technical:
      'A two-segment linear regression (series_fit_2lines) iterates over every possible split, fits a separate line to each side, and keeps the split that maximizes the combined R-square. The level shift is the gap between the two fitted lines at the break; the slope change is the difference between the right and left slopes (per bin). The change is classified by comparing those two components, each scaled by the signal spread.',
    inputs: {
      tag: 'The single signal to search for a change point.',
      range:
        'The window to analyze. Choose a period that brackets the suspected change but stays within one broad operating context, so the single detected break is meaningful.',
      binning:
        'How raw samples are aggregated onto evenly spaced bins before fitting. The bin width sets the time resolution of the detected break and the units of the slope change.',
    },
    outputs: {
      chart:
        'The signal with its two fitted line segments and a dashed vertical marker at the detected break. Segment colors change at the break so a level shift or a change in slope is easy to see.',
      stats:
        'Badges summarize the result: the kind of change, the split strength (R²), the break time, and the size of the level shift and slope change. A low R² means no clean two-line structure was found.',
    },
  },
  regression: {
    overview:
      'Regression and sensitivity analysis compares a target signal with selected feature signals to show which features move most closely with the target. It helps analysts explain variation, rank possible drivers, and test simple what-if scenarios. The results describe relationships in the selected data window, not guaranteed future behavior.',
    interpretation:
      'Use the correlation matrix to see pairwise relationships, the coefficient of determination (R²) ranking to find features that explain the most target variation on their own, and the fit chart to judge whether the best relationship follows the observed target. What-if values are directional estimates based on the fitted relationships.',
    technical:
      'Signals are aligned onto a common grid before comparison. Pearson correlation measures pairwise linear co-movement, while univariate least-squares fits estimate covariance, slope, intercept, and R² for each feature against the target. Sensitivity estimates use those fitted relationships to show how target values change as features move.',
    inputs: {
      target:
        'The business or operational signal you want to explain or estimate.',
      features:
        'Potential explanatory signals. Select drivers that could reasonably move with or influence the target.',
      range:
        'The time window used to calculate correlations and fits. Pick a stable operating period when the relationships you care about were active.',
      degree:
        'Controls the intended complexity of the fit. Use 1 (Linear) for the clearest slope, R², and what-if interpretation.',
      binning:
        'How raw samples are aggregated and aligned before comparing target and feature values.',
    },
    outputs: {
      correlationMatrix:
        'The heatmap shows Pearson correlation between every selected signal pair. Values near +1 move together, values near -1 move in opposite directions, and values near 0 have little linear relationship.',
      featureImportance:
        'The bar chart ranks features by univariate R²: the share of target variation explained by that feature alone in the selected window.',
      regressionFit:
        'The fit chart compares the observed target to the fitted values for the strongest feature. A close match means the simple relationship explains much of the target’s movement; visible gaps show unexplained behavior.',
      whatIf:
        'The what-if panel estimates the target from the current slider values using the fitted coefficients. Treat it as a quick sensitivity estimate rather than an optimized control recommendation.',
    },
  },
  segmentation: {
    overview:
      'Segmentation cuts one signal into repeated cycles, summarizes each cycle’s shape, and groups similar cycles together. Use it to compare days, shifts, batches, or other repeatable operating periods. This helps reveal normal families of behavior and cycles that look different from their peers.',
    interpretation:
      'Start with the overview to confirm cycle boundaries, then review cluster sizes and individual cycle cards. Similar colors mean similar cycle shapes; the overlay shows whether a cluster is tight and consistent or broad and variable.',
    technical:
      'Fixed-length cycles are extracted on an even time grid, then compared by shape rather than absolute level. Standard-score normalization (z-normalization) centers each cycle, Piecewise Aggregate Approximation (PAA) summarizes it into segments, and Symbolic Aggregate approXimation (SAX) converts those segments into shape words. Clustering groups cycles by SAX distance so repeated operating modes appear together.',
    inputs: {
      tag: 'The single signal to split into cycles and cluster by shape.',
      range:
        'The period containing the cycles to compare. Include enough complete cycles for the clusters to be meaningful.',
      cycleDuration:
        'The expected length of one cycle, such as an hour, shift, day, or week. Cycle boundaries are drawn at this interval.',
      paaSize:
        'How many segments summarize each cycle before comparison. More segments preserve more shape detail; fewer segments make broader, smoother comparisons.',
      alphabetSize:
        'How many symbolic levels describe each segment’s height. Larger alphabets separate smaller shape differences but can make clusters more sensitive to noise.',
      clusters:
        'The number of shape groups to create. Use fewer clusters for broad patterns and more clusters when there are several distinct operating modes.',
      binning:
        'How samples are aggregated before cycles are extracted. The bin width controls how much detail each cycle contains.',
    },
    outputs: {
      overview:
        'The overview chart shows the full selected signal with dashed lines at cycle boundaries. Use it to confirm that the chosen cycle duration lines up with real operating periods.',
      clusterSummary:
        'The cluster badges summarize how many cycles fell into each shape group. Large clusters represent common behavior; small clusters may deserve review.',
      clusterOverlay:
        'The overlay draws every cycle in the selected cluster together, with the centroid emphasized. Tight overlays indicate consistent repeated behavior; wide spreads indicate variability within the group.',
      cycles:
        'The individual cycle cards show each cycle’s shape and SAX word, colored by cluster. Scan for unusual shapes or click a cluster badge to inspect its members together.',
    },
  },
  patterns: {
    overview:
      'Patterns runs Matrix Profile analyses to find repeated shapes, unusual stretches, and similarity structure in time-series data. It is designed for larger pattern-search jobs that may run through Spark and produce reusable results. Use it when you need to discover motifs or anomalies without manually defining every expected shape.',
    interpretation:
      'Create or select a job, watch its run status, then review the selected result. Low motif distances mean repeated windows are very similar; high discord distances or severity indicate windows that are isolated from the rest of the signal.',
    technical:
      'Matrix Profile methods compare every fixed-length subsequence with others to build a distance profile that exposes motifs, discords, and repeated structure. Motif analyses identify nearest-neighbor pairs, discord analyses highlight isolated windows, and pan-profile variants sweep multiple subsequence lengths. Results are stored as analysis jobs for review and reuse.',
    inputs: {
      analysisWizard:
        'The wizard collects the signal, analysis type, time window, subsequence length, and analysis-specific parameters used to create a Matrix Profile job.',
    },
    outputs: {
      jobPanel:
        'The job panel lists submitted analyses, their status, progress, and run metadata. Select a completed job to inspect its results.',
      results:
        'The results view explains the selected Matrix Profile output, including repeated motifs, unusual discords, labels, and any generated visual summaries.',
    },
  },
};
