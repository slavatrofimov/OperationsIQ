import type { PageExplainer } from '../explainers';

/**
 * Explainer copy for the "Explore" navigation group:
 * explore, discover, compare, calendar, similarity.
 */
export const EXPLORE_EXPLAINERS: Record<string, PageExplainer> = {
  sonify: {
    overview:
      'Sonify turns a single signal into sound so you can *hear* its shape — trends, cycles, and anomalies — as a short melody. It extends the app\u2019s SAX idea from letters into music: each sample\u2019s value is mapped to a musical pitch (centered on middle C and snapped to a scale), a secondary feature drives loudness, and time becomes the note onset. It is a complementary, accessible channel that can surface structure the eye skims past.',
    interpretation:
      'Rising pitch means rising value; a flat stretch holds one sustained note; a jump re-articulates a new, distinct note. With the default loudness source, notes grow louder where the signal deviates from its baseline, so anomalies pop out audibly. Pentatonic keeps arbitrary data consonant; switch to chromatic for a more literal (but harsher) rendering. Watch the moving playhead on the chart to tie what you hear back to a moment in time.',
    technical:
      'The series is optionally PAA-downsampled to a maximum note count, robustly scaled with percentile clipping, mapped to a MIDI note across an octave span centered on middle C, then snapped to the chosen scale (the SAX-alphabet analog). Equal consecutive notes are run-length merged into one sustained note; gaps become rests. Each note\u2019s loudness comes from the selected feature (deviation from baseline, rate of change, magnitude, or fixed). The resulting note list is scheduled on the Web Audio API — one oscillator and gain envelope per note with short anti-click ramps.',
    inputs: {
      tag: 'The single signal to sonify. The first selected tag is played; the core is built to add more voices later.',
      range:
        'The time window to render as sound. Longer windows contain more samples, which are downsampled to the maximum note count to keep playback listenable.',
      binning:
        'How raw samples are aggregated onto the uniform grid before sonification. The bin width sets the effective sample interval that becomes each note slot.',
      scale:
        'The musical scale that pitches are snapped to. Pentatonic avoids dissonance for arbitrary data; chromatic is the most literal; \u201cContinuous\u201d disables snapping.',
      octaves: 'How wide a pitch span (in octaves, centered on middle C) the value range maps across.',
      tempo: 'Playback speed as notes (samples) per second.',
      waveform: 'Oscillator timbre used to synthesize the notes.',
      loudness:
        'What drives each note\u2019s volume. \u201cDeviation from baseline\u201d makes anomalies louder; other options use rate of change, raw magnitude, or a fixed level.',
      maxNotes:
        'The cap on how many notes are played; longer series are aggregated (PAA) down to this many so playback stays short and clear.',
    },
    outputs: {
      player:
        'Transport controls (play / pause / stop) that synthesize the melody in the browser, plus a moving playhead so you can follow the current note on the chart.',
      chart:
        'The signal\u2019s value trace with a playhead marking the note currently sounding, so what you hear lines up with a point in time.',
    },
  },

  spectrum: {
    overview:
      'Spectrum reveals the periodic content of a single signal by transforming it into the frequency domain. Use it to find dominant cycles — for example the rotating or vibration frequency of a pump, fan, or motor, or a hidden daily/shift cycle — that are hard to see in the raw time trace.',
    interpretation:
      'Each peak in the magnitude spectrum is a strong repeating frequency; taller peaks are stronger cycles. Read the peak table to translate a frequency into an equivalent period (how long one cycle lasts). A rising family of peaks (harmonics) often points to rotating equipment; a shift in the dominant peak over time can indicate a developing fault.',
    technical:
      'The signal is aggregated onto a uniform, gap-filled grid, then transformed with the Fast Fourier Transform (series_fft). Magnitude is sqrt(real² + imaginary²) per frequency bin. The DC (mean) term and the mirror half above the Nyquist frequency are dropped, and dominant peaks are found as local maxima ranked by magnitude. Frequency resolution and the highest resolvable frequency both depend on the sample interval (bin width).',
    inputs: {
      tag: 'The single signal to transform into a frequency spectrum.',
      range:
        'The window to analyze. A longer window sharpens frequency resolution; keep the operating mode consistent so cycles do not smear across regimes.',
      binning:
        'How raw samples are aggregated onto the uniform grid before the FFT. The bin width is the sample interval — narrower bins resolve faster cycles, but very coarse bins alias them.',
      windowLength:
        'Spectrogram only: how many samples go into each short-time FFT frame. Longer windows sharpen frequency detail but blur when a change happened; shorter windows localize changes in time but coarsen frequency. "Auto" picks a balanced size from the series length.',
      overlap:
        'Spectrogram only: how much consecutive frames overlap. More overlap gives a smoother, denser time axis (more frames) at the cost of extra computation; 50% is a good default.',
    },
    outputs: {
      chart:
        'The magnitude-vs-frequency spectrum, with detected peaks marked. Hover to read the frequency, its equivalent period, and the magnitude at any point.',
      peaks:
        'A ranked table of the dominant frequency peaks with their equivalent period and magnitude. Use the equivalent period to relate a peak to a physical cycle (e.g. one revolution, one shift).',
      spectrogram:
        'A time-versus-frequency heatmap (spectrogram): each column is a short-time FFT of one frame, colored by magnitude. Read it left-to-right to see how the frequency distribution evolves — a peak drifting up or down, appearing, or splitting signals a changing or developing condition that the single whole-window spectrum averages away.',
    },
  },
  explore: {
    overview:
      'Explore is the main workspace for looking across one or more time-series tags over a chosen time window. Use it to spot changes, compare signals side by side, zoom from a broad overview into detail, and turn an interesting window into a similarity search.',    interpretation:
      'Start with the overview to see the whole selected range, then drag the brush to focus the detail charts. Anomaly markers and event rows point to times worth investigating, while statistics and distributions summarize whether the selected signals are stable, shifted, or unusually spread out.',
    technical:
      'Selected signals are resampled onto a shared time grid, missing points are linearly interpolated when needed, and aggregates are computed for overview and detail resolutions. An optional seasonal-trend decomposition estimates an expected baseline and anomaly scores. Returned time-series values and event markers then drive statistics, distributions, exports, and brushing.',
    inputs: {
      queryTag:
        'The signal to carry forward when you brush a window and choose “Find similar patterns.” Pick the tag whose shape best represents the pattern you want to search for.',
    },
    outputs: {
      overviewChart:
        'The overview shows the full selected time range for every chosen tag. Use it to find broad movements, event markers, and the time span you want to inspect more closely.',
      overviewTable:
        'The overview table contains the same binned values as the overview chart, organized by timestamp so you can inspect or export exact numbers.',
      eventsTable:
        'The events table lists event markers inside the current focus window. Toggle rows to decide which events remain visible on the overview chart.',
      detailChart:
        'The detail charts show the currently brushed time window at a finer resolution. Select a stretch in these charts when you want to send that shape to similarity search.',
      detailTable:
        'The detail table contains the same focused-window values as the detail charts, useful when exact timestamps and values matter more than the visual shape.',
      statistics:
        'The statistics panel summarizes each focused signal with measures such as count, range, average, and variation so you can compare level and stability quickly.',
      distributions:
        'The distribution panel shows how values are spread within the focused window. It helps distinguish a normal operating band from skewed, multimodal, or outlier-heavy behavior.',
    },
  },
  liveview: {
    overview:
      'Live view streams one or more signals over a rolling window that always ends at "now". Use it to watch current behavior update automatically — like a wall-board — without picking fixed start and end times.',
    interpretation:
      'The chart and statistics refresh on the interval you choose, always showing the most recent window. Widen the window to see more history, tighten it to focus on the latest moments, and use the aggregation and resolution controls to pre-aggregate very high-frequency data into a readable trace.',
    technical:
      'On every refresh the entire trailing window is re-queried from the Eventhouse (make-series with the chosen aggregation and bin width) and the client series is replaced wholesale — there is no incremental tailing. The window length comes from the relative selector; the absolute [start, end] is re-anchored to the current time each cycle.',
    inputs: {
      window:
        'The rolling window length measured back from "now" (e.g. last 15 minutes). It is re-anchored to the current time on every refresh, so the view always tracks the latest data.',
    },
    outputs: {
      chart:
        'A continuously updating line chart of the selected signals over the current trailing window. It redraws each refresh cycle with freshly queried data.',
      statistics:
        'Descriptive statistics (count, min, max, mean, median, standard deviation, and 5th/95th percentiles) for each signal over the current window, recomputed on every refresh.',
    },
  },
  discover: {
    overview:
      'Anomalies surfaces unusual behavior in one or more signals without you having to know what to look for in advance. Pick a detection algorithm: SAX (Symbolic Aggregate approXimation) discords ranks the most unusual repeated shape within each signal on its own, while the MVAD (Multivariate Anomaly Detection) detectors (residual voting, random projection, change-point, spectral) analyze how two or more signals move together and flag coordinated anomalies.',
    interpretation:
      'For SAX discords, anomalies are ranked by how different their shape is from everything else — higher nearest-neighbor distance means more unusual. For the MVAD detectors, events are ranked by severity and score, with the votes and contributing signals showing which signals drove each detection. Use the chart to see where flagged windows or bins sit in context, and the table to compare them.',
    technical:
      'SAX discord discovery applies standard-score normalization (z-normalization), summarizes windows with Piecewise Aggregate Approximation (PAA), converts them into Symbolic Aggregate approXimation (SAX) words, and ranks discords by nearest-neighbor distance. The multivariate (MVAD) detectors prepare aligned per-signal series and score a detection window expressed as an integer number of most-recent bins: residual voting scores seasonal/trend residuals, random projection votes across a random-projection ensemble, change-point contrasts level/slope across a moving boundary, and spectral aggregation compares the latest window’s spectral shape against recent baseline windows.',
    inputs: {
      windowSize: 'The length (in bins) of the pattern window to examine. Smaller windows catch brief events; larger windows catch longer-lived shapes.',
      numDiscords: 'How many of the most anomalous windows to return per signal, ranked strongest first.',
      paaSize: 'How many segments each window is reduced to before comparison (PAA). Fewer segments smooth over detail; more segments preserve it.',
      alphabetSize: 'How many symbols the values are bucketed into (the SAX alphabet). A larger alphabet distinguishes finer differences in level.',
      znormThreshold: 'Windows flatter than this (in standard deviations) are treated as noise and skipped, so tiny wiggles are not flagged as anomalies.',
      candidateLimit: 'Roughly how many of the rarest-shaped windows per signal are scored (0 = auto: everything rarer than average). Lower is faster; selection stays spread across the whole signal, so it will not miss anomalies late in the range.',
    },
    outputs: {
      discordsChart:
        'The signal with its most anomalous windows highlighted. Highlighted stretches are the shapes least like anything else in the series — candidates worth investigating.',
      discordsTable:
        'Each ranked anomaly with its time span, duration, and distance to its nearest neighbor (higher = more unusual), plus the SAX shape-word and how often that word occurs.',
    },
  },
  classifiers: {
    overview:
      'Classifiers lets you train an interpretable model that labels new windows by their shape. Label a few example windows with a class, train a SAX-VSM model, then classify new windows and see which shape-words drove each decision.',
    interpretation:
      'The classifier reports a predicted class plus its confidence, followed by the cosine similarity to each class and the shape-words that contributed most — so the decision is explainable rather than a black box.',
    technical:
      'Classification uses the SAX Vector Space Model (SAX-VSM): windows are z-normalized, summarized with Piecewise Aggregate Approximation (PAA), and converted into Symbolic Aggregate approXimation (SAX) words. Class vocabularies are weighted with Term Frequency–Inverse Document Frequency (TF-IDF) and matched by cosine similarity.',
    inputs: {
      windowSize: 'The length (in bins) of the pattern window to examine. Smaller windows catch brief events; larger windows catch longer-lived shapes.',
      paaSize: 'How many segments each window is reduced to before comparison (PAA). Fewer segments smooth over detail; more segments preserve it.',
      alphabetSize: 'How many symbols the values are bucketed into (the SAX alphabet). A larger alphabet distinguishes finer differences in level.',
      znormThreshold: 'Windows flatter than this (in standard deviations) are treated as noise and skipped.',
      binSize: 'The bin width used to sample every training and input series. Use the SAME bin for training and classifying, or the shape-words will not line up.',
    },
    outputs: {
      classifyResult:
        "The predicted class for the selected window and the model's confidence, followed by the cosine similarity to each class and the shape-words that contributed most — so the decision is explainable rather than a black box.",
    },
  },
  similarity: {
    overview:
      'Similarity search finds other places where a selected shape appears. Use it when you see a pattern in one signal or a group of signals and want to know when it happened again, either in the same tag or across other tags.',
    interpretation:
      'Matches are ranked from closest to least close. Compare the query shape against each match, then use the search-space timeline and details table to see where the matches occurred and whether the alignment makes operational sense.',
    technical:
      'Search turns the query window and candidate windows into standard-score normalized (z-normalized) Symbolic Aggregate approXimation (SAX) representations, then compares symbolic shape distance across possible alignments and duration scales. Single-signal search ranks matching windows directly; multi-signal search combines per-track matches that occur within an allowed time delay, with either the same tags recurring or explicitly mapped tags paired across assets. Raw series are overlaid only to help visually audit the scored matches.',
    inputs: {
      queryTags:
        'The signal or signals whose shape defines the pattern. One tag runs a single-series search; two or more tags search for their combined movement — either recurring across the same tags or, in explicit mapping mode, located on other tags you map them to.',
      queryWindow:
        'The time window that defines the pattern to match. Everything between the start and end becomes the query shape.',
      searchTags:
        'The tags to scan for the query pattern. Include every signal where the same shape might appear.',
      searchWindow:
        'The time span to scan for matches. A wider range can find more repeats, but it takes longer and may return more near-duplicates.',
      queryLengthSymbols:
        'How many symbolic segments describe the query shape. Fewer segments are more forgiving; more segments preserve finer detail.',
      alphabetSize:
        'How many value levels are used when converting the shape into symbols. Larger alphabets distinguish smaller differences in height.',
      topK: 'The maximum number of best matches to return, ranked from most to least similar.',
      minScale:
        'The shortest version of the pattern to consider. Values below 1 look for the same shape happening faster than the query.',
      maxScale:
        'The longest version of the pattern to consider. Values above 1 look for the same shape happening more slowly than the query.',
      scaleSteps:
        'How many pattern durations to test between the minimum and maximum scale. More steps catch more timing variation but take longer.',
      symbolTolerance:
        'How much each symbolic segment may differ and still count as a match. Lower values are stricter; higher values allow near-misses.',
      znormThreshold:
        'A small variation floor used during normalization so nearly flat noise is not amplified into a false shape.',
      maxInterTrackDelay:
        'Multi-tag only: how far apart individual tag matches may start and still be treated as the same combined event.',
      perTrackTopK:
        'Multi-tag only: how many candidate matches to keep per tag before assembling combined multi-tag matches.',
      multivariateMode:
        'Multi-tag only: choose how the search space is defined. Recurrence scans the same query tags for their combined pattern happening again; explicit tag mapping compares the query pattern against a different set of tags you map each query tag to — useful for finding a pattern from one asset on another.',
      tagMapping:
        'Explicit mapping only: for each query tag, pick the search-space tag it should be compared against. The query tag supplies the shape; the mapped tag is the signal scanned for that shape.',
      chartLayout:
        'How to arrange the result charts. Combined overlays matches in one view, while separate layouts make individual matches easier to inspect.',
    },
    outputs: {
      multivariateMatches:
        'The multivariate result shows where the combined query shape recurs across the selected tags. Review the per-track scores to see which signals drove each match.',
      comparisonChart:
        'The pattern comparison chart overlays the query and matched windows so you can judge whether the returned shapes are visually similar.',
      timelineChart:
        'The search-space timeline places matches back into their original time context, helping you see whether they cluster around events, shifts, or repeated operating cycles.',
      matchDetails:
        'The match details table lists the returned matches and their scoring fields so you can sort, audit, and export the exact result rows.',
    },
  },
  compare: {
    overview:
      'Compare overlays one tag across multiple time periods after aligning each period by elapsed time from its start. Use it to compare repeated runs, shifts, days, campaigns, or operating windows without the calendar dates getting in the way.',
    interpretation:
      'Lines that move together show similar behavior across periods; separation shows a level shift or timing difference. The statistics table highlights whether each period differs in count, mean, range, or variability.',
    technical:
      'Each selected period is aggregated onto the same time grid, resampled at the chosen bin width, and aligned by elapsed time from the period start. Summary statistics are computed from aligned values so periods can be compared by level, spread, count, and variation.',
    inputs: {
      tag: 'The signal to compare across all selected periods.',
      period:
        'One time window to include in the comparison. Add periods for each run, shift, day, or operating window you want to overlay.',
    },
    outputs: {
      overlayChart:
        'The overlay chart aligns each period at time zero and draws them on the same elapsed-time axis, making shape, timing, and level differences easier to see.',
      statisticsTable:
        'The statistics table summarizes each period and shows the mean difference from Period 1, helping you quantify changes that are visible in the overlay.',
    },
  },
  calendar: {
    overview:
      'Heatmaps turns your signals into calendar and date-attribute heatmaps plus a compact horizon view. Use them to find day-by-day patterns, recurring highs and lows by time of day, weekday, or month, and how those cycles relate to the detailed time-series shape.',
    interpretation:
      'Darker cells represent higher aggregate values and lighter cells represent lower values. The calendar shows one cell per day; the attribute grid groups values by cyclical parts of the timestamp (such as hour of day versus day of week). The horizon view stacks every signal as its own narrow value-banded band so sustained high or low periods stand out across all signals at once.',
    technical:
      'Calendar cells use a daily aggregation pass, while attribute heatmaps re-group the adaptively binned detail samples by the chosen timestamp attributes (minute, hour, day of week, day of month, month) and combine them with the selected aggregation. The horizon bands reuse the detail resolution and assign light-to-dark value bands per signal, letting calendar-level, cyclical, and sub-day patterns be reviewed together.',
    inputs: {
      tag: 'The signals to summarize as heatmaps and horizon bands. Multiple signals render as small multiples.',
      range:
        'The time window to include. Longer ranges reveal seasonal, weekday, or hourly patterns; shorter ranges make recent changes easier to inspect.',
    },
    outputs: {
      calendarHeatmap:
        'The calendar heatmap shows one cell per day, colored by that day’s aggregate value, so daily highs, lows, and recurring patterns are easy to spot.',
      attributeHeatmap:
        'The attribute heatmap groups values by cyclical parts of the timestamp — minute, hour, day of week, day of month, or month — and can cross two of them into a matrix, making time-of-day, weekday, and seasonal cycles easy to compare.',
      horizonGraph:
        'The horizon view combines every signal into a single compact chart, drawing each as a narrow value-banded band on a shared time axis so extended high or low periods stand out across signals.',
    },
  },
  trendvolatility: {
    overview:
      'Trend & volatility summarizes a single signal into per-interval bars — the value it opened at, its high and low, and where it closed — with a volume sub-panel and moving averages. Use it to see how each interval ranged, whether swings are widening or settling, and whether the signal is trending up, down, or turning.',
    interpretation:
      'Each candle spans one bin: the body runs from the open to the close and the wicks reach the interval high and low, so tall candles and long wicks mark volatile intervals while short ones mark calm periods. Green (close above open) versus red (close below open) shows the direction within each interval, the volume bars show how many raw records fell in each bin, and the moving averages smooth the close to confirm a trend or flag a turning point.',
    technical:
      'For each adaptive time bin the query computes open (earliest value), close (latest value), high, low, and volume (raw-record count) directly from the source series, so every plotted metric traces back to the raw data. Moving averages are simple averages of the binned close over the configured window lengths and are derived client-side, leaving a gap until each window is full.',
    inputs: {
      tag: 'The signal to plot as candlesticks. Open, high, low, close, and volume are pre-aggregated per bin from this tag; the moving averages are derived from the close.',
      range:
        'The time window to summarize. The bin resolution adapts to the window so each interval becomes one candle; wider windows produce coarser candles.',
    },
    outputs: {
      candlestick:
        'The candlestick chart pre-aggregates the window into open/high/low/close bars per bin, with a volume sub-panel and moving averages. Use it to see how each interval opened, closed, and ranged, and whether the moving averages confirm a trend or a turning point.',
    },
  },
  processmining: {
    overview:
      'Process mining turns a continuous signal into discrete operating states using value bands — for example off / idle / run / overload, or the default low / normal / high — then discovers the operational sequences the equipment actually follows, such as a startup ramp, along with how often each sequence occurs and how long it typically takes. Use it to understand real operating behaviour, spot unexpected paths, and quantify dwell and cycle times.',
    interpretation:
      'The state timeline shows each period the signal spent in a state, one lane per state. The discovered-sequence table lists the most common runs of consecutive states: a high count means a recurring, repeatable pattern; the median duration tells you how long that pattern usually lasts. Rare sequences can indicate abnormal operation worth investigating.',
    technical:
      'The signal is aggregated onto adaptive bins and each bin is classified into one of N+1 operating bands defined by N ascending thresholds (each threshold is the inclusive lower bound of the band above it). The KQL scan operator walks the time-ordered bins maintaining a segment id that increments when the state changes, collapsing consecutive same-state bins into episodes. Recurring sequences are mined client-side as sliding windows of consecutive episode states, counted and summarized by median total duration. States are derived from one signal only; correlating sequences with discrete events is a future extension.',
    inputs: {
      tag: 'The single signal whose values are discretized into operating states.',
      bands:
        'The operating bands the signal is classified into, from lowest to highest. Each threshold is the inclusive lower bound of the band above it, so N thresholds create N+1 bands. Start with the default low / normal / high, then add, rename, or re-threshold bands to match the real operating modes (e.g. off / idle / run / overload).',
      seqLength: 'How many consecutive states make up each mined sequence. Longer sequences describe fuller cycles but occur less often.',
    },
    outputs: {
      timeline:
        'A state timeline (swimlane) with one lane per operating state. Each bar is an episode — a continuous period the signal spent in that state — so you can see the order and duration of state changes at a glance.',
      sequences:
        'The recurring sequences of consecutive states, ranked by how often they occur. The count shows how repeatable each operational path is, and the median duration shows how long that path typically takes end to end.',
    },
  },
};
