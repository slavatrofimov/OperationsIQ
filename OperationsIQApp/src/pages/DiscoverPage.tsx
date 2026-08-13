import { useEffect, useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields } from '../lib/captureContextHelpers';
import * as echarts from 'echarts';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Badge,
  Body1,
  Button,
  Card,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Select,
  Spinner,
  Subtitle1,
  Subtitle2,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add24Regular, CommentAdd24Regular, Delete24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { STANDARD_TIMESPANS } from '../lib/binning';
import { usePageBinning } from '../context/BinningContext';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { chooseBinFor, formatDuration, type BinningSettings } from '../lib/binningSettings';
import {
  buildDiscordsQuery,
  buildMvadCoverageQuery,
  buildMvadQuery,
  buildSearchSpaceSeriesQuery,
  buildVsmClassifyQuery,
  buildVsmTrainQuery,
  buildVsmTrainingTableExpr,
  vsmTrainingScope,
  type MvadAlgorithm,
  type MvadDetectorParams,
  type VsmTrainingExample,
} from '../lib/kql';
import {
  parseMvadRows,
  parseMvadCoverageRows,
  summarizeMvadCoverage,
  type MvadResultRow,
  type MvadCoverageRow,
} from '../lib/mvad';
import {
  PAGE_ALGORITHMS,
  clampDetectionBins,
  defaultDetectionBins,
  defaultMvadParams,
  detectionWindowKql,
  eventIndexToMs,
  isMvadAlgorithm,
  minDetectionBins,
  pageAlgorithmInfo,
  contributorShares,
  type PageAlgorithm,
} from '../lib/mvadViz';
import { executeKql } from '../lib/eventhouse';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { SegmentPicker } from '../components/SegmentPicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { withInfo } from '../components/fieldInfo';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { ChartFrame } from '../components/ChartFrame';
import { defaultRange } from '../lib/appTypes';
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import { PALETTE, ANOMALY_COLOR } from '../lib/series';
import { parseSeriesMap } from '../lib/similarityViz';
import {
  parseDiscordRows,
  type DiscordRow,
} from '../lib/discover';
import type { ChartData } from '../lib/export';
import {
  deleteVsmModel,
  listVsmModels,
  loadVsmTerms,
  parseVsmClassifyResult,
  parseVsmTerms,
  saveVsmModel,
  type VsmClassifyResult,
  type VsmModelSummary,
} from '../lib/vsm';
import { TIME_AXIS_LABEL, timeAxisPointerLabel, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useProfile } from '../context/ProfileContext';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { formatInstantIso, formatQueryInstantIso } from '../lib/timezone';
import { CreateAnomalyAlertDialog } from '../components/CreateAnomalyAlertDialog';
import { CreateSaxDiscordAlertDialog } from '../components/CreateSaxDiscordAlertDialog';
import { useChartAnnotations, type UseChartAnnotationsResult } from '../hooks/useChartAnnotations';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';

const useStyles = makeStyles({
  layout: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalL },
  // Horizontal scroll so wide results tables never squeeze columns together.
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Long text columns (signal names, comma-joined contributor lists, SAX words):
  // minWidth 0 lets the flex cell shrink and overflowWrap wraps instead of
  // overlapping the adjacent column.
  wrapCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  tagField: { minWidth: '320px' },
  params: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalL,
    alignItems: 'start',
    // Grid children default to min-content; Fluent Dropdowns carry a 250px
    // min-width that otherwise overflows their track and swallows the gaps.
    '> *': { minWidth: 0 },
  },
  num: { maxWidth: '140px' },
  paramControl: { minWidth: 0, width: '100%', maxWidth: '220px' },
  hint: { color: tokens.colorNeutralForeground3 },
  algoInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  algoField: { minWidth: '260px' },
  detWindow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  chartHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalS },
  matchHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', marginBottom: tokens.spacingVerticalS },
  entityField: { minWidth: '260px' },
  exampleRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  labelField: { minWidth: '140px' },
  modelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalXS,
  },
  spacer: { flex: 1 },
  coverageBadges: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    marginBottom: tokens.spacingVerticalS,
  },
});

interface Params {
  windowSize: number;
  numDiscords: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  candidateLimit: number;
}

const DEFAULT_PARAMS: Params = {
  windowSize: 16,
  numDiscords: 3,
  paaSize: 4,
  alphabetSize: 5,
  znormThreshold: 0.01,
  candidateLimit: 512,
};

const PARAM_INFO: Record<keyof Params, string> = {
  windowSize:
    'The length (in data points) of the subsequence to score for anomaly. A discord is a window of this size that is the most different from every other window. Larger windows find longer-lasting anomalies.',
  numDiscords: 'How many of the most anomalous windows to return per signal, ranked strongest first.',
  paaSize:
    'How many segments each window is summarized into before comparing. Fewer segments = coarser, faster; more = finer detail. Must be <= window size.',
  alphabetSize:
    'How many distinct levels describe the height of each segment. Larger distinguishes small differences; typical values are 3-6.',
  znormThreshold:
    'A small floor on variation used when normalizing each window. It stops nearly-flat, noisy windows from being amplified into false anomalies. Leave near 0.01.',
  candidateLimit:
    'How many of the rarest-shaped windows per signal to score against every other window (0 = auto: score every window rarer than average). Selection is by SAX-word rarity — since an anomaly is a rarely-repeated shape, common shapes are skipped. This is a rarity rank, not a positional cap, so anomalies late in the range are still found; it also bounds the work so long signals stay fast and within memory. Raise it to scan more windows, lower it to speed up very long signals.',
};

interface SaxDiscoverResult {
  kind: 'sax';
  discords: DiscordRow[];
  series: Map<string, number[]>;
  binSeconds: number;
  searchStartMs: number;
  /** SAX parameters the completed run used (so an alert matches what is shown). */
  params: Params;
  /** Detection-window bins the completed run used (0 = whole-range explore mode). */
  detectionWindowBins: number;
  /** Bin literal (e.g. '15m') and human label the completed run used. */
  binKql: string;
  binLabel: string;
}

interface MvadDiscoverResult {
  kind: 'mvad';
  algorithm: MvadAlgorithm;
  rows: MvadResultRow[];
  coverage: MvadCoverageRow[];
  series: Map<string, number[]>;
  binMillis: number;
  startMs: number;
  endMs: number;
  detectionBins: number;
}

type DiscoverResult = SaxDiscoverResult | MvadDiscoverResult;

/** How one MVAD detector parameter is edited in the Advanced-parameters panel. */
type MvadParamKind = 'number' | 'integer' | 'boolean' | 'enum' | 'text';

interface MvadParamMeta {
  label: string;
  info: string;
  kind: MvadParamKind;
  step?: number;
  /** Allowed values for `kind: 'enum'`. */
  enumValues?: { value: string; label: string }[];
}

const TREND_OPTIONS = [
  { value: 'linefit', label: 'linefit (remove a fitted line)' },
  { value: 'avg', label: 'avg (remove the mean)' },
  { value: 'none', label: 'none (keep the raw level)' },
];

const OUTLIER_KIND_OPTIONS = [
  { value: 'ctukey', label: 'ctukey (causal Tukey)' },
  { value: 'tukey', label: 'tukey' },
];

/**
 * Editing metadata for every MVAD detector parameter. The per-algorithm set of
 * parameters is derived at render time from the keys of
 * `defaultMvadParams(algorithm)`, so each detector only shows the knobs it uses.
 */
const MVAD_PARAM_META: Record<keyof MvadDetectorParams, MvadParamMeta> = {
  seasonality: {
    label: 'Seasonality (bins)',
    info: 'Length of the repeating cycle to remove before scoring, in bins. 0 = auto-detect; -1 = assume no seasonality.',
    kind: 'integer',
  },
  trend: {
    label: 'Trend removal',
    info: 'How each track’s slow drift is removed before residuals are scored.',
    kind: 'enum',
    enumValues: TREND_OPTIONS,
  },
  outlierKind: {
    label: 'Outlier scoring',
    info: 'Robust score used on the standardized residuals. “ctukey” is causal (uses only history); “tukey” is two-sided.',
    kind: 'enum',
    enumValues: OUTLIER_KIND_OPTIONS,
  },
  featureScoreThreshold: {
    label: 'Feature score threshold',
    info: 'A track votes when its residual feature score exceeds this many robust deviations. Higher = fewer, stronger votes.',
    kind: 'number',
    step: 0.1,
  },
  residualRmsThreshold: {
    label: 'Residual RMS threshold',
    info: 'Minimum dimension-invariant RMS across voting tracks for a bin to be flagged. Higher = stricter.',
    kind: 'number',
    step: 0.1,
  },
  extremeFeatureThreshold: {
    label: 'Extreme feature threshold',
    info: 'A single track this extreme flags the bin on its own (escape hatch), even without a quorum of votes.',
    kind: 'number',
    step: 0.1,
  },
  projectionCount: {
    label: 'Projection count',
    info: 'How many random directions the tracks are projected onto. More projections = steadier scores, more work.',
    kind: 'integer',
  },
  projectionDensity: {
    label: 'Projection density',
    info: 'Fraction of tracks contributing to each random projection (0–1). Sparser projections isolate coordinated moves.',
    kind: 'number',
    step: 0.05,
  },
  projectionSeed: {
    label: 'Projection seed',
    info: 'Seed string for the random projections. A fixed seed makes results deterministic and reproducible.',
    kind: 'text',
  },
  projectionScoreThreshold: {
    label: 'Projection score threshold',
    info: 'A projection votes when its score exceeds this many robust deviations. Higher = fewer, stronger votes.',
    kind: 'number',
    step: 0.1,
  },
  projectionRmsThreshold: {
    label: 'Projection RMS threshold',
    info: 'Minimum RMS across voting projections for a bin to be flagged. Higher = stricter.',
    kind: 'number',
    step: 0.1,
  },
  minProjectionVotes: {
    label: 'Min projection votes',
    info: 'How many projections must agree before a bin is flagged.',
    kind: 'integer',
  },
  extremeProjectionThreshold: {
    label: 'Extreme projection threshold',
    info: 'A single projection this extreme flags the bin on its own (escape hatch).',
    kind: 'number',
    step: 0.1,
  },
  stdevFloor: {
    label: 'Std-dev floor',
    info: 'A tiny floor on per-track variability to stop flat, noisy tracks from being amplified. Leave near 1e-6.',
    kind: 'number',
    step: 0.000001,
  },
  maxWorkRows: {
    label: 'Max work rows',
    info: 'Safety cap on intermediate rows the projection ensemble may materialize. Raise only if you hit a work-limit diagnostic.',
    kind: 'integer',
  },
  contrastWindowBins: {
    label: 'Contrast window (bins)',
    info: 'How many bins on each side of a candidate boundary are compared when testing for a level/slope shift.',
    kind: 'integer',
  },
  changeRmsThreshold: {
    label: 'Change RMS threshold',
    info: 'Minimum RMS across voting tracks for a coordinated shift to be flagged. Higher = stricter.',
    kind: 'number',
    step: 0.1,
  },
  detectSlopeChanges: {
    label: 'Detect slope changes',
    info: 'When on, also flags changes in slope (trend), not just level shifts.',
    kind: 'boolean',
  },
  baselineWindowCount: {
    label: 'Baseline windows',
    info: 'How many recent full windows form the spectral baseline the latest window is compared against.',
    kind: 'integer',
  },
  minBaselineWindows: {
    label: 'Min baseline windows',
    info: 'Fewest baseline windows required before spectral scoring runs; otherwise it reports insufficient history.',
    kind: 'integer',
  },
  useHannWindow: {
    label: 'Hann window',
    info: 'Apply a Hann taper before the FFT to reduce spectral leakage. Usually leave on.',
    kind: 'boolean',
  },
  spectralRmsThreshold: {
    label: 'Spectral RMS threshold',
    info: 'Minimum RMS across voting tracks for a spectral change to be flagged. Higher = stricter.',
    kind: 'number',
    step: 0.1,
  },
  trackScoreThreshold: {
    label: 'Track score threshold',
    info: 'A track votes when its score exceeds this many robust deviations. Higher = fewer, stronger votes.',
    kind: 'number',
    step: 0.1,
  },
  extremeTrackThreshold: {
    label: 'Extreme track threshold',
    info: 'A single track this extreme flags the event on its own (escape hatch).',
    kind: 'number',
    step: 0.1,
  },
  minTrackVotes: {
    label: 'Min track votes',
    info: 'Minimum number of tracks that must agree. The effective vote threshold is the LARGER of this and Min vote fraction × signal count, so both conditions must be satisfied (the stricter one wins).',
    kind: 'integer',
  },
  minVoteFraction: {
    label: 'Min vote fraction',
    info: 'Minimum fraction of tracks (0–1) that must agree. The effective vote threshold is the LARGER of this × signal count and Min track votes, so both conditions must be satisfied (the stricter one wins).',
    kind: 'number',
    step: 0.05,
  },
};

/** Default make-series data-quality gates (mirror kql.ts buildMvadQuery defaults). */
const MVAD_MIN_COVERAGE_DEFAULT = 0.95;
const MVAD_MAX_GAP_DEFAULT = 3;
const MVAD_MIN_COVERAGE_INFO =
  'Fraction of bins in the range that must contain data (0–1) for a signal to be scored. Missing bins are linearly interpolated first; lower this to tolerate sparser signals, at the cost of scoring more interpolated data.';
const MVAD_MAX_GAP_INFO =
  'Longest run of consecutive empty bins a signal may have and still be scored. Gaps up to this length are filled by linear interpolation; raise it to bridge longer outages, but long fills invent data and can create or hide anomalies.';

function NumberField({
  label,
  info,
  value,
  step,
  onChange,
}: {
  label: string;
  info: string;
  value: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  const styles = useStyles();
  return (
    <Field label={withInfo(label, info)}>
      <Input
        className={styles.num}
        type="number"
        step={step ?? 1}
        value={String(value)}
        onChange={(_, d) => {
          const n = Number(d.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </Field>
  );
}

/** A single-line text Field (used for the projection seed). */
function TextParamField({
  label,
  info,
  value,
  onChange,
}: {
  label: string;
  info: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={withInfo(label, info)}>
      <Input value={value} onChange={(_, d) => onChange(d.value)} />
    </Field>
  );
}

/**
 * Advanced-parameters editor for the selected MVAD detector. Renders one control
 * per parameter the detector uses (derived from its defaults), seeded from
 * `MVAD_DEFAULT_PARAMS` and layered with the caller's overrides.
 */
function MvadParamEditor({
  algorithm,
  overrides,
  onChange,
}: {
  algorithm: MvadAlgorithm;
  overrides: Partial<MvadDetectorParams>;
  onChange: (key: keyof MvadDetectorParams, value: number | string | boolean) => void;
}) {
  const styles = useStyles();
  const defaults = defaultMvadParams(algorithm);
  const keys = Object.keys(defaults) as (keyof MvadDetectorParams)[];
  return (
    <div className={styles.params}>
      {keys.map((key) => {
        const meta = MVAD_PARAM_META[key];
        if (!meta) return null;
        const current = overrides[key] ?? defaults[key];
        if (meta.kind === 'boolean') {
          return (
            <Field key={key} label={withInfo(meta.label, meta.info)}>
              <Switch
                checked={Boolean(current)}
                onChange={(_, d) => onChange(key, d.checked)}
              />
            </Field>
          );
        }
        if (meta.kind === 'enum') {
          const strVal = String(current ?? '');
          const selected = meta.enumValues?.find((o) => o.value === strVal);
          return (
            <Field key={key} label={withInfo(meta.label, meta.info)}>
              <Dropdown
                className={styles.paramControl}
                value={selected?.label ?? strVal}
                selectedOptions={[strVal]}
                onOptionSelect={(_, d) => {
                  if (d.optionValue != null) onChange(key, d.optionValue);
                }}
              >
                {meta.enumValues?.map((o) => (
                  <Option key={o.value} value={o.value}>
                    {o.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          );
        }
        if (meta.kind === 'text') {
          return (
            <TextParamField
              key={key}
              label={meta.label}
              info={meta.info}
              value={String(current ?? '')}
              onChange={(v) => onChange(key, v)}
            />
          );
        }
        return (
          <NumberField
            key={key}
            label={meta.label}
            info={meta.info}
            step={meta.step}
            value={Number(current)}
            onChange={(n) => onChange(key, meta.kind === 'integer' ? Math.round(n) : n)}
          />
        );
      })}
    </div>
  );
}

export interface DiscoverPageProps {
  tags: TagInfo[];
}

/** Discover anomalies: unsupervised anomaly detection (discords). */
export function DiscoverPage({ tags }: DiscoverPageProps) {
  const styles = useStyles();

  return (
    <div className={styles.layout}>
      <PageIntro
        title="Anomalies"
        overview={EXPLAINERS.discover.overview}
        interpretation={EXPLAINERS.discover.interpretation}
        technical={EXPLAINERS.discover.technical}
      />
      <DiscordsTab tags={tags} />
    </div>
  );
}

/** Classifiers: train and apply an interpretable SAX-VSM shape classifier. */
export function ClassifiersPage({ tags }: DiscoverPageProps) {
  const styles = useStyles();

  return (
    <div className={styles.layout}>
      <PageIntro
        title="Classifiers"
        overview={EXPLAINERS.classifiers.overview}
        interpretation={EXPLAINERS.classifiers.interpretation}
        technical={EXPLAINERS.classifiers.technical}
      />
      <VsmTab tags={tags} />
    </div>
  );
}

/** Anomaly (discord) discovery via the SAX library's `sax_discords`. */
function DiscordsTab({ tags }: DiscoverPageProps) {
  const styles = useStyles();
  const [searchTags, setSearchTags] = useSharedTags();
  const [range, setRange] = useSharedRange();
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [algorithm, setAlgorithm] = useState<PageAlgorithm>('sax_discords');
  const [detectionBins, setDetectionBins] = useState<number>(4);
  const [mvadParams, setMvadParams] = useState<Partial<MvadDetectorParams>>({});
  const [minCoverage, setMinCoverage] = useState<number>(MVAD_MIN_COVERAGE_DEFAULT);
  const [maxGapBins, setMaxGapBins] = useState<number>(MVAD_MAX_GAP_DEFAULT);
  // SAX discords optional detection window (explore mode by default). When on,
  // discords are confined to the most-recent N bins and scored against history
  // only — the shape an alert can monitor. Bins must be >= the SAX window size.
  const [saxDetectionOn, setSaxDetectionOn] = useState(false);
  const [saxDetectionBins, setSaxDetectionBins] = useState<number>(48);
  const binning = usePageBinning();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: searchTags, range, showMarkers: showOnChart });

  const isMvad = isMvadAlgorithm(algorithm);
  const algoInfo = pageAlgorithmInfo(algorithm);
  const { activeProfile } = useProfile();
  const [alertOpen, setAlertOpen] = useState(false);

  // Detection window is expressed as an integer number of most-recent bins, so
  // it is always an exact multiple of the bin (no `misaligned_series`). The
  // effective bins are clamped to the algorithm's minimum (spectral >= 32).
  const bin = useMemo(
    () => chooseBinFor({ start: range.start, end: range.end }, binning.settings),
    [range, binning.settings],
  );
  const effectiveDetectionBins = isMvad
    ? clampDetectionBins(detectionBins, algorithm as MvadAlgorithm)
    : detectionBins;
  const detectionMin = isMvad ? minDetectionBins(algorithm as MvadAlgorithm) : 1;
  const belowMin = isMvad && detectionBins < detectionMin;
  const detectionDurationLabel =
    bin && Number.isFinite(bin.millis) && bin.millis > 0
      ? formatDuration((effectiveDetectionBins * bin.millis) / 1000)
      : null;
  const saxEffectiveDetectionBins = Math.max(saxDetectionBins, params.windowSize);
  const saxDetectionDurationLabel =
    bin && Number.isFinite(bin.millis) && bin.millis > 0
      ? formatDuration((saxEffectiveDetectionBins * bin.millis) / 1000)
      : null;

  // Set sensible defaults when the user picks a different algorithm.
  const selectAlgorithm = (next: PageAlgorithm) => {
    setAlgorithm(next);
    if (isMvadAlgorithm(next)) {
      setDetectionBins(defaultDetectionBins(next));
      setMvadParams({});
    }
  };
  const setMvadParam = (key: keyof MvadDetectorParams, value: number | string | boolean) =>
    setMvadParams((p) => ({ ...p, [key]: value }));

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (searchTags.length === 0) return null;
    const settingsFields = isMvad
      ? [
          { label: 'Detection window (bins)', value: String(effectiveDetectionBins) },
          ...(detectionDurationLabel
            ? [{ label: 'Detection window', value: detectionDurationLabel }]
            : []),
          { label: 'Minimum coverage', value: `${(minCoverage * 100).toFixed(0)}%` },
          { label: 'Max gap (bins)', value: String(maxGapBins) },
          ...(Object.keys(defaultMvadParams(algorithm as MvadAlgorithm)) as (keyof MvadDetectorParams)[])
            .filter((key) => MVAD_PARAM_META[key])
            .map((key) => ({
              label: MVAD_PARAM_META[key].label,
              value: String(mvadParams[key] ?? defaultMvadParams(algorithm as MvadAlgorithm)[key]),
            })),
          ...binningFields(binning.settings),
        ]
      : [
          { label: 'Window size', value: String(params.windowSize) },
          { label: 'Discords', value: String(params.numDiscords) },
          { label: 'PAA size', value: String(params.paaSize) },
          { label: 'Alphabet size', value: String(params.alphabetSize) },
          { label: 'Z-norm threshold', value: String(params.znormThreshold) },
          { label: 'Candidate limit', value: String(params.candidateLimit) },
          ...binningFields(binning.settings),
        ];
    return {
      sections: [
        { title: 'Mode', fields: [{ label: 'Algorithm', value: algoInfo.label }] },
        { title: 'Tags', fields: [{ label: 'Signals', value: tagNames(searchTags, nameById) }] },
        {
          title: 'Time range',
          fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }],
        },
        { title: 'Settings', fields: settingsFields },
      ],
    };
  }, [
    searchTags,
    nameById,
    range,
    params,
    binning.settings,
    isMvad,
    algorithm,
    algoInfo.label,
    mvadParams,
    effectiveDetectionBins,
    detectionDurationLabel,
    minCoverage,
    maxGapBins,
  ]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(async (): Promise<DiscoverResult> => {
    const settings: BinningSettings = binning.settings;
    const runBin = chooseBinFor({ start: range.start, end: range.end }, settings);
    const spaceCsl = buildSearchSpaceSeriesQuery({
      tagIds: searchTags,
      start: range.start,
      end: range.end,
      binKql: runBin.kql,
    });

    if (!isMvadAlgorithm(algorithm)) {
      const saxDetBins = saxDetectionOn ? Math.max(saxDetectionBins, params.windowSize) : 0;
      const discordsCsl = buildDiscordsQuery({
        tagIds: searchTags,
        start: range.start,
        end: range.end,
        binKql: runBin.kql,
        ...params,
        detectionWindowBins: saxDetBins,
      });
      const [discordsTable, spaceTable] = await Promise.all([
        executeKql(discordsCsl),
        executeKql(spaceCsl),
      ]);
      return {
        kind: 'sax',
        discords: parseDiscordRows(discordsTable),
        series: parseSeriesMap(spaceTable),
        binSeconds: runBin.millis / 1000,
        searchStartMs: range.start.getTime(),
        params: { ...params },
        detectionWindowBins: saxDetBins,
        binKql: runBin.kql,
        binLabel: runBin.label,
      };
    }

    const detBins = clampDetectionBins(detectionBins, algorithm);
    const mvadCsl = buildMvadQuery({
      algorithm,
      tagIds: searchTags,
      start: range.start,
      end: range.end,
      binKql: runBin.kql,
      binMillis: runBin.millis,
      minCoverage,
      maxGapBins,
      detectionWindowKql: detectionWindowKql(detBins, runBin.millis),
      params: mvadParams,
    });
    const coverageCsl = buildMvadCoverageQuery({
      tagIds: searchTags,
      start: range.start,
      end: range.end,
      binKql: runBin.kql,
      binMillis: runBin.millis,
      minCoverage,
      maxGapBins,
    });
    const [mvadTable, coverageTable, spaceTable] = await Promise.all([
      executeKql(mvadCsl),
      executeKql(coverageCsl),
      executeKql(spaceCsl),
    ]);
    return {
      kind: 'mvad',
      algorithm,
      rows: parseMvadRows(mvadTable),
      coverage: parseMvadCoverageRows(coverageTable),
      series: parseSeriesMap(spaceTable),
      binMillis: runBin.millis,
      startMs: range.start.getTime(),
      endMs: range.end.getTime(),
      detectionBins: detBins,
    };
  });

  const setParam = (key: keyof Params) => (n: number) => setParams((p) => ({ ...p, [key]: n }));
  const enoughTags = isMvad ? searchTags.length >= 2 : searchTags.length > 0;
  const canRun = enoughTags && !state.loading;
  const result = state.data;
  const saxResult = result && result.kind === 'sax' ? result : null;
  const mvadResult = result && result.kind === 'mvad' ? result : null;
  const findDiscords = () => run().catch(() => {});

  // Human 'Label: value' lines for the non-default detector overrides, passed to
  // the Create-Anomaly-Alert dialog so the alert Notes stay reproducible.
  const alertParamLines = useMemo(
    () =>
      (Object.keys(mvadParams) as (keyof MvadDetectorParams)[])
        .filter((k) => mvadParams[k] != null && MVAD_PARAM_META[k])
        .map((k) => `${MVAD_PARAM_META[k].label}: ${String(mvadParams[k])}`),
    [mvadParams],
  );

  const canCreateAlert =
    isMvad &&
    !!mvadResult &&
    !state.loading &&
    searchTags.length >= 2 &&
    !!activeProfile &&
    !!bin &&
    Number.isFinite(bin.millis) &&
    bin.millis > 0;

  // SAX discords alert gating. The "Create an anomaly alert" button is always
  // visible for SAX, but only enabled once a completed run actually used the
  // detection window — so the alert's semantics and threshold baseline match the
  // discords currently shown.
  const saxAlertState = useMemo(() => {
    if (isMvad) return null;
    if (!saxDetectionOn)
      return {
        enabled: false,
        hint: 'Enable the detection window to create an alert — alerts monitor the most-recent window.',
      };
    if (!saxResult)
      return { enabled: false, hint: 'Run detection first to create an alert.' };
    if (saxResult.detectionWindowBins <= 0)
      return {
        enabled: false,
        hint: 'Re-run with the detection window enabled to create an alert.',
      };
    if (!activeProfile || !bin || !Number.isFinite(bin.millis) || bin.millis <= 0)
      return {
        enabled: false,
        hint: 'Connect a Fabric connection profile to create an alert.',
      };
    return {
      enabled: true,
      hint: 'Runs this discord scan on a schedule in Fabric and emails you when a recent window is unusual.',
    };
  }, [isMvad, saxDetectionOn, saxResult, activeProfile, bin]);

  // MVAD detector parameter fields for the agent — derived from the selected
  // detector's defaults, so only its knobs are exposed.
  const mvadParamFields = useMemo(() => {
    if (!isMvad) return [];
    const algo = algorithm as MvadAlgorithm;
    const defaults = defaultMvadParams(algo);
    return (Object.keys(defaults) as (keyof MvadDetectorParams)[])
      .filter((key) => MVAD_PARAM_META[key])
      .map((key) => {
        const meta = MVAD_PARAM_META[key];
        const current = mvadParams[key] ?? defaults[key];
        if (meta.kind === 'boolean') {
          return {
            field: pf.boolean(key, meta.label, Boolean(current), { description: meta.info }),
            apply: (v: unknown) => setMvadParam(key, coerce.boolean(v)),
          };
        }
        if (meta.kind === 'enum') {
          const allowed = (meta.enumValues ?? []).map((o) => o.value);
          return {
            field: pf.enumOf(
              key,
              meta.label,
              String(current ?? ''),
              meta.enumValues ?? [],
              { description: meta.info },
            ),
            apply: (v: unknown) => setMvadParam(key, String(coerce.enumValue(v, allowed))),
          };
        }
        if (meta.kind === 'text') {
          return {
            field: pf.string(key, meta.label, String(current ?? ''), { description: meta.info }),
            apply: (v: unknown) => setMvadParam(key, coerce.string(v)),
          };
        }
        const isInt = meta.kind === 'integer';
        return {
          field: isInt
            ? pf.integer(key, meta.label, Number(current), { description: meta.info })
            : pf.number(key, meta.label, Number(current), { description: meta.info }),
          apply: (v: unknown) => setMvadParam(key, isInt ? coerce.integer(v) : coerce.number(v)),
        };
      });
  }, [isMvad, algorithm, mvadParams]);

  const saxParamFields = [
    {
      field: pf.integer('windowSize', 'Window size', params.windowSize, {
        min: 1,
        description: PARAM_INFO.windowSize,
      }),
      apply: (v: unknown) => setParam('windowSize')(coerce.integer(v, { min: 1 })),
    },
    {
      field: pf.integer('numDiscords', 'Discords per signal', params.numDiscords, {
        min: 1,
        description: PARAM_INFO.numDiscords,
      }),
      apply: (v: unknown) => setParam('numDiscords')(coerce.integer(v, { min: 1 })),
    },
    {
      field: pf.integer('paaSize', 'PAA size', params.paaSize, {
        min: 1,
        description: PARAM_INFO.paaSize,
      }),
      apply: (v: unknown) => setParam('paaSize')(coerce.integer(v, { min: 1 })),
    },
    {
      field: pf.integer('alphabetSize', 'Alphabet size', params.alphabetSize, {
        min: 2,
        description: PARAM_INFO.alphabetSize,
      }),
      apply: (v: unknown) => setParam('alphabetSize')(coerce.integer(v, { min: 2 })),
    },
    {
      field: pf.number('znormThreshold', 'Z-norm threshold', params.znormThreshold, {
        min: 0,
        description: PARAM_INFO.znormThreshold,
      }),
      apply: (v: unknown) => setParam('znormThreshold')(coerce.number(v, { min: 0 })),
    },
    {
      field: pf.integer('candidateLimit', 'Candidate limit', params.candidateLimit, {
        min: 0,
        description: PARAM_INFO.candidateLimit,
      }),
      apply: (v: unknown) => setParam('candidateLimit')(coerce.integer(v, { min: 0 })),
    },
  ];

  useControlledPage({
    pageKey: 'discover',
    title: 'Discover anomalies',
    fields: [
      tagField({
        tags,
        current: searchTags,
        set: setSearchTags,
        multi: true,
        label: 'Signals',
        description:
          'Signals to analyze. SAX discords scans each independently; MVAD detectors need 2+ signals and look at their joint behavior.',
      }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf(
          'algorithm',
          'Algorithm',
          algorithm,
          PAGE_ALGORITHMS.map((a) => ({ value: a.id, label: a.label })),
          {
            description:
              'Detection algorithm. "sax_discords" is univariate (1+ signals); the MVAD detectors are multivariate (2+ signals).',
          },
        ),
        apply: (v) =>
          selectAlgorithm(
            coerce.enumValue(
              v,
              PAGE_ALGORITHMS.map((a) => a.id),
            ) as PageAlgorithm,
          ),
      },
      ...(isMvad
        ? [
            {
              field: pf.integer('detectionBins', 'Detection window (bins)', detectionBins, {
                min: 1,
                description:
                  'How many most-recent bins the detector scores. Multiplied by the bin width to form an aligned detection window (spectral requires >= 32 bins).',
              }),
              apply: (v: unknown) => setDetectionBins(coerce.integer(v, { min: 1 })),
            },
            ...mvadParamFields,
          ]
        : saxParamFields),
    ],
    canRun,
    run: findDiscords,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  // Group discords by series so each signal renders its own annotated chart.
  const bySeries = useMemo(() => {
    const m = new Map<string, DiscordRow[]>();
    if (!saxResult) return m;
    for (const d of saxResult.discords) {
      const arr = m.get(d.seriesId) ?? [];
      arr.push(d);
      m.set(d.seriesId, arr);
    }
    return m;
  }, [saxResult]);

  // Render a chart for EVERY signal that was searched (not only those that
  // contain one of the global top-N discords), so selecting multiple signals
  // is always reflected. Signals that hold a discord come first (by their best
  // rank); the rest follow alphabetically by name.
  const signalOrder = useMemo(() => {
    if (!saxResult) return [] as string[];
    const ids = [...saxResult.series.keys()];
    const bestRank = (id: string) => {
      const ds = bySeries.get(id);
      return ds && ds.length ? Math.min(...ds.map((d) => d.rank)) : Number.POSITIVE_INFINITY;
    };
    return ids.sort((a, b) => {
      const ra = bestRank(a);
      const rb = bestRank(b);
      if (ra !== rb) return ra - rb;
      return (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b);
    });
  }, [saxResult, bySeries, nameById]);

  const windowSpan = useMemo(() => {
    if (!bin || !Number.isFinite(bin.millis) || bin.millis <= 0) return null;
    const windowSeconds = (params.windowSize * bin.millis) / 1000;
    const rangeSeconds = Math.max(0, (range.end.getTime() - range.start.getTime()) / 1000);
    const coverage = rangeSeconds > 0 ? windowSeconds / rangeSeconds : 0;
    return {
      binLabel: bin.label,
      windowLabel: formatDuration(windowSeconds),
      coverage,
    };
  }, [bin, range, params.windowSize]);

  const runLabel = isMvad ? 'Detect anomalies' : 'Find anomalies';

  return (
    <div className={styles.layout}>
      <Card className={styles.section}>
        <Subtitle1>Discover anomalies</Subtitle1>
        <Body1>
          Choose a detection algorithm, then scan the selected signals over the shared time range and
          resolution for unusual behavior.
        </Body1>
        <div className={styles.row}>
          <div className={styles.algoField}>
            <Field label={withInfo('Algorithm', 'How anomalies are detected. SAX discords scores each signal on its own; the MVAD detectors analyze how 2+ signals behave together.')}>
              <Dropdown
                value={algoInfo.label}
                selectedOptions={[algorithm]}
                onOptionSelect={(_, d) => {
                  if (d.optionValue) selectAlgorithm(d.optionValue as PageAlgorithm);
                }}
              >
                {PAGE_ALGORITHMS.map((a) => (
                  <Option key={a.id} value={a.id}>
                    {a.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>
        </div>
        <div className={styles.algoInfo}>
          <Body1>{algoInfo.blurb}</Body1>
          <Caption1>
            <b>Best for:</b> {algoInfo.bestFor}
          </Caption1>
          <Caption1 className={styles.hint}>
            <b>Not ideal for:</b> {algoInfo.notIdeal}
          </Caption1>
        </div>
        <div className={styles.row}>
          <div className={styles.tagField}>
            <TagSelect
              tags={tags}
              selected={searchTags}
              onChange={setSearchTags}
              multiselect
              info={
                isMvad
                  ? 'The signals to analyze together. Multivariate detectors need at least 2 signals.'
                  : 'The tags to scan for anomalies. Each selected signal is searched independently.'
              }
            />
          </div>
        </div>
        {isMvad && searchTags.length < 2 && (
          <MessageBar intent="warning">
            <MessageBarBody>
              Select at least 2 signals — multivariate detectors analyze how signals behave together.
              For a single signal, use SAX discords.
            </MessageBarBody>
          </MessageBar>
        )}
        <AdaptiveBinningPanel
          range={range}
          onRangeChange={setRange}
          signals={searchTags.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
          rangeInfo="The time window to scan. A wider window searches more data but takes longer."
          settings={binning.settings}
          onChange={binning.patch}
          onSaveAsDefault={binning.saveAsDefault}
          onReset={binning.resetToDefault}
          isCustom={binning.isCustom}
          hideAggregation
          disabled={state.loading}
          densityTagIds={searchTags}
          densityEnabled={!state.loading}
        />
        {isMvad ? (
          <>
            <div className={styles.row}>
              <div className={styles.detWindow}>
                <NumberField
                  label="Detection window (bins)"
                  info="How many most-recent bins the detector scores. This is multiplied by the bin width to build a detection window that is always an exact multiple of the bin, so the series never comes back misaligned."
                  value={detectionBins}
                  onChange={(n) => setDetectionBins(Math.round(n))}
                />
                <Caption1 className={styles.hint}>
                  {detectionDurationLabel
                    ? `≈ ${detectionDurationLabel} at the current resolution (${effectiveDetectionBins} × ${bin?.label ?? 'bin'}).`
                    : 'Choose a time range and resolution to see the equivalent duration.'}
                </Caption1>
                {belowMin && (
                  <Caption1 className={styles.hint}>
                    {`${algoInfo.label} needs at least ${detectionMin} bins — using ${detectionMin}.`}
                  </Caption1>
                )}
              </div>
            </div>
            <Accordion collapsible>
              <AccordionItem value="advanced">
                <AccordionHeader>Advanced parameters</AccordionHeader>
                <AccordionPanel>
                  <div className={styles.params}>
                    <NumberField
                      label="Minimum coverage"
                      info={MVAD_MIN_COVERAGE_INFO}
                      step={0.05}
                      value={minCoverage}
                      onChange={(n) => setMinCoverage(Math.min(1, Math.max(0, n)))}
                    />
                    <NumberField
                      label="Max gap (bins)"
                      info={MVAD_MAX_GAP_INFO}
                      value={maxGapBins}
                      onChange={(n) => setMaxGapBins(Math.max(0, Math.round(n)))}
                    />
                  </div>
                  <MvadParamEditor
                    algorithm={algorithm as MvadAlgorithm}
                    overrides={mvadParams}
                    onChange={setMvadParam}
                  />
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </>
        ) : (
          <>
            <div className={styles.params}>
              <NumberField label="Window size" info={PARAM_INFO.windowSize} value={params.windowSize} onChange={setParam('windowSize')} />
              <NumberField label="Discords per signal" info={PARAM_INFO.numDiscords} value={params.numDiscords} onChange={setParam('numDiscords')} />
            </div>
            <div className={styles.row}>
              <div className={styles.detWindow}>
                <Switch
                  label="Limit to a detection window"
                  checked={saxDetectionOn}
                  onChange={(_, d) => {
                    setSaxDetectionOn(d.checked);
                    if (d.checked && saxDetectionBins < params.windowSize) {
                      setSaxDetectionBins(params.windowSize);
                    }
                  }}
                />
                <Caption1 className={styles.hint}>
                  {saxDetectionOn
                    ? 'Discords are found only within the most-recent window and scored against earlier history — the recent shape an alert can monitor.'
                    : 'Off: scan the whole range for the most unusual repeated shapes (exploration). Turn on to focus on recent windows and enable alerting.'}
                </Caption1>
                {saxDetectionOn && (
                  <>
                    <NumberField
                      label="Detection window (bins)"
                      info="How many most-recent bins to search for discords. Must be at least the window size so a full pattern fits. Multiplied by the bin width to define the recent window an alert monitors."
                      value={saxDetectionBins}
                      onChange={(n) => setSaxDetectionBins(Math.max(params.windowSize, Math.round(n)))}
                    />
                    <Caption1 className={styles.hint}>
                      {saxDetectionDurationLabel
                        ? `≈ ${saxDetectionDurationLabel} at the current resolution (${saxEffectiveDetectionBins} × ${bin?.label ?? 'bin'}).`
                        : 'Choose a time range and resolution to see the equivalent duration.'}
                    </Caption1>
                  </>
                )}
              </div>
            </div>
            <Accordion collapsible>
              <AccordionItem value="advanced">
                <AccordionHeader>Advanced parameters</AccordionHeader>
                <AccordionPanel>
                  <div className={styles.params}>
                    <NumberField label="PAA size" info={PARAM_INFO.paaSize} value={params.paaSize} onChange={setParam('paaSize')} />
                    <NumberField label="Alphabet size" info={PARAM_INFO.alphabetSize} value={params.alphabetSize} onChange={setParam('alphabetSize')} />
                    <NumberField label="Z-norm threshold" info={PARAM_INFO.znormThreshold} value={params.znormThreshold} step={0.01} onChange={setParam('znormThreshold')} />
                    <NumberField label="Candidate limit" info={PARAM_INFO.candidateLimit} value={params.candidateLimit} onChange={setParam('candidateLimit')} />
                  </div>
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
            {windowSpan && (
              <Caption1 className={styles.hint}>
                {`At the current resolution (~${windowSpan.binLabel} bins), each ${params.windowSize}-point window spans about ${windowSpan.windowLabel}`}
                {windowSpan.coverage > 0
                  ? ` — roughly ${(windowSpan.coverage * 100).toFixed(windowSpan.coverage < 0.01 ? 2 : 1)}% of the selected range.`
                  : '.'}
                {' Discords are only found when the window is long enough to cover the pattern you\u2019re looking for. If you get no discords or weak matches, widen the window size or choose a coarser resolution so each window covers a meaningful slice of the signal\u2019s cycle.'}
              </Caption1>
            )}
          </>
        )}
        <div>
          <Button appearance="primary" disabled={!canRun} onClick={() => run().catch(() => {})}>
            {state.loading ? <Spinner size="tiny" /> : runLabel}
          </Button>
        </div>
      </Card>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {saxResult && saxResult.discords.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            No discords found for the selected signals and parameters.
            {windowSpan
              ? ` Each ${params.windowSize}-point window currently spans about ${windowSpan.windowLabel} — if that is short relative to the signal's cycle, every window looks alike and none stands out.`
              : ''}
            {' Try a coarser resolution (larger bins) or a larger window size so each window covers a meaningful feature, then search again.'}
          </MessageBarBody>
        </MessageBar>
      )}

      {saxResult && saxResult.discords.length > 0 && (
        <DiscordResultsTable
          discords={saxResult.discords}
          series={saxResult.series}
          nameById={nameById}
          binSeconds={saxResult.binSeconds}
          startMs={saxResult.searchStartMs}
        />
      )}

      {saxResult && (
        <MessageBar intent="info">
          <MessageBarBody>
            Discords flag the most unusual <b>shape</b> in each signal, not the single highest sample.
            Each window is z-normalized and summarized into {params.paaSize} PAA segments, so a brief spike is
            averaged over {Math.max(1, Math.round(params.windowSize / params.paaSize))} point(s) and can rank
            lower than its raw height suggests — most noticeably when the window ({params.windowSize} pts) is
            small relative to the signal's cycle. To make sharp spikes stand out, raise <b>PAA size</b> (finer
            segments) or lower <b>window size</b>.
          </MessageBarBody>
        </MessageBar>
      )}

      {annot.selecting && saxResult && (
        <MessageBar intent="info">
          <MessageBarBody>
            Drag across the chart to select a time range, or click a single point, then fill in the
            annotation details.
          </MessageBarBody>
        </MessageBar>
      )}

      {annot.error && (
        <MessageBar intent="error">
          <MessageBarBody>{annot.error}</MessageBarBody>
        </MessageBar>
      )}

      {saxResult && signalOrder.length > 0 && (
        <DiscordChartAll
          seriesById={saxResult.series}
          bySeries={bySeries}
          signalOrder={signalOrder}
          nameById={nameById}
          binSeconds={saxResult.binSeconds}
          startMs={saxResult.searchStartMs}
          rangeStartMs={range.start.getTime()}
          rangeEndMs={range.end.getTime()}
          annot={annot}
          canAnnotate={!!saxResult}
          showOnChart={showOnChart}
          onToggleShowOnChart={setShowOnChart}
        />
      )}
      {annot.dialogInitial && (
        <AnnotationDialog
          open={annot.dialogOpen}
          mode={annot.dialogMode}
          tags={tags}
          initial={annot.dialogInitial}
          onClose={annot.closeDialog}
          onSaved={annot.reload}
        />
      )}

      {mvadResult && <MvadResults result={mvadResult} nameById={nameById} />}

      {isMvad && (
        <div>
          <Button
            appearance="primary"
            disabled={!canCreateAlert}
            onClick={() => setAlertOpen(true)}
          >
            Create an anomaly alert
          </Button>
        </div>
      )}

      {!isMvad && saxAlertState && (
        <div>
          <Tooltip content={saxAlertState.hint} relationship="label">
            <Button
              appearance="primary"
              disabled={!saxAlertState.enabled}
              onClick={() => setAlertOpen(true)}
            >
              Create an anomaly alert
            </Button>
          </Tooltip>
          {!saxAlertState.enabled && (
            <Caption1 className={styles.hint} style={{ display: 'block', marginTop: 4 }}>
              {saxAlertState.hint}
            </Caption1>
          )}
        </div>
      )}

      {activeProfile &&
        !isMvad &&
        saxResult &&
        saxResult.detectionWindowBins > 0 &&
        bin && (
          <CreateSaxDiscordAlertDialog
            open={alertOpen}
            onClose={() => setAlertOpen(false)}
            tagIds={searchTags}
            detectionBins={saxResult.detectionWindowBins}
            sax={saxResult.params}
            timeseriesRef={activeProfile.timeseriesQuery}
            connectionProfileName={activeProfile.name}
            databaseName={activeProfile.databaseName}
            fabricWorkspaceId={activeProfile.fabricWorkspaceId}
            kqlDatabaseId={activeProfile.kqlDatabaseId}
            binKql={saxResult.binKql}
            binSeconds={saxResult.binSeconds}
            binLabel={saxResult.binLabel}
          />
        )}

      {activeProfile && isMvad && bin && (
        <CreateAnomalyAlertDialog
          open={alertOpen}
          onClose={() => setAlertOpen(false)}
          algorithm={algorithm as MvadAlgorithm}
          tagIds={searchTags}
          detectionBins={effectiveDetectionBins}
          params={mvadParams}
          paramLines={alertParamLines}
          timeseriesRef={activeProfile.timeseriesQuery}
          connectionProfileName={activeProfile.name}
          databaseName={activeProfile.databaseName}
          fabricWorkspaceId={activeProfile.fabricWorkspaceId}
          kqlDatabaseId={activeProfile.kqlDatabaseId}
          binKql={bin.kql}
          binSeconds={bin.millis / 1000}
          binLabel={bin.label}
        />
      )}
    </div>
  );
}

/**
 * Single multi-track chart for SAX discords across all selected signals. Each
 * signal is drawn as its own line (distinct palette color) and its discord
 * windows are shaded on that signal's own `markArea`, so the whole result set
 * fits in one chart (keeping the ranked table and the Create-alert action in
 * view). Annotation brush/markers are preserved via `mergeAnnotationMarkers`,
 * which only appends marker series and never touches the per-signal markAreas.
 */
function DiscordChartAll({
  seriesById,
  bySeries,
  signalOrder,
  nameById,
  binSeconds,
  startMs,
  rangeStartMs,
  rangeEndMs,
  annot,
  canAnnotate,
  showOnChart,
  onToggleShowOnChart,
}: {
  seriesById: Map<string, number[]>;
  bySeries: Map<string, DiscordRow[]>;
  signalOrder: string[];
  nameById: Map<string, string>;
  binSeconds: number;
  startMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  annot: UseChartAnnotationsResult;
  canAnnotate: boolean;
  showOnChart: boolean;
  onToggleShowOnChart: (v: boolean) => void;
}) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const tooltipDecimals = useTooltipDecimals();
  const tzOffset = useTimezoneOffset();

  const allDiscords = useMemo(
    () =>
      signalOrder
        .flatMap((id) => (bySeries.get(id) ?? []).map((d) => ({ id, d })))
        .sort((a, b) => a.d.rank - b.d.rank),
    [signalOrder, bySeries],
  );

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const fmt = tooltipValueFormatter(tooltipDecimals);
    const toMs = (i: number) => startMs + i * binSeconds * 1000;
    const seriesOption = signalOrder.map((id, idx) => {
      const color = PALETTE[idx % PALETTE.length];
      const vals = seriesById.get(id) ?? [];
      const areas = (bySeries.get(id) ?? []).map((d) => [
        {
          xAxis: toMs(d.startIndex),
          itemStyle: { color: 'rgba(209, 52, 56, 0.14)' },
          label: { show: true, formatter: `#${d.rank}`, position: 'insideTop', color: ANOMALY_COLOR },
        },
        { xAxis: toMs(d.endIndex) },
      ]);
      return {
        name: labeler(id, nameById.get(id)),
        type: 'line' as const,
        showSymbol: false,
        lineStyle: { width: 1.25, color },
        itemStyle: { color },
        data: vals.map((v, i) => [toMs(i), v] as [number, number]),
        markArea: { silent: true, data: areas },
      };
    });
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 16, bottom: 64 },
      legend: { type: 'scroll', bottom: 0 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmt(v) : ''),
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      dataZoom: [
        { type: 'slider', height: 18, bottom: 24 },
        { type: 'inside' },
      ],
      series: seriesOption,
    };
  }, [seriesById, bySeries, signalOrder, nameById, labeler, binSeconds, startMs, tooltipDecimals]);

  const annotatedOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(option, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: rangeStartMs,
        fullEnd: rangeEndMs,
      }),
    [option, annot.chartMarkers, annot.selecting, rangeStartMs, rangeEndMs],
  );

  const chartData = (): ChartData => {
    const toMs = (i: number) => startMs + i * binSeconds * 1000;
    const maxLen = Math.max(0, ...signalOrder.map((id) => (seriesById.get(id) ?? []).length));
    const discordByIndex = new Map<number, string[]>();
    for (const id of signalOrder) {
      const nm = labeler(id, nameById.get(id));
      for (const d of bySeries.get(id) ?? []) {
        for (let i = d.startIndex; i <= d.endIndex; i++) {
          const arr = discordByIndex.get(i) ?? [];
          arr.push(`${nm} #${d.rank} (dist ${d.nnDistance.toFixed(6)})`);
          discordByIndex.set(i, arr);
        }
      }
    }
    return {
      columns: [
        'Timestamp',
        ...signalOrder.map((id) => labeler(id, nameById.get(id))),
        'Discord(s)',
      ],
      rows: Array.from({ length: maxLen }, (_, i) => [
        formatInstantIso(toMs(i), tzOffset),
        ...signalOrder.map((id) => {
          const v = (seriesById.get(id) ?? [])[i];
          return Number.isFinite(v) ? v : null;
        }),
        (discordByIndex.get(i) ?? []).join(', ') || null,
      ]),
    };
  };

  return (
    <Card className={styles.section}>
      <div className={styles.chartHeader}>
        <Subtitle2>Anomaly chart</Subtitle2>
        {allDiscords.map(({ id, d }) => (
          <Badge key={`${id}-${d.rank}`} appearance="tint" color="danger" size="small">
            {`${labeler(id, nameById.get(id))} · #${d.rank} · dist ${d.nnDistance.toFixed(3)}`}
          </Badge>
        ))}
        <div className={styles.spacer} />
      </div>
      <OutputDescription label="Anomaly chart">
        {EXPLAINERS.discover.outputs!.discordsChart}
      </OutputDescription>
      <ChartFrame
        option={annotatedOption}
        height={320}
        fileName="discords"
        data={chartData}
        chartRef={annot.chartRef}
        onEvents={{ brushEnd: annot.onBrushEndEvent }}
        actions={
          <>
            <ToggleButton
              appearance="subtle"
              size="small"
              icon={<CommentAdd24Regular />}
              checked={annot.selecting}
              disabled={!annot.currentUserId || !canAnnotate}
              title={
                annot.currentUserId
                  ? 'Pick a time range or point on the chart to annotate'
                  : 'Sign in with Fabric to add annotations'
              }
              onClick={() =>
                annot.selecting ? annot.cancelSelecting() : annot.beginSelecting()
              }
            >
              {annot.selecting ? 'Selecting…' : 'Annotate'}
            </ToggleButton>
            <TimelineMarkersButton
              annot={annot}
              showOnChart={showOnChart}
              onToggleShowOnChart={onToggleShowOnChart}
            />
          </>
        }
      />
    </Card>
  );
}

/**
 * Ranked table of every returned discord (strongest first), with timing and
 * shape diagnostics. `Window peak` is the largest raw sample inside the discord
 * window — handy for seeing whether a sharp spike sits inside a flagged window
 * (or, when a spike is *missed*, that it fell outside the top-ranked discords).
 */
function DiscordResultsTable({
  discords,
  series,
  nameById,
  binSeconds,
  startMs,
}: {
  discords: DiscordRow[];
  series: Map<string, number[]>;
  nameById: Map<string, string>;
  binSeconds: number;
  startMs: number;
}) {
  const styles = useStyles();
  const decimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const tzOffset = useTimezoneOffset();
  const toIso = (i: number) => formatInstantIso(startMs + i * binSeconds * 1000, tzOffset);
  const fmtDuration = (bins: number) => {
    const secs = bins * binSeconds;
    if (secs < 60) return `${secs.toFixed(0)}s`;
    if (secs < 3600) return `${(secs / 60).toFixed(1)}m`;
    if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
    return `${(secs / 86400).toFixed(2)}d`;
  };
  const windowPeak = (seriesId: string, start: number, end: number): number | null => {
    const vals = series.get(seriesId);
    if (!vals) return null;
    let peak = Number.NEGATIVE_INFINITY;
    for (let i = start; i <= end && i < vals.length; i++) {
      const v = vals[i];
      if (Number.isFinite(v) && v > peak) peak = v;
    }
    return Number.isFinite(peak) ? peak : null;
  };
  const rows = [...discords].sort((a, b) => a.rank - b.rank);

  return (
    <Card className={styles.section}>
      <Subtitle2>Ranked anomalies</Subtitle2>
      <Caption1>Strongest first, by nearest-neighbor distance across all selected signals.</Caption1>
      <OutputDescription label="Ranked anomalies table">
        {EXPLAINERS.discover.outputs!.discordsTable}
      </OutputDescription>
      <div className={styles.tableScroll}>
        <Table size="small" aria-label="Ranked anomalies">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Rank</TableHeaderCell>
            <TableHeaderCell>Signal</TableHeaderCell>
            <TableHeaderCell>Start</TableHeaderCell>
            <TableHeaderCell>End</TableHeaderCell>
            <TableHeaderCell>Duration</TableHeaderCell>
            <TableHeaderCell>Distance</TableHeaderCell>
            <TableHeaderCell>Window peak</TableHeaderCell>
            <TableHeaderCell>SAX word</TableHeaderCell>
            <TableHeaderCell>Word freq.</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => {
            const peak = windowPeak(d.seriesId, d.startIndex, d.endIndex);
            return (
              <TableRow key={`${d.seriesId}-${d.rank}-${d.startIndex}`}>
                <TableCell>
                  <Badge appearance="tint" color="danger" size="small">{`#${d.rank}`}</Badge>
                </TableCell>
                <TableCell className={styles.wrapCell}>{labeler(d.seriesId, nameById.get(d.seriesId))}</TableCell>
                <TableCell>{toIso(d.startIndex)}</TableCell>
                <TableCell>{toIso(d.endIndex)}</TableCell>
                <TableCell>{fmtDuration(d.endIndex - d.startIndex + 1)}</TableCell>
                <TableCell>{d.nnDistance.toFixed(3)}</TableCell>
                <TableCell>{peak == null ? '—' : peak.toFixed(decimals)}</TableCell>
                <TableCell className={styles.wrapCell}>{d.word || '—'}</TableCell>
                <TableCell>{Number.isFinite(d.wordFrequency) ? d.wordFrequency : '—'}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        </Table>
      </div>
    </Card>
  );
}

/** A human-readable severity band from the detector's numeric severity (0–3). */
function severityLabel(sev: number): string {
  if (!Number.isFinite(sev) || sev <= 0) return 'none';
  if (sev < 1.5) return 'low';
  if (sev < 2.5) return 'moderate';
  return 'high';
}

function severityColor(sev: number): 'danger' | 'warning' | 'informative' {
  if (sev >= 2.5) return 'danger';
  if (sev >= 1.5) return 'warning';
  return 'informative';
}

/** Explain why an MVAD run produced no scored events, from a diagnostic row. */
function mvadDiagnosticMessage(row: MvadResultRow): string {
  const detail = typeof row.explain?.detail === 'string' ? row.explain.detail : '';
  const base: Record<string, string> = {
    misaligned_series:
      'The selected signals could not be placed on a shared time grid. Try a different time range or resolution so the range spans a whole number of bins, and confirm the signals overlap in time.',
    insufficient_history:
      'There is not enough history before the detection window to score it. Widen the time range, use a coarser resolution, or reduce the detection window (bins).',
    insufficient_coverage:
      'One or more signals have too many gaps to build a continuous series under the current data-quality settings. Raise “Max gap (bins)” or lower “Minimum coverage” in Advanced parameters to fill longer gaps, pick signals with denser data, widen the range, or use a coarser resolution.',
    invalid_input:
      'The detector rejected the inputs. Check that you selected at least 2 signals and that the parameters are valid.',
    work_limit_exceeded:
      'The query hit its work limit. Narrow the time range, use fewer signals, or raise “Max work rows”.',
  };
  const lead = base[row.status] ?? `The detector returned a diagnostic (“${row.status}”) instead of scores.`;
  return detail ? `${lead} (${detail})` : lead;
}

/** Warning banner shown when an MVAD run scored nothing (all diagnostic rows). */
function MvadDiagnosticsBar({ rows }: { rows: MvadResultRow[] }) {
  const diagnostics = rows.filter((r) => r.isDiagnostic);
  const seen = new Set<string>();
  const messages = diagnostics
    .map(mvadDiagnosticMessage)
    .filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  const finalMessages = messages.length
    ? messages
    : ['The detector returned no scored events for the selected signals and settings.'];
  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <b>No anomalies scored.</b>{' '}
        {finalMessages.join(' ')}
      </MessageBarBody>
    </MessageBar>
  );
}

/**
 * Line chart of every selected track over the range, with anomalous bins
 * highlighted. Used for the per-bin MVAD detectors (residual voting, random
 * projection, change-point).
 */
function MvadChart({
  result,
  scored,
  nameById,
  highlightRange,
  title,
}: {
  result: MvadDiscoverResult;
  scored: MvadResultRow[];
  nameById: Map<string, string>;
  /** Optional explicit [start,end] ms span to highlight (used by spectral). */
  highlightRange?: [number, number];
  title: string;
}) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const tooltipDecimals = useTooltipDecimals();
  const tzOffset = useTimezoneOffset();
  const trackIds = useMemo(() => [...result.series.keys()], [result.series]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const fmt = tooltipValueFormatter(tooltipDecimals);
    const toMs = (i: number) => eventIndexToMs(i, result.startMs, result.binMillis);
    const series = trackIds.map((id, idx) => ({
      name: labeler(id, nameById.get(id)),
      type: 'line' as const,
      showSymbol: false,
      lineStyle: { width: 1.25, color: PALETTE[idx % PALETTE.length] },
      itemStyle: { color: PALETTE[idx % PALETTE.length] },
      data: (result.series.get(id) ?? []).map((v, i) => [toMs(i), v] as [number, number]),
    }));
    const areas = highlightRange
      ? [[{ xAxis: highlightRange[0], itemStyle: { color: 'rgba(209, 52, 56, 0.14)' } }, { xAxis: highlightRange[1] }]]
      : scored
          .filter((r) => r.isAnomaly)
          .map((r) => {
            const t0 = toMs(r.eventIndex);
            return [
              {
                xAxis: t0,
                itemStyle: { color: 'rgba(209, 52, 56, 0.16)' },
              },
              { xAxis: t0 + result.binMillis },
            ];
          });
    if (series.length > 0) {
      (series[0] as { markArea?: unknown }).markArea = { silent: true, data: areas };
    }
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 16, bottom: 64 },
      legend: { type: 'scroll', bottom: 0 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: timeAxisPointerLabel(tooltipDecimals) },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmt(v) : ''),
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      dataZoom: [
        { type: 'slider', height: 18, bottom: 24 },
        { type: 'inside' },
      ],
      series,
    };
  }, [result, scored, trackIds, nameById, labeler, tooltipDecimals, highlightRange]);

  const chartData = (): ChartData => {
    const toMs = (i: number) => eventIndexToMs(i, result.startMs, result.binMillis);
    const maxLen = Math.max(0, ...trackIds.map((id) => (result.series.get(id) ?? []).length));
    const anomalyByIndex = new Set(scored.filter((r) => r.isAnomaly).map((r) => r.eventIndex));
    return {
      columns: ['Timestamp', ...trackIds.map((id) => labeler(id, nameById.get(id))), 'Anomaly'],
      rows: Array.from({ length: maxLen }, (_, i) => [
        formatInstantIso(toMs(i), tzOffset),
        ...trackIds.map((id) => {
          const v = (result.series.get(id) ?? [])[i];
          return Number.isFinite(v) ? v : null;
        }),
        anomalyByIndex.has(i) ? 'yes' : null,
      ]),
    };
  };

  return (
    <Card className={styles.section}>
      <div className={styles.chartHeader}>
        <Subtitle2>{title}</Subtitle2>
        <div className={styles.spacer} />
      </div>
      <ChartFrame option={option} height={280} fileName="mvad" data={chartData} />
    </Card>
  );
}

/** Ranked table of scored MVAD events (severity desc, then score desc). */
function MvadResultsTable({
  rows,
  result,
  nameById,
}: {
  rows: MvadResultRow[];
  result: MvadDiscoverResult;
  nameById: Map<string, string>;
}) {
  const styles = useStyles();
  const decimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const tzOffset = useTimezoneOffset();
  const sorted = [...rows].sort((a, b) => {
    if (b.severity !== a.severity) return b.severity - a.severity;
    return b.score - a.score;
  });
  const eventIso = (r: MvadResultRow) =>
    r.eventTime
      ? formatQueryInstantIso(r.eventTime, tzOffset)
      : formatInstantIso(eventIndexToMs(r.eventIndex, result.startMs, result.binMillis), tzOffset);
  const contributorText = (r: MvadResultRow) => {
    const shares = contributorShares(r.contributors);
    if (shares.length === 0) return '—';
    return shares
      .map((c) => `${labeler(c.trackId, nameById.get(c.trackId))} (${Math.round(c.share * 100)}%)`)
      .join(', ');
  };

  return (
    <Card className={styles.section}>
      <Subtitle2>Ranked anomalies</Subtitle2>
      <Caption1>Strongest first, by severity then score across the detection window.</Caption1>
      <div className={styles.tableScroll}>
        <Table size="small" aria-label="Ranked MVAD anomalies">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Event time</TableHeaderCell>
            <TableHeaderCell>Score</TableHeaderCell>
            <TableHeaderCell>Threshold</TableHeaderCell>
            <TableHeaderCell>Severity</TableHeaderCell>
            <TableHeaderCell>Votes</TableHeaderCell>
            <TableHeaderCell>Top signals</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((r, i) => (
            <TableRow key={`${r.eventIndex}-${i}`}>
              <TableCell>{eventIso(r)}</TableCell>
              <TableCell>{Number.isFinite(r.score) ? r.score.toFixed(decimals) : '—'}</TableCell>
              <TableCell>
                {Number.isFinite(r.threshold) ? r.threshold.toFixed(decimals) : '—'}
              </TableCell>
              <TableCell>
                <Badge appearance="tint" color={severityColor(r.severity)} size="small">
                  {severityLabel(r.severity)}
                </Badge>
              </TableCell>
              <TableCell>
                {Number.isFinite(r.voteCount) && Number.isFinite(r.trackCount)
                  ? `${r.voteCount}/${r.trackCount}`
                  : '—'}
              </TableCell>
              <TableCell className={styles.wrapCell}>{contributorText(r)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        </Table>
      </div>
    </Card>
  );
}

/** Single latest-window result card for the spectral aggregation detector. */
function MvadSpectralCard({
  row,
  result,
  nameById,
}: {
  row: MvadResultRow;
  result: MvadDiscoverResult;
  nameById: Map<string, string>;
}) {
  const styles = useStyles();
  const decimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const tzOffset = useTimezoneOffset();
  const shares = contributorShares(row.contributors);
  const windowLabel =
    row.windowStart && row.windowEnd
      ? `${formatQueryInstantIso(row.windowStart, tzOffset)} — ${formatQueryInstantIso(row.windowEnd, tzOffset)}`
      : '—';
  const highlight: [number, number] | undefined =
    row.windowStart && row.windowEnd
      ? [row.windowStart.getTime(), row.windowEnd.getTime()]
      : undefined;

  return (
    <>
      <Card className={styles.section}>
        <div className={styles.chartHeader}>
          <Subtitle2>Latest window</Subtitle2>
          <Badge appearance="filled" color={row.isAnomaly ? 'danger' : 'success'} size="small">
            {row.isAnomaly ? 'Anomaly' : 'Normal'}
          </Badge>
          <Badge appearance="tint" color={severityColor(row.severity)} size="small">
            {`severity: ${severityLabel(row.severity)}`}
          </Badge>
          <div className={styles.spacer} />
        </div>
        <Body1>
          Spectral aggregation scores only the most recent window against recent baseline windows.
        </Body1>
        <Table size="small" aria-label="Spectral latest window">
          <TableBody>
            <TableRow>
              <TableCell>Scored window</TableCell>
              <TableCell className={styles.wrapCell}>{windowLabel}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Score vs threshold</TableCell>
              <TableCell>
                {Number.isFinite(row.score) ? row.score.toFixed(decimals) : '—'} vs{' '}
                {Number.isFinite(row.threshold) ? row.threshold.toFixed(decimals) : '—'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Votes</TableCell>
              <TableCell>
                {Number.isFinite(row.voteCount) && Number.isFinite(row.trackCount)
                  ? `${row.voteCount}/${row.trackCount}`
                  : '—'}
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Contributing signals</TableCell>
              <TableCell className={styles.wrapCell}>
                {shares.length
                  ? shares
                      .map(
                        (c) =>
                          `${labeler(c.trackId, nameById.get(c.trackId))} (${Math.round(c.share * 100)}%)`,
                      )
                      .join(', ')
                  : '—'}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
      <MvadChart
        result={result}
        scored={[row]}
        nameById={nameById}
        highlightRange={highlight}
        title="Signals (scored window highlighted)"
      />
    </>
  );
}

/** Short human label for a track's make-series validation error. */
function coverageErrorLabel(err: string): string {
  const map: Record<string, string> = {
    insufficient_coverage: 'low coverage',
    max_gap_exceeded: 'gap too long',
    no_finite_observations: 'no data',
    empty_series: 'empty',
    nonfinite_after_fill: 'non-finite values',
  };
  return map[err] ?? err;
}

/**
 * One-line data-quality badge for an MVAD run: overall worst coverage and worst
 * gap across signals, plus a per-signal chip for any signal that failed the
 * current coverage/gap gate. Powered by the companion coverage query, so it shows
 * even when nothing scored (helping users see WHY, e.g. insufficient coverage).
 */
function MvadCoverageBadge({
  coverage,
  nameById,
}: {
  coverage: MvadCoverageRow[];
  nameById: Map<string, string>;
}) {
  const styles = useStyles();
  if (coverage.length === 0) return null;
  const summary = summarizeMvadCoverage(coverage);
  const hasFailures = summary.invalidTracks.length > 0;
  const covPct = (summary.minCoverage * 100).toFixed(0);
  return (
    <div className={styles.coverageBadges}>
      <Badge appearance="tint" color={hasFailures ? 'warning' : 'success'}>
        {`Coverage ${covPct}% · max gap ${summary.worstMaxGap} bin${summary.worstMaxGap === 1 ? '' : 's'} · ${summary.trackCount} signal${summary.trackCount === 1 ? '' : 's'}`}
      </Badge>
      {summary.invalidTracks.map((t) => (
        <Badge key={t.trackId} appearance="tint" color="danger">
          {`${nameById.get(t.trackId) ?? t.trackId}: ${coverageErrorLabel(t.validationError)}`}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Orchestrates MVAD result rendering: diagnostics when nothing scored, a single
 * latest-window card for spectral, or a chart + ranked table for the per-bin
 * detectors.
 */
function MvadResults({
  result,
  nameById,
}: {
  result: MvadDiscoverResult;
  nameById: Map<string, string>;
}) {
  const badge = <MvadCoverageBadge coverage={result.coverage} nameById={nameById} />;
  const scored = result.rows.filter((r) => !r.isDiagnostic);
  if (scored.length === 0) {
    return (
      <>
        {badge}
        <MvadDiagnosticsBar rows={result.rows} />
      </>
    );
  }
  if (result.algorithm === 'spectral') {
    return (
      <>
        {badge}
        {scored.map((row, i) => (
          <MvadSpectralCard key={i} row={row} result={result} nameById={nameById} />
        ))}
      </>
    );
  }
  return (
    <>
      {badge}
      <MvadResultsTable rows={scored} result={result} nameById={nameById} />
      <MvadChart
        result={result}
        scored={scored}
        nameById={nameById}
        title="Signals with anomalous bins highlighted"
      />
    </>
  );
}

interface TrainingExampleRow {
  classLabel: string;
  tagId: string[];
  range: TimeRange;
}

interface VsmParamsState {
  windowSize: number;
  paaSize: number;
  alphabetSize: number;
  znormThreshold: number;
  numerosityReduction: string;
  dropTermsInAllClasses: boolean;
  topWords: number;
}

const DEFAULT_VSM_PARAMS: VsmParamsState = {
  windowSize: 16,
  paaSize: 4,
  alphabetSize: 5,
  znormThreshold: 0.01,
  numerosityReduction: 'exact',
  dropTermsInAllClasses: true,
  topWords: 5,
};

const VSM_INFO: Record<string, string> = {
  windowSize: 'The length (in data points) of the sliding window turned into each SAX word. Larger windows capture longer shapes.',
  paaSize: 'How many segments each window is summarized into before symbolizing. Must be <= window size.',
  alphabetSize: 'How many distinct levels describe the height of each segment. Typical values are 3-6.',
  znormThreshold: 'A small floor on variation used when normalizing each window. Leave near 0.01.',
  topWords: 'How many of the most influential words to show per class when explaining a classification.',
  binSize: 'The bin width used to sample every training and input series. Use the SAME bin for training and classifying, or the words will not line up.',
};

/** SAX-VSM interpretable classification: label examples, train, save, classify. */
function VsmTab({ tags }: DiscoverPageProps) {
  const styles = useStyles();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();
  const [binSeconds, setBinSeconds] = useState(300);
  const [params, setParams] = useState<VsmParamsState>(DEFAULT_VSM_PARAMS);
  const [modelName, setModelName] = useState('');
  const [examples, setExamples] = useState<TrainingExampleRow[]>([
    { classLabel: '', tagId: [], range: defaultRange() },
  ]);
  const [models, setModels] = useState<VsmModelSummary[]>([]);
  const [modelsError, setModelsError] = useState<string | undefined>();

  // Classification inputs.
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [inputTag, setInputTag] = useState<string[]>([]);
  const [inputRange, setInputRange] = useState<TimeRange>(() => defaultRange());

  const binKql = `${binSeconds}s`;

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (inputTag.length === 0 && !selectedModel) return null;
    return {
      sections: [
        { title: 'Mode', fields: [{ label: 'Discovery mode', value: 'VSM classification' }] },
        {
          title: 'Classification',
          fields: [
            { label: 'Model', value: selectedModel || 'None' },
            { label: 'Input signal', value: tagNames(inputTag, nameById) },
            { label: 'Input window', value: fmtWindow(inputRange.start, inputRange.end) },
            { label: 'Bin size', value: `${binSeconds}s` },
          ],
        },
      ],
    };
  }, [selectedModel, inputTag, inputRange, binSeconds, nameById]);
  useRegisterCaptureContext(captureSummary);

  const refreshModels = () => {
    listVsmModels()
      .then((m) => {
        setModels(m);
        setModelsError(undefined);
      })
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(refreshModels, []);

  const [trainState, runTrain] = useAsyncAction(async (): Promise<number> => {
    const trainingExamples: VsmTrainingExample[] = examples
      .filter((e) => e.classLabel.trim() && e.tagId.length > 0)
      .map((e) => ({ classLabel: e.classLabel.trim(), tagId: e.tagId[0], start: e.range.start, end: e.range.end }));
    if (trainingExamples.length < 2) throw new Error('Add at least two labeled examples (ideally across two or more classes).');
    if (!modelName.trim()) throw new Error('Give the model a name before training.');
    const trainingTableExpr = buildVsmTrainingTableExpr(trainingExamples, binKql);
    const csl = buildVsmTrainQuery({
      windowSize: params.windowSize,
      paaSize: params.paaSize,
      alphabetSize: params.alphabetSize,
      znormThreshold: params.znormThreshold,
      numerosityReduction: params.numerosityReduction,
      dropTermsInAllClasses: params.dropTermsInAllClasses,
      trainingTableExpr,
      scope: vsmTrainingScope(trainingExamples),
    });
    const table = await executeKql(csl);
    const terms = parseVsmTerms(table);
    if (terms.length === 0) throw new Error('Training produced no terms. Try a smaller window size or more data.');
    await saveVsmModel(
      modelName.trim(),
      {
        windowSize: params.windowSize,
        paaSize: params.paaSize,
        alphabetSize: params.alphabetSize,
        znormThreshold: params.znormThreshold,
        numerosityReduction: params.numerosityReduction,
      },
      terms,
    );
    refreshModels();
    return terms.length;
  });

  const [classifyState, runClassify] = useAsyncAction(async (): Promise<VsmClassifyResult | null> => {
    const model = models.find((m) => m.id === selectedModel);
    if (!model) throw new Error('Select a saved model to classify against.');
    if (inputTag.length === 0) throw new Error('Select a signal to classify.');
    const terms = await loadVsmTerms(model.id);
    if (terms.length === 0) throw new Error('The selected model has no terms.');
    const csl = buildVsmClassifyQuery({
      terms,
      inputTagId: inputTag[0],
      start: inputRange.start,
      end: inputRange.end,
      binKql,
      windowSize: model.params.windowSize,
      paaSize: model.params.paaSize,
      alphabetSize: model.params.alphabetSize,
      znormThreshold: model.params.znormThreshold,
      numerosityReduction: model.params.numerosityReduction,
      topWords: params.topWords,
    });
    const table = await executeKql(csl);
    return parseVsmClassifyResult(table);
  });

  const setExample = (i: number, patch: Partial<TrainingExampleRow>) =>
    setExamples((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const addExample = () =>
    setExamples((prev) => [
      ...prev,
      { classLabel: '', tagId: [], range: defaultRange() },
    ]);
  const removeExample = (i: number) => setExamples((prev) => prev.filter((_, idx) => idx !== i));

  const deleteModel = (id: string) => {
    deleteVsmModel(id)
      .then(refreshModels)
      .catch((e) => setModelsError(e instanceof Error ? e.message : String(e)));
  };

  const binOptions = STANDARD_TIMESPANS.filter((t) => t.millis >= 60000 && t.millis <= 86400000);
  const classifyResult = classifyState.data;
  const classify = () => runClassify().catch(() => {});

  useControlledPage({
    pageKey: 'classifiers',
    title: 'Discover classifier',
    fields: [
      {
        field: pf.enumOf(
          'binSize',
          'Bin size (seconds)',
          binSeconds,
          binOptions.map((t) => ({ value: t.millis / 1000, label: t.label })),
          { description: VSM_INFO.binSize },
        ),
        apply: (v) =>
          setBinSeconds(
            coerce.enumValue(
              v,
              binOptions.map((t) => t.millis / 1000),
            ) as number,
          ),
      },
      {
        field: pf.integer('windowSize', 'Window size', params.windowSize, {
          min: 1,
          description: VSM_INFO.windowSize,
        }),
        apply: (v) => setParams((p) => ({ ...p, windowSize: coerce.integer(v, { min: 1 }) })),
      },
      {
        field: pf.integer('paaSize', 'PAA size', params.paaSize, {
          min: 1,
          description: VSM_INFO.paaSize,
        }),
        apply: (v) => setParams((p) => ({ ...p, paaSize: coerce.integer(v, { min: 1 }) })),
      },
      {
        field: pf.integer('alphabetSize', 'Alphabet size', params.alphabetSize, {
          min: 2,
          description: VSM_INFO.alphabetSize,
        }),
        apply: (v) => setParams((p) => ({ ...p, alphabetSize: coerce.integer(v, { min: 2 }) })),
      },
      {
        field: pf.number('znormThreshold', 'Z-norm threshold', params.znormThreshold, {
          min: 0,
          description: VSM_INFO.znormThreshold,
        }),
        apply: (v) => setParams((p) => ({ ...p, znormThreshold: coerce.number(v, { min: 0 }) })),
      },
      {
        field: pf.string('modelName', 'Model name', modelName, {
          description: 'Name used when training and saving a SAX-VSM classifier.',
        }),
        apply: (v) => setModelName(coerce.string(v)),
      },
      {
        field: pf.string('selectedModel', 'Saved model id', selectedModel, {
          description: 'Saved classifier model id to use for classification.',
          required: true,
        }),
        apply: (v) => setSelectedModel(coerce.string(v)),
      },
      tagField({
        tags,
        current: inputTag,
        set: setInputTag,
        name: 'inputTag',
        label: 'Input signal',
        description: 'Signal window to classify.',
      }),
      rangeField({
        current: inputRange,
        set: setInputRange,
        name: 'inputRange',
        label: 'Input window',
      }),
      {
        field: pf.integer('topWords', 'Top words', params.topWords, {
          min: 1,
          description: VSM_INFO.topWords,
        }),
        apply: (v) => setParams((p) => ({ ...p, topWords: coerce.integer(v, { min: 1 }) })),
      },
    ],
    canRun: !!selectedModel && inputTag.length > 0 && !classifyState.loading,
    run: classify,
    loading: classifyState.loading,
    error: classifyState.error ?? trainState.error ?? modelsError,
    hasResult: !!classifyResult || trainState.data != null,
  });

  return (
    <>
      <Card className={styles.section}>
        <Subtitle1>Train a classifier</Subtitle1>
        <Body1>
          Label a few example windows with a class, then train an interpretable SAX-VSM model. Saved models
          can classify new windows and explain which shape-words drove the decision.
        </Body1>
        <Field label={withInfo('Bin size', VSM_INFO.binSize)}>
          <Select value={String(binSeconds)} onChange={(_, d) => setBinSeconds(Number(d.value))}>
            {binOptions.map((t) => (
              <option key={t.millis} value={t.millis / 1000}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        {examples.map((ex, i) => (
          <div key={i} className={styles.exampleRow}>
            <Field label={withInfo('Class label', 'The category name for this example window (e.g. "normal" or "fault"). Windows with the same label are grouped into one class the model learns to recognize.')} className={styles.labelField}>
              <Input
                value={ex.classLabel}
                placeholder="e.g. normal / fault"
                onChange={(_, d) => setExample(i, { classLabel: d.value })}
              />
            </Field>
            <div className={styles.entityField}>
              <TagSelect tags={tags} selected={ex.tagId} onChange={(ids) => setExample(i, { tagId: ids })} />
            </div>
            <SegmentPicker
              value={ex.range}
              onChange={(range) => setExample(i, { range })}
              tagId={ex.tagId[0]}
              tagName={ex.tagId[0] ? labeler(ex.tagId[0], nameById.get(ex.tagId[0])) : undefined}
              contextRange={defaultRange()}
              info="The example window for this class. Use 'Select visually' to brush the example segment directly on the signal."
            />
            <Button
              appearance="subtle"
              icon={<Delete24Regular />}
              disabled={examples.length <= 1}
              onClick={() => removeExample(i)}
              aria-label="Remove example"
            />
          </div>
        ))}
        <div>
          <Button appearance="secondary" icon={<Add24Regular />} onClick={addExample}>
            Add example
          </Button>
        </div>

        <div className={styles.params}>
          <NumberField label="Window size" info={VSM_INFO.windowSize} value={params.windowSize} onChange={(n) => setParams((p) => ({ ...p, windowSize: n }))} />
          <NumberField label="PAA size" info={VSM_INFO.paaSize} value={params.paaSize} onChange={(n) => setParams((p) => ({ ...p, paaSize: n }))} />
          <NumberField label="Alphabet size" info={VSM_INFO.alphabetSize} value={params.alphabetSize} onChange={(n) => setParams((p) => ({ ...p, alphabetSize: n }))} />
          <NumberField label="Z-norm threshold" info={VSM_INFO.znormThreshold} value={params.znormThreshold} step={0.01} onChange={(n) => setParams((p) => ({ ...p, znormThreshold: n }))} />
        </div>

        <div className={styles.row}>
          <Field label={withInfo('Model name', 'A name to save this trained classifier under, so you can select it later to classify new windows.')} className={styles.entityField}>
            <Input value={modelName} placeholder="My classifier" onChange={(_, d) => setModelName(d.value)} />
          </Field>
          <Button appearance="primary" disabled={trainState.loading} onClick={() => runTrain().catch(() => {})}>
            {trainState.loading ? <Spinner size="tiny" /> : 'Train & save'}
          </Button>
        </div>
        {trainState.error && (
          <ErrorMessageBar error={trainState.error} />
        )}
        {trainState.data != null && !trainState.loading && !trainState.error && (
          <MessageBar intent="success">
            <MessageBarBody>{`Trained and saved "${modelName}" with ${trainState.data} terms.`}</MessageBarBody>
          </MessageBar>
        )}
      </Card>

      <Card className={styles.section}>
        <Subtitle1>Saved models</Subtitle1>
        {modelsError && (
          <ErrorMessageBar error={modelsError} />
        )}
        {models.length === 0 ? (
          <Body1>No saved models yet. Train one above.</Body1>
        ) : (
          models.map((m) => (
            <div key={m.id} className={styles.modelRow}>
              <Subtitle2>{m.name}</Subtitle2>
              <Caption1>{`window ${m.params.windowSize} · paa ${m.params.paaSize} · alphabet ${m.params.alphabetSize}`}</Caption1>
              <div className={styles.spacer} />
              <Button appearance="subtle" size="small" icon={<Delete24Regular />} onClick={() => deleteModel(m.id)}>
                Delete
              </Button>
            </div>
          ))
        )}
      </Card>

      <Card className={styles.section}>
        <Subtitle1>Classify a window</Subtitle1>
        <div className={styles.row}>
          <Field label="Model" className={styles.entityField}>
            <Dropdown
              placeholder="Select a model"
              selectedOptions={selectedModel ? [selectedModel] : []}
              value={models.find((m) => m.id === selectedModel)?.name ?? ''}
              onOptionSelect={(_, d) => setSelectedModel(d.optionValue ?? '')}
            >
              {models.map((m) => (
                <Option key={m.id} value={m.id} text={m.name}>
                  {m.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <div className={styles.entityField}>
            <TagSelect tags={tags} selected={inputTag} onChange={setInputTag} />
          </div>
          <SegmentPicker
            value={inputRange}
            onChange={setInputRange}
            tagId={inputTag[0]}
            tagName={inputTag[0] ? labeler(inputTag[0], nameById.get(inputTag[0])) : undefined}
            contextRange={defaultRange()}
            info="The window to classify. Use 'Select visually' to brush it directly on the signal."
          />
          <Button
            appearance="primary"
            disabled={!selectedModel || inputTag.length === 0 || classifyState.loading}
            onClick={() => runClassify().catch(() => {})}
          >
            {classifyState.loading ? <Spinner size="tiny" /> : 'Classify'}
          </Button>
        </div>
        {classifyState.error && (
          <ErrorMessageBar error={classifyState.error} />
        )}
        {classifyResult && (
          <>
            <OutputDescription label="Classification result">
              {EXPLAINERS.classifiers.outputs!.classifyResult}
            </OutputDescription>
            <div className={styles.matchHeader}>
              <Subtitle2>
                {classifyResult.isAmbiguous
                  ? `Ambiguous (${inputTag.length ? labeler(inputTag[0], nameById.get(inputTag[0])) : ''})`
                  : `Predicted: ${classifyResult.predictedClass}`}
              </Subtitle2>
              {!classifyResult.isAmbiguous && (
                <Badge appearance="tint" color="brand" size="small">
                  {`confidence ${classifyResult.confidence.toFixed(3)}`}
                </Badge>
              )}
            </div>
            <Table size="small" aria-label="Class scores">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Class</TableHeaderCell>
                  <TableHeaderCell>Cosine similarity</TableHeaderCell>
                  <TableHeaderCell>Top contributing words</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {classifyResult.classScores.map((c) => (
                  <TableRow key={c.classLabel}>
                    <TableCell className={styles.wrapCell}>{c.classLabel}</TableCell>
                    <TableCell>{c.cosineSimilarity.toFixed(4)}</TableCell>
                    <TableCell className={styles.wrapCell}>
                      {c.topWords
                        .map((w) => `${w.word} (${w.contribution.toFixed(2)})`)
                        .join(', ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Card>
    </>
  );
}
