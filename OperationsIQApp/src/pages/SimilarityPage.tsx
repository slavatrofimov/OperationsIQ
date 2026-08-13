import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields } from '../lib/captureContextHelpers';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Body1,
  Button,
  Caption1,
  Card,
  Field,
  Input,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  Subtitle1,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { useTerminology } from '../hooks/useTerminology';
import { usePageBinning } from '../context/BinningContext';
import {
  chooseBinFor,
  clampRangeToBinBudget,
  formatResolution,
  type BinningSettings,
} from '../lib/binningSettings';
import {
  buildMappedMultiSeriesSimilarityQuery,
  buildMappedSeriesQuery,
  buildMultiSeriesSimilarityQuery,
  buildSearchSpaceSeriesQuery,
  buildSegmentSeriesQuery,
  buildSimilarity1dQuery,
  type TagTrackMapping,
} from '../lib/kql';
import { executeKql, type KustoTable } from '../lib/eventhouse';
import { useAsyncAction } from '../hooks/useAsync';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import {
  tagField,
  rangeField,
  binningFields as controllerBinningFields,
} from '../hooks/pageControllerFields';
import { TagSelect } from '../components/TagSelect';
import { type TimeRange } from '../components/TimeRangePicker';
import { AdaptiveBinningPanel } from '../components/AdaptiveBinningPanel';
import { ChartFrame } from '../components/ChartFrame';
import { ResultsTable } from '../components/ResultsTable';
import { SimilarityComparisonChart } from '../components/SimilarityComparisonChart';
import { SimilarityTimelineChart } from '../components/SimilarityTimelineChart';
import { MultiSeriesResult } from '../components/MultiSeriesResult';
import { withInfo } from '../components/fieldInfo';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { defaultRange, seedTagIds, type SimilarityQuerySeed } from '../lib/appTypes';
import { useSharedRange, useSharedTags } from '../context/SelectionContext';
import { LAYOUT_OPTIONS, type LayoutMode, tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { toChartMs } from '../lib/timezone';
import { parseMultidimRows, type MultidimRow } from '../lib/discover';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';
import {
  CreateActivatorAlertDialog,
  type ActivatorAlertSource,
} from '../components/CreateActivatorAlertDialog';
import { useProfile } from '../context/ProfileContext';
import {
  consolidateMatches,
  filterTableToMatches,
  parseMatchRows,
  parseSeriesMap,
  parseSingleSeries,
  type MatchRow,
} from '../lib/similarityViz';
import {
  DEFAULT_SIMILARITY_PARAMS,
  computeQueryStats,
  suggestSimilarityParams,
  type SimilarityParams,
  type Suggestion,
} from '../lib/similarityHeuristics';

const useStyles = makeStyles({
  layout: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
  },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalL },
  tagField: { minWidth: '320px' },
  params: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  num: { maxWidth: '140px' },
  basicGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  autoTunedCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  autoTunedRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, max-content) 1fr',
    gap: tokens.spacingHorizontalM,
    alignItems: 'baseline',
  },
  smartList: {
    margin: 0,
    paddingInlineStart: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  mappingList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  mappingRow: {
    display: 'grid',
    gridTemplateColumns: 'minmax(160px, 1fr) auto minmax(220px, 2fr)',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  mappingQueryTag: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  mappingArrow: { color: tokens.colorNeutralForeground3 },
  vizControls: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
  },
  layoutSelect: { minWidth: '200px' },
});

/** Same shape as the shared heuristics module's params (single source of truth). */
type Params = SimilarityParams;

const DEFAULT_PARAMS: Params = DEFAULT_SIMILARITY_PARAMS;

/** The query-derived knobs that smart defaults auto-fill (and Reset restores). */
const DERIVED_KEYS: readonly (keyof Params)[] = [
  'queryLengthSymbols',
  'alphabetSize',
  'znormThreshold',
  'symbolTolerance',
];

/** Human-friendly labels for the params, reused by the smart-defaults note. */
const PARAM_LABELS: Record<keyof Params, string> = {
  queryLengthSymbols: 'Query length (symbols)',
  alphabetSize: 'Alphabet size',
  minScale: 'Min scale',
  maxScale: 'Max scale',
  scaleSteps: 'Scale steps',
  symbolTolerance: 'Symbol tolerance',
  topK: 'Top K',
  znormThreshold: 'Z-norm threshold',
  maxInterTrackDelay: 'Max inter-track delay',
  perTrackTopK: 'Per-track top K',
};

/** Compact display of a parameter value (keeps tiny z-norm floors readable). */
function fmtParamValue(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n !== 0 && Math.abs(n) < 1e-3) return n.toExponential(2);
  return String(Number(n.toPrecision(4)));
}

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

/** Everything the single-series result views need, fetched together for one search. */
interface SingleResult {
  kind: 'single';
  matches: MatchRow[];
  queryValues: number[];
  searchSeries: Map<string, number[]>;
  binSeconds: number;
  searchStartMs: number;
  raw: KustoTable;
}

/** Everything the multivariate (multi-tag) result views need for one search. */
interface MultiResult {
  kind: 'multi';
  matches: MultidimRow[];
  queryTracks: Map<string, number[]>;
  searchTracks: Map<string, number[]>;
  binSeconds: number;
  searchStartMs: number;
  /** track_id → display label. For recurrence this is the tag name; for mapped mode "Query → Search". */
  nameByTrack: Map<string, string>;
}

type SimilarityResult = SingleResult | MultiResult;

/** The query-pattern preview rendered during the review-before-search step. */
type QueryPreview =
  | { kind: 'single'; values: number[] }
  | { kind: 'multi'; tracks: Map<string, number[]> };

export interface SimilarityPageProps {
  tags: TagInfo[];
  seed: SimilarityQuerySeed | null;
}

export function SimilarityPage({ tags, seed }: SimilarityPageProps) {
  const styles = useStyles();
  const term = useTerminology();
  const tooltipDecimals = useTooltipDecimals();
  const tzOffset = useTimezoneOffset();
  const [queryTag, setQueryTag] = useSharedTags();
  const [queryRange, setQueryRange] = useState<TimeRange>(() => defaultRange());
  const [searchTags, setSearchTags] = useState<string[]>([]);
  const [searchRange, setSearchRange] = useSharedRange();
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  // Fields the user has manually edited — never clobbered by smart defaults on re-review.
  const [touchedParams, setTouchedParams] = useState<Set<keyof Params>>(() => new Set());
  // The most recent query-derived suggestion (drives the "smart defaults" note + Reset).
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [layout, setLayout] = useState<LayoutMode>('combined');
  // Multivariate sub-mode: 'recurrence' scans the same query tags for their
  // combined pattern recurring; 'mapped' pairs each query tag with an explicit
  // search-space tag so a pattern found on one asset can be located on another.
  const [multiMode, setMultiMode] = useState<'recurrence' | 'mapped'>('recurrence');
  // Explicit query-tag → search-tag mapping (used only in 'mapped' mode).
  const [tagMappings, setTagMappings] = useState<Record<string, string>>({});
  const binning = usePageBinning();
  // Keep the latest binning controller in a ref so the seed effect can read
  // settings and patch preferredMillis without listing `binning` in its deps
  // (which would re-fire — and re-clamp — on every binning change).
  const binningRef = useRef(binning);
  binningRef.current = binning;
  // Active granularity lock (Scenario 2 "Find more like these"): the pinned bin
  // width in ms, or null for a normal free-form search. When set, the search-space
  // binning control is locked so the search runs at the pattern's discovery bin.
  const [granularityLock, setGranularityLock] = useState<number | null>(null);
  // Whether the shared search range was shortened to keep the locked bin within
  // the max-points budget (drives a transparency note).
  const [lockClamped, setLockClamped] = useState(false);

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const labeler = useTagLabeler();
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const timelineAnnot = useChartAnnotations({
    tags,
    levels,
    tagIds: searchTags,
    range: searchRange,
    offsetMinutes: tzOffset,
    showMarkers: showOnChart,
  });

  // The effective resolution and aggregation are driven by the (wider) search
  // space and shared by the query pattern, guaranteeing both are compared at an
  // identical temporal resolution (requirement 5a/5b).
  const sharedBin = useMemo(
    () => chooseBinFor({ start: searchRange.start, end: searchRange.end }, binning.settings),
    [searchRange, binning.settings],
  );

  // Changing the search-space binning inputs, the search window, the searched
  // signals, or the query itself can materially change the shape of the query
  // pattern at the effective resolution. Force the user to re-review the query
  // pattern before searching again (requirement 5c).
  const [queryValidated, setQueryValidated] = useState(false);
  const queryPatternRef = useRef<HTMLDivElement>(null);
  const isMulti = queryTag.length >= 2;
  const isMapped = isMulti && multiMode === 'mapped';

  // One track per query tag, each carrying a synthetic shared track id and the
  // explicitly mapped search tag (empty until the user picks one).
  const mappingList = useMemo<TagTrackMapping[]>(
    () =>
      queryTag.map((qid, i) => ({
        trackId: `t${i}`,
        queryTagId: qid,
        searchTagId: tagMappings[qid] ?? '',
      })),
    [queryTag, tagMappings],
  );
  const mappingComplete = mappingList.length > 0 && mappingList.every((m) => m.searchTagId);

  // The tags that actually define the search space for the density/binning panel.
  const searchSpaceTagIds = useMemo(() => {
    if (!isMulti) return searchTags;
    if (multiMode === 'mapped') return mappingList.map((m) => m.searchTagId).filter(Boolean);
    return queryTag;
  }, [isMulti, multiMode, searchTags, mappingList, queryTag]);

  const [previewState, runPreview] = useAsyncAction(async (): Promise<QueryPreview> => {
    if (isMulti) {
      const table = await executeKql(
        buildSearchSpaceSeriesQuery({
          tagIds: queryTag,
          start: queryRange.start,
          end: queryRange.end,
          binKql: sharedBin.kql,
        }),
      );
      return { kind: 'multi', tracks: parseSeriesMap(table) };
    }
    const table = await executeKql(
      buildSegmentSeriesQuery({
        tagId: queryTag[0],
        start: queryRange.start,
        end: queryRange.end,
        binKql: sharedBin.kql,
      }),
    );
    return { kind: 'single', values: parseSingleSeries(table) };
  });

  const reviewQuery = () => {
    runPreview()
      .then((preview) => {
        // Derive smart defaults from the reviewed pattern and auto-fill any knob
        // the user has NOT manually edited. Manual edits stay untouched.
        const stats =
          preview.kind === 'single'
            ? computeQueryStats(preview.values)
            : [...preview.tracks.values()].map((vals) => computeQueryStats(vals));
        const next = suggestSimilarityParams({
          mode: preview.kind === 'single' ? 'single' : 'multi',
          stats,
          minScale: params.minScale,
        });
        setSuggestion(next);
        setParams((prev) => {
          const merged = { ...prev };
          for (const key of DERIVED_KEYS) {
            if (!touchedParams.has(key)) merged[key] = next.params[key];
          }
          return merged;
        });
        setQueryValidated(true);
      })
      .catch(() => {});
  };

  const reviewAndReveal = () => {
    queryPatternRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    reviewQuery();
  };

  /** Re-apply the suggested values for every query-derived knob, clearing their touched flag. */
  const resetToSuggested = () => {
    if (!suggestion) return;
    const s = suggestion;
    setParams((prev) => {
      const merged = { ...prev };
      for (const key of DERIVED_KEYS) merged[key] = s.params[key];
      return merged;
    });
    setTouchedParams((prev) => {
      const nextTouched = new Set(prev);
      for (const key of DERIVED_KEYS) nextTouched.delete(key);
      return nextTouched;
    });
  };

  // Invalidate a prior review whenever anything that could change the query
  // pattern's rendered shape changes.
  useEffect(() => {
    setQueryValidated(false);
  }, [queryTag, queryRange, searchRange, searchTags, multiMode, tagMappings, binning.settings]);

  // Apply a query pattern handed over from another page. Two shapes:
  //  • Exploration brush (free-form): a single tag + window; binning stays under
  //    user control and is driven by the search space, exactly as before.
  //  • Discovered deep-pattern ("Find more like these", Scenario 2): every
  //    participating track's tag + the pattern window, plus a granularity LOCK —
  //    the search runs at the exact bin the pattern was discovered at. To keep the
  //    query performant we pin `preferredMillis` and, if the (shared) search range
  //    would exceed the max-points budget at that bin, clamp it.
  useEffect(() => {
    if (!seed) return;
    const ids = seedTagIds(seed);
    setQueryTag(ids);
    setQueryRange({ start: seed.start, end: seed.end });
    setSearchTags((prev) => (prev.length ? prev : ids));

    if (seed.locked && seed.lockedBinMillis && seed.lockedBinMillis > 0) {
      const lockMs = seed.lockedBinMillis;
      setGranularityLock(lockMs);
      binningRef.current.patch({ preferredMillis: lockMs });
      const clamp = clampRangeToBinBudget(searchRange, lockMs, binningRef.current.settings.maxBins);
      setLockClamped(clamp.clamped);
      if (clamp.clamped) setSearchRange({ start: clamp.start, end: clamp.end });
    } else {
      setGranularityLock(null);
      setLockClamped(false);
    }
  }, [seed]);

  const [state, run] = useAsyncAction(async (): Promise<SimilarityResult> => {
    const settings: BinningSettings = binning.settings;
    const bin = chooseBinFor({ start: searchRange.start, end: searchRange.end }, settings);

    // Two or more query tags → multivariate search. Two sub-modes:
    //  • recurrence: scan the SAME query tags over the search window for where
    //    their combined shape recurs.
    //  • mapped: pair each query tag with an explicit search-space tag so a shape
    //    found on one asset can be located on another.
    // A single tag keeps the classic 1-D shape search.
    if (queryTag.length >= 2 && multiMode === 'mapped') {
      const mappings = mappingList;
      const searchCsl = buildMappedMultiSeriesSimilarityQuery({
        mappings,
        queryStart: queryRange.start,
        queryEnd: queryRange.end,
        searchStart: searchRange.start,
        searchEnd: searchRange.end,
        binKql: bin.kql,
        ...params,
      });
      const queryCsl = buildMappedSeriesQuery({
        pairs: mappings.map((m) => ({ tagId: m.queryTagId, trackId: m.trackId })),
        start: queryRange.start,
        end: queryRange.end,
        binKql: bin.kql,
      });
      const searchSeriesCsl = buildMappedSeriesQuery({
        pairs: mappings.map((m) => ({ tagId: m.searchTagId, trackId: m.trackId })),
        start: searchRange.start,
        end: searchRange.end,
        binKql: bin.kql,
      });

      const [matchesTable, queryTable, searchTable] = await Promise.all([
        executeKql(searchCsl),
        executeKql(queryCsl),
        executeKql(searchSeriesCsl),
      ]);

      const nameByTrack = new Map(
        mappings.map((m) => [
          m.trackId,
          `${labeler(m.queryTagId, nameById.get(m.queryTagId))} \u2192 ${
            labeler(m.searchTagId, nameById.get(m.searchTagId))
          }`,
        ]),
      );

      return {
        kind: 'multi',
        matches: parseMultidimRows(matchesTable),
        queryTracks: parseSeriesMap(queryTable),
        searchTracks: parseSeriesMap(searchTable),
        binSeconds: (bin.millis / 1000),
        searchStartMs: toChartMs(searchRange.start.getTime(), tzOffset),
        nameByTrack,
      };
    }

    if (queryTag.length >= 2) {
      const searchCsl = buildMultiSeriesSimilarityQuery({
        queryTagIds: queryTag,
        queryStart: queryRange.start,
        queryEnd: queryRange.end,
        searchStart: searchRange.start,
        searchEnd: searchRange.end,
        binKql: bin.kql,
        ...params,
      });
      const queryCsl = buildSearchSpaceSeriesQuery({
        tagIds: queryTag,
        start: queryRange.start,
        end: queryRange.end,
        binKql: bin.kql,
      });
      const searchSeriesCsl = buildSearchSpaceSeriesQuery({
        tagIds: queryTag,
        start: searchRange.start,
        end: searchRange.end,
        binKql: bin.kql,
      });

      const [matchesTable, queryTable, searchTable] = await Promise.all([
        executeKql(searchCsl),
        executeKql(queryCsl),
        executeKql(searchSeriesCsl),
      ]);

      // Recurrence mode: track_id == tag id, so the tag-name map keys directly.
      const nameByTrack = new Map(queryTag.map((id) => [id, labeler(id, nameById.get(id))]));

      return {
        kind: 'multi',
        matches: parseMultidimRows(matchesTable),
        queryTracks: parseSeriesMap(queryTable),
        searchTracks: parseSeriesMap(searchTable),
        binSeconds: (bin.millis / 1000),
        searchStartMs: toChartMs(searchRange.start.getTime(), tzOffset),
        nameByTrack,
      };
    }

    const searchCsl = buildSimilarity1dQuery({
      queryTagId: queryTag[0],
      queryStart: queryRange.start,
      queryEnd: queryRange.end,
      searchTagIds: searchTags,
      searchStart: searchRange.start,
      searchEnd: searchRange.end,
      binKql: bin.kql,
      ...params,
    });
    const queryCsl = buildSegmentSeriesQuery({
      tagId: queryTag[0],
      start: queryRange.start,
      end: queryRange.end,
      binKql: bin.kql,
    });
    const spaceCsl = buildSearchSpaceSeriesQuery({
      tagIds: searchTags,
      start: searchRange.start,
      end: searchRange.end,
      binKql: bin.kql,
    });

    const [matchesTable, queryTable, spaceTable] = await Promise.all([
      executeKql(searchCsl),
      executeKql(queryCsl),
      executeKql(spaceCsl),
    ]);

    // Collapse consecutive / overlapping near-duplicate hits into one best-
    // scoring match per cluster, and keep the details table in sync with it.
    const matches = consolidateMatches(parseMatchRows(matchesTable));

    return {
      kind: 'single',
      matches,
      queryValues: parseSingleSeries(queryTable),
      searchSeries: parseSeriesMap(spaceTable),
      binSeconds: (bin.millis / 1000),
      searchStartMs: toChartMs(searchRange.start.getTime(), tzOffset),
      raw: filterTableToMatches(matchesTable, matches),
    };
  });

  const markTouched = (key: keyof Params) =>
    setTouchedParams((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));

  const setParam = (key: keyof Params) => (n: number) => {
    markTouched(key);
    setParams((p) => ({ ...p, [key]: n }));
  };

  const canRun =
    queryTag.length > 0 &&
    (isMulti ? (isMapped ? mappingComplete : true) : searchTags.length > 0) &&
    queryValidated &&
    !state.loading;

  // Readiness excluding the review gate: used by the progressive bottom button so
  // it can offer "Review query pattern" instead of being silently disabled.
  const readyExceptReview =
    queryTag.length > 0 &&
    (isMulti ? (isMapped ? mappingComplete : true) : searchTags.length > 0) &&
    !state.loading &&
    !previewState.loading;

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (queryTag.length === 0) return null;
    const mode = !isMulti
      ? 'Single-series'
      : multiMode === 'mapped'
        ? 'Multivariate (explicit tag mapping)'
        : 'Multivariate (recurrence)';
    const searchSignals = isMapped
      ? mappingList
          .map(
            (m) =>
              `${nameById.get(m.queryTagId) ?? m.queryTagId} \u2192 ${
                m.searchTagId ? nameById.get(m.searchTagId) ?? m.searchTagId : '(unmapped)'
              }`,
          )
          .join(', ')
      : tagNames(isMulti ? queryTag : searchTags, nameById);
    return {
      sections: [
        {
          title: 'Tags',
          fields: [
            { label: 'Search mode', value: mode },
            { label: 'Query signal(s)', value: tagNames(queryTag, nameById) },
            { label: isMapped ? 'Tag mapping' : 'Search signal(s)', value: searchSignals },
          ],
        },
        {
          title: 'Time ranges',
          fields: [
            { label: 'Query window', value: fmtWindow(queryRange.start, queryRange.end) },
            { label: 'Search window', value: fmtWindow(searchRange.start, searchRange.end) },
          ],
        },
        {
          title: 'Search parameters',
          fields: [
            { label: 'Query length (symbols)', value: String(params.queryLengthSymbols) },
            { label: 'Alphabet size', value: String(params.alphabetSize) },
            { label: 'Min scale', value: String(params.minScale) },
            { label: 'Max scale', value: String(params.maxScale) },
            { label: 'Scale steps', value: String(params.scaleSteps) },
            { label: 'Symbol tolerance', value: String(params.symbolTolerance) },
            { label: 'Top K', value: String(params.topK) },
            { label: 'Z-norm threshold', value: String(params.znormThreshold) },
            { label: 'Max inter-track delay', value: String(params.maxInterTrackDelay) },
            { label: 'Per-track top K', value: String(params.perTrackTopK) },
          ],
        },
        {
          title: 'Display',
          fields: [{ label: 'Chart layout', value: layout }, ...binningFields(binning.settings)],
        },
      ],
    };
  }, [
    queryTag,
    searchTags,
    nameById,
    queryRange,
    searchRange,
    params,
    layout,
    binning.settings,
    isMulti,
    isMapped,
    multiMode,
    mappingList,
  ]);
  useRegisterCaptureContext(captureSummary);
  const hideColumns = useMemo(
    () =>
      state.data?.kind === 'single'
        ? state.data.raw.columns.filter((c) => c.type === 'dynamic').map((c) => c.name)
        : [],
    [state.data],
  );

  const result = state.data;
  const hasMatches = !!result && result.matches.length > 0;

  const { activeProfile } = useProfile();
  const [alertOpen, setAlertOpen] = useState(false);

  // Shape the completed search into the input the Create-Alert dialog inlines
  // into a self-contained Activator KQL query. Available after any successful
  // search (even with zero matches — the schedule may catch future matches).
  const alertSource = useMemo<ActivatorAlertSource | null>(() => {
    if (!result) return null;
    if (result.kind === 'single') {
      if (!result.queryValues.length || searchTags.length === 0) return null;
      return {
        mode: 'single',
        queryValues: result.queryValues,
        searchTags,
        queryTags: queryTag,
      };
    }
    const tracks = isMapped
      ? mappingList
          .map((m) => ({
            trackId: m.trackId,
            searchTagId: m.searchTagId,
            values: result.queryTracks.get(m.trackId) ?? [],
          }))
          .filter((t) => t.searchTagId && t.values.length)
      : queryTag
          .map((id) => ({
            trackId: id,
            searchTagId: id,
            values: result.queryTracks.get(id) ?? [],
          }))
          .filter((t) => t.values.length);
    if (tracks.length === 0) return null;
    return { mode: 'multidim', tracks, queryTags: queryTag };
  }, [result, searchTags, queryTag, isMapped, mappingList]);

  const canCreateAlert = !!result && !!alertSource && !!activeProfile;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'similarity',
    title: 'Similarity search',
    fields: [
      tagField({
        name: 'queryTags',
        label: 'Query tags',
        tags,
        current: queryTag,
        set: setQueryTag,
        multi: true,
        description: 'One or more signals that define the query pattern.',
      }),
      rangeField({
        name: 'queryRange',
        label: 'Query range',
        current: queryRange,
        set: setQueryRange,
        description: 'Window containing the pattern to search for.',
      }),
      tagField({
        name: 'searchTags',
        label: 'Search tags',
        tags,
        current: searchTags,
        set: setSearchTags,
        multi: true,
        required: false,
        description: 'Signals to scan in single-series mode.',
      }),
      tagField({
        name: 'mappedSearchTags',
        label: 'Mapped search tags',
        tags,
        current: mappingList.map((m) => m.searchTagId).filter(Boolean),
        set: (ids) =>
          setTagMappings((prev) => {
            const next = { ...prev };
            queryTag.forEach((qid, i) => {
              if (ids[i]) next[qid] = ids[i];
              else delete next[qid];
            });
            return next;
          }),
        multi: true,
        required: false,
        description: 'Search-space tags paired by position with queryTags in mapped multivariate mode.',
      }),
      rangeField({
        name: 'searchRange',
        label: 'Search range',
        current: searchRange,
        set: setSearchRange,
        description: 'Window to scan for similar patterns.',
      }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf('multiMode', 'Multivariate search mode', multiMode, [
          { value: 'recurrence', label: 'Recurrence (same tags)' },
          { value: 'mapped', label: 'Explicit tag mapping' },
        ]),
        apply: (v) =>
          setMultiMode(coerce.enumValue(v, ['recurrence', 'mapped']) as 'recurrence' | 'mapped'),
      },
      {
        field: pf.integer('queryLengthSymbols', 'Query length (symbols)', params.queryLengthSymbols),
        apply: (v) => {
          markTouched('queryLengthSymbols');
          setParams((p) => ({ ...p, queryLengthSymbols: coerce.integer(v) }));
        },
      },
      {
        field: pf.integer('alphabetSize', 'Alphabet size', params.alphabetSize),
        apply: (v) => {
          markTouched('alphabetSize');
          setParams((p) => ({ ...p, alphabetSize: coerce.integer(v) }));
        },
      },
      {
        field: pf.number('minScale', 'Min scale', params.minScale),
        apply: (v) => setParams((p) => ({ ...p, minScale: coerce.number(v) })),
      },
      {
        field: pf.number('maxScale', 'Max scale', params.maxScale),
        apply: (v) => setParams((p) => ({ ...p, maxScale: coerce.number(v) })),
      },
      {
        field: pf.integer('scaleSteps', 'Scale steps', params.scaleSteps),
        apply: (v) => setParams((p) => ({ ...p, scaleSteps: coerce.integer(v) })),
      },
      {
        field: pf.integer('symbolTolerance', 'Symbol tolerance', params.symbolTolerance),
        apply: (v) => {
          markTouched('symbolTolerance');
          setParams((p) => ({ ...p, symbolTolerance: coerce.integer(v) }));
        },
      },
      {
        field: pf.integer('topK', 'Top K', params.topK),
        apply: (v) => setParams((p) => ({ ...p, topK: coerce.integer(v) })),
      },
      {
        field: pf.number('znormThreshold', 'Z-norm threshold', params.znormThreshold),
        apply: (v) => {
          markTouched('znormThreshold');
          setParams((p) => ({ ...p, znormThreshold: coerce.number(v) }));
        },
      },
      {
        field: pf.integer('maxInterTrackDelay', 'Max inter-track delay', params.maxInterTrackDelay),
        apply: (v) => setParams((p) => ({ ...p, maxInterTrackDelay: coerce.integer(v) })),
      },
      {
        field: pf.integer('perTrackTopK', 'Per-track Top K', params.perTrackTopK),
        apply: (v) => setParams((p) => ({ ...p, perTrackTopK: coerce.integer(v) })),
      },
      {
        field: pf.enumOf(
          'layout',
          'Chart layout',
          layout,
          LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ),
        apply: (v) => setLayout(coerce.enumValue(v, LAYOUT_OPTIONS.map((o) => o.value)) as LayoutMode),
      },
    ],
    canRun,
    run: () => {
      void run();
    },
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  const previewOption = useMemo(() => {
    const p = previewState.data;
    if (!p) return null;
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const series =
      p.kind === 'single'
        ? [{ type: 'line', showSymbol: false, data: p.values }]
        : [...p.tracks.entries()].map(([id, vals]) => ({
            type: 'line',
            name: labeler(id, nameById.get(id)),
            showSymbol: false,
            data: vals,
          }));
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 32 },
      xAxis: { type: 'category', show: false },
      yAxis: { type: 'value', scale: true },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      ...(p.kind === 'multi' ? { legend: { top: 0 } } : {}),
      series,
    };
  }, [previewState.data, nameById, labeler, tooltipDecimals]);

  const previewChartData = (): { columns: string[]; rows: (string | number | null)[][] } => {
    const p = previewState.data;
    if (!p) return { columns: [], rows: [] };
    if (p.kind === 'single') {
      return {
        columns: ['Index', 'Value'],
        rows: p.values.map((v, i) => [i, v] as [number, number]),
      };
    }
    const entries = [...p.tracks.entries()];
    const len = Math.max(0, ...entries.map(([, vals]) => vals.length));
    const columns = ['Index', ...entries.map(([id]) => labeler(id, nameById.get(id)))];
    const rows: (string | number | null)[][] = [];
    for (let i = 0; i < len; i++) {
      rows.push([i, ...entries.map(([, vals]) => vals[i] ?? null)]);
    }
    return { columns, rows };
  };

  return (
    <div className={styles.layout}>
      <PageIntro
        title="Similarity search"
        overview={EXPLAINERS.similarity.overview}
        interpretation={EXPLAINERS.similarity.interpretation}
        technical={EXPLAINERS.similarity.technical}
      />

      <Card className={styles.section} ref={queryPatternRef}>
        <Subtitle1>Query pattern</Subtitle1>
        <div className={styles.row}>
          <div className={styles.tagField}>
            <TagSelect
              label={`Query ${term.metricIdLabel.toLowerCase()}(s)`}
              tags={tags}
              selected={queryTag}
              onChange={setQueryTag}
              multiselect
              info={EXPLAINERS.similarity.inputs!.queryTags}
            />
          </div>
        </div>
        {isMulti && (
          <Body1>
            {multiMode === 'mapped'
              ? `Multivariate mode: the combined shape of ${queryTag.length} query tags is searched against the search-space tags you map each one to.`
              : `Multivariate mode: searching for the combined shape of ${queryTag.length} tags recurring together over the search window.`}
          </Body1>
        )}
        <AdaptiveBinningPanel
          range={queryRange}
          onRangeChange={setQueryRange}
          signals={queryTag.map((id) => ({ tagId: id, name: nameById.get(id) ?? id }))}
          contextRange={searchRange}
          rangeInfo={EXPLAINERS.similarity.inputs!.queryWindow}
          settings={binning.settings}
          showInputs={false}
          effectiveMillisOverride={sharedBin.millis}
          disabled={state.loading}
        />
        {queryTag.length > 0 && !queryValidated && (
          <MessageBar intent="warning">
            <MessageBarBody>
              The effective resolution ({formatResolution(sharedBin.millis)}/bin) and aggregation are
              driven by the search space. Review the query pattern at this resolution before
              searching — a wide search window or a different aggregation can materially change its
              shape.
            </MessageBarBody>
            <MessageBarActions>
              <Button
                appearance="primary"
                size="small"
                disabled={queryTag.length === 0 || previewState.loading}
                onClick={reviewQuery}
              >
                {previewState.loading ? <Spinner size="tiny" /> : 'Review query pattern'}
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
        {previewState.error && (
          <ErrorMessageBar error={previewState.error} />
        )}
        {previewOption && (
          <div>
            <Caption1>
              Query pattern at {formatResolution(sharedBin.millis)}/bin ({sharedBin.label})
              {queryValidated ? ' — reviewed' : ''}
            </Caption1>
            <ChartFrame
              option={previewOption}
              height={220}
              fileName="query_pattern"
              data={previewChartData}
              allowScaleToggle={false}
            />
          </div>
        )}
      </Card>

      <Card className={styles.section}>
        <Subtitle1>Search space</Subtitle1>
        {granularityLock != null && (
          <MessageBar intent="info">
            <MessageBarBody>
              Granularity is locked to match the discovered pattern (
              {formatResolution(granularityLock)}/bin). The search runs at this exact resolution.
              {lockClamped
                ? ' The search window was shortened to keep the result within the max-points budget.'
                : ''}
            </MessageBarBody>
            <MessageBarActions>
              <Link
                onClick={() => {
                  setGranularityLock(null);
                  setLockClamped(false);
                }}
              >
                Unlock
              </Link>
            </MessageBarActions>
          </MessageBar>
        )}
        {isMulti && (
          <Field
            label={withInfo(
              'Multivariate search mode',
              EXPLAINERS.similarity.inputs!.multivariateMode,
            )}
          >
            <RadioGroup
              layout="horizontal"
              value={multiMode}
              onChange={(_, d) => setMultiMode(d.value as 'recurrence' | 'mapped')}
              disabled={state.loading}
            >
              <Radio value="recurrence" label="Recurrence (same tags)" />
              <Radio value="mapped" label="Explicit tag mapping" />
            </RadioGroup>
          </Field>
        )}
        {!isMulti && (
          <div className={styles.row}>
            <div className={styles.tagField}>
              <TagSelect
                label={`Search ${term.metricIdLabelPlural.toLowerCase()}`}
                tags={tags}
                selected={searchTags}
                onChange={setSearchTags}
                multiselect
                info={EXPLAINERS.similarity.inputs!.searchTags}
              />
            </div>
          </div>
        )}
        {isMulti && multiMode === 'recurrence' && (
          <Body1>
            The query tags themselves are scanned over the search window for where their combined
            pattern recurs.
          </Body1>
        )}
        {isMapped && (
          <Field
            label={withInfo(
              'Map each query tag to the search-space tag to compare it against',
              EXPLAINERS.similarity.inputs!.tagMapping,
            )}
          >
            <div className={styles.mappingList}>
              {mappingList.map((m) => (
                <div key={m.queryTagId} className={styles.mappingRow}>
                  <div className={styles.mappingQueryTag}>
                    <Body1>{labeler(m.queryTagId, nameById.get(m.queryTagId))}</Body1>
                    <Caption1>Query tag</Caption1>
                  </div>
                  <span className={styles.mappingArrow}>{'\u2192'}</span>
                  <TagSelect
                    label={`Search ${term.metricIdLabel.toLowerCase()}`}
                    tags={tags}
                    selected={m.searchTagId ? [m.searchTagId] : []}
                    onChange={(ids) =>
                      setTagMappings((prev) => {
                        const next = { ...prev };
                        if (ids.length) next[m.queryTagId] = ids[ids.length - 1];
                        else delete next[m.queryTagId];
                        return next;
                      })
                    }
                    disabled={state.loading}
                  />
                </div>
              ))}
            </div>
          </Field>
        )}
        <AdaptiveBinningPanel
          range={searchRange}
          onRangeChange={setSearchRange}
          signals={searchSpaceTagIds.map((id) => ({
            tagId: id,
            name: labeler(id, nameById.get(id)),
          }))}
          rangeInfo={EXPLAINERS.similarity.inputs!.searchWindow}
          settings={binning.settings}
          onChange={binning.patch}
          onSaveAsDefault={binning.saveAsDefault}
          onReset={binning.resetToDefault}
          isCustom={binning.isCustom}
          hideAggregation
          disabled={state.loading}
          lockBinningInputs={granularityLock != null}
          densityTagIds={searchSpaceTagIds}
          densityEnabled={!state.loading}
        />
        {granularityLock != null && sharedBin.millis !== granularityLock && (
          <MessageBar intent="warning">
            <MessageBarBody>
              The search window is too wide to hold the locked granularity (
              {formatResolution(granularityLock)}/bin) within the max-points budget, so it would run
              at {formatResolution(sharedBin.millis)}/bin. Shorten the search window to restore the
              locked resolution.
            </MessageBarBody>
            <MessageBarActions>
              <Link
                onClick={() => {
                  const clamp = clampRangeToBinBudget(
                    searchRange,
                    granularityLock,
                    binning.settings.maxBins,
                  );
                  if (clamp.clamped) setSearchRange({ start: clamp.start, end: clamp.end });
                }}
              >
                Shorten to fit
              </Link>
            </MessageBarActions>
          </MessageBar>
        )}
      </Card>

      <Card className={styles.section}>
        <Subtitle1>Parameters</Subtitle1>

        {queryValidated && suggestion && (
          <MessageBar intent="success">
            <MessageBarBody>
              <Body1 block>Smart defaults applied from your reviewed pattern:</Body1>
              <ul className={styles.smartList}>
                {DERIVED_KEYS.filter((k) => suggestion.rationale[k]).map((k) => (
                  <li key={k}>
                    <Caption1>
                      <strong>{PARAM_LABELS[k]}:</strong> {suggestion.rationale[k]}
                      {touchedParams.has(k) ? ' (you edited this — kept as-is)' : ''}
                    </Caption1>
                  </li>
                ))}
              </ul>
            </MessageBarBody>
            <MessageBarActions>
              <Button size="small" onClick={resetToSuggested}>
                Reset to suggested
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}

        {/* Basic — the few knobs most analysts touch, plus a read-only auto-tuned summary. */}
        <div className={styles.basicGroup}>
          <div className={styles.params}>
            <NumberField
              label="Top K (matches to return)"
              info={EXPLAINERS.similarity.inputs!.topK}
              value={params.topK}
              onChange={setParam('topK')}
            />
          </div>
          <Field label={withInfo('Duration flexibility', EXPLAINERS.similarity.inputs!.minScale)}>
            <Body1>
              Looking for this shape between {params.minScale}× and {params.maxScale}× its reviewed
              duration, across {params.scaleSteps} step{params.scaleSteps === 1 ? '' : 's'}. Widen
              this under Advanced to catch faster or slower versions of the pattern.
            </Body1>
          </Field>
          <div className={styles.autoTunedCard}>
            <Caption1>
              Auto-tuned from your pattern{queryValidated ? '' : ' (defaults until you review a query)'} — adjust any of
              these under Advanced.
            </Caption1>
            <div className={styles.autoTunedRow}>
              <Caption1>Query length</Caption1>
              <Caption1>{params.queryLengthSymbols} symbols</Caption1>
            </div>
            <div className={styles.autoTunedRow}>
              <Caption1>Alphabet size</Caption1>
              <Caption1>{params.alphabetSize} levels</Caption1>
            </div>
            <div className={styles.autoTunedRow}>
              <Caption1>Z-norm floor</Caption1>
              <Caption1>{fmtParamValue(params.znormThreshold)} (data units)</Caption1>
            </div>
            <div className={styles.autoTunedRow}>
              <Caption1>Matcher</Caption1>
              <Caption1>
                {params.symbolTolerance <= 0
                  ? 'Exact (fast)'
                  : `Symbolic (tolerance ${params.symbolTolerance})`}
              </Caption1>
            </div>
          </div>
        </div>

        {/* Advanced — every raw knob, pre-filled and overridable. */}
        <Accordion collapsible>
          <AccordionItem value="advanced">
            <AccordionHeader>Advanced parameters</AccordionHeader>
            <AccordionPanel>
              <div className={styles.params}>
                <NumberField
                  label="Query length (symbols)"
                  info={EXPLAINERS.similarity.inputs!.queryLengthSymbols}
                  value={params.queryLengthSymbols}
                  onChange={setParam('queryLengthSymbols')}
                />
                <NumberField
                  label="Alphabet size"
                  info={EXPLAINERS.similarity.inputs!.alphabetSize}
                  value={params.alphabetSize}
                  onChange={setParam('alphabetSize')}
                />
                <NumberField
                  label="Min scale"
                  info={EXPLAINERS.similarity.inputs!.minScale}
                  value={params.minScale}
                  step={0.05}
                  onChange={setParam('minScale')}
                />
                <NumberField
                  label="Max scale"
                  info={EXPLAINERS.similarity.inputs!.maxScale}
                  value={params.maxScale}
                  step={0.05}
                  onChange={setParam('maxScale')}
                />
                <NumberField
                  label="Scale steps"
                  info={EXPLAINERS.similarity.inputs!.scaleSteps}
                  value={params.scaleSteps}
                  onChange={setParam('scaleSteps')}
                />
                <NumberField
                  label="Symbol tolerance"
                  info={EXPLAINERS.similarity.inputs!.symbolTolerance}
                  value={params.symbolTolerance}
                  onChange={setParam('symbolTolerance')}
                />
                <NumberField
                  label="Z-norm threshold"
                  info={EXPLAINERS.similarity.inputs!.znormThreshold}
                  value={params.znormThreshold}
                  step={0.01}
                  onChange={setParam('znormThreshold')}
                />
                {isMulti && (
                  <>
                    <NumberField
                      label="Max inter-track delay"
                      info={EXPLAINERS.similarity.inputs!.maxInterTrackDelay}
                      value={params.maxInterTrackDelay}
                      onChange={setParam('maxInterTrackDelay')}
                    />
                    <NumberField
                      label="Per-track top K"
                      info={EXPLAINERS.similarity.inputs!.perTrackTopK}
                      value={params.perTrackTopK}
                      onChange={setParam('perTrackTopK')}
                    />
                  </>
                )}
              </div>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>

        <div className={styles.row} style={{ alignItems: 'center' }}>
          {queryValidated ? (
            <Button appearance="primary" disabled={!canRun} onClick={() => run()}>
              {state.loading ? <Spinner size="tiny" /> : 'Search'}
            </Button>
          ) : (
            <Button
              appearance="primary"
              disabled={!readyExceptReview}
              onClick={reviewAndReveal}
            >
              {previewState.loading ? <Spinner size="tiny" /> : 'Review query pattern'}
            </Button>
          )}
          {queryTag.length > 0 && !queryValidated && (
            <Caption1 style={{ color: tokens.colorPaletteYellowForeground1 }}>
              Step 1 of 2 — review your pattern at the search resolution first; a wide window or
              different aggregation can change its shape. This button reviews it, then becomes
              Search.
            </Caption1>
          )}
        </div>
      </Card>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && !state.loading && (
        <Card className={styles.section}>
          <div className={styles.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Subtitle1>Create an Activator alert</Subtitle1>
              <Body1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                Re-run this search on a schedule inside Fabric Activator and get emailed on each new
                match — all processing happens server-side in KQL.
              </Body1>
            </div>
            <Button
              appearance="primary"
              disabled={!canCreateAlert}
              onClick={() => setAlertOpen(true)}
            >
              Create an Activator Alert
            </Button>
          </div>
          {!activeProfile && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Connect a connection profile to create an alert.
            </Caption1>
          )}
        </Card>
      )}

      {alertSource && activeProfile && (
        <CreateActivatorAlertDialog
          open={alertOpen}
          onClose={() => setAlertOpen(false)}
          source={alertSource}
          timeseriesRef={activeProfile.timeseriesQuery}
          connectionProfileName={activeProfile.name}
          databaseName={activeProfile.databaseName}
          fabricWorkspaceId={activeProfile.fabricWorkspaceId}
          kqlDatabaseId={activeProfile.kqlDatabaseId}
          binKql={sharedBin.kql}
          binSeconds={result ? result.binSeconds : sharedBin.millis / 1000}
          binLabel={sharedBin.label}
          params={params}
        />
      )}

      {result && result.kind === 'multi' && (
        <Card className={styles.section}>
          <OutputDescription label="Multivariate matches">
            {EXPLAINERS.similarity.outputs!.multivariateMatches}
          </OutputDescription>
          <MultiSeriesResult
            matches={result.matches}
            queryTracks={result.queryTracks}
            searchTracks={result.searchTracks}
            nameById={result.nameByTrack}
            binSeconds={result.binSeconds}
            searchStartMs={result.searchStartMs}
            smooth={false}
            decimals={tooltipDecimals}
          />
        </Card>
      )}

      {result && result.kind === 'single' && (
        <Card className={styles.section}>
          <div className={styles.vizControls}>
            <Subtitle1>Matches ({result.matches.length})</Subtitle1>
            <Field
              label={withInfo(
                'Chart layout',
                EXPLAINERS.similarity.inputs!.chartLayout,
              )}
            >
              <Select
                className={styles.layoutSelect}
                value={layout}
                onChange={(_, d) => setLayout(d.value as LayoutMode)}
              >
                {LAYOUT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {hasMatches ? (
            <>
              <Subtitle1>Pattern comparison</Subtitle1>
              <OutputDescription label="Pattern comparison chart">
                {EXPLAINERS.similarity.outputs!.comparisonChart}
              </OutputDescription>
              <SimilarityComparisonChart
                queryValues={result.queryValues}
                matches={result.matches}
                searchSeries={result.searchSeries}
                nameById={nameById}
                layout={layout}
                smooth={false}
                decimals={tooltipDecimals}
              />

              <Subtitle1>Search space timeline</Subtitle1>
              <OutputDescription label="Search space timeline">
                {EXPLAINERS.similarity.outputs!.timelineChart}
              </OutputDescription>
              {timelineAnnot.selecting && (
                <MessageBar intent="info">
                  <MessageBarBody>
                    Drag across the chart to select a time range, or click a single point, then
                    fill in the annotation details.
                  </MessageBarBody>
                </MessageBar>
              )}
              {timelineAnnot.error && (
                <MessageBar intent="error">
                  <MessageBarBody>{timelineAnnot.error}</MessageBarBody>
                </MessageBar>
              )}
              <SimilarityTimelineChart
                searchSeries={result.searchSeries}
                matches={result.matches}
                nameById={nameById}
                binSeconds={result.binSeconds}
                searchStartMs={result.searchStartMs}
                layout={layout}
                smooth={false}
                decimals={tooltipDecimals}
                markers={timelineAnnot.chartMarkers}
                chartRef={timelineAnnot.chartRef}
                onBrushEnd={timelineAnnot.onBrushEndEvent}
                brushEnabled={timelineAnnot.selecting}
                annotateAction={
                  <>
                    <ToggleButton
                      appearance="subtle"
                      size="small"
                      icon={<CommentAdd24Regular />}
                      checked={timelineAnnot.selecting}
                      disabled={!timelineAnnot.currentUserId}
                      title={
                        timelineAnnot.currentUserId
                          ? 'Pick a time range or point on the chart to annotate'
                          : 'Sign in with Fabric to add annotations'
                      }
                      onClick={() =>
                        timelineAnnot.selecting
                          ? timelineAnnot.cancelSelecting()
                          : timelineAnnot.beginSelecting()
                      }
                    >
                      {timelineAnnot.selecting ? 'Selecting…' : 'Annotate'}
                    </ToggleButton>
                    <TimelineMarkersButton
                      annot={timelineAnnot}
                      showOnChart={showOnChart}
                      onToggleShowOnChart={setShowOnChart}
                    />
                  </>
                }
              />
              
              <Subtitle1>Match details</Subtitle1>
              <OutputDescription label="Match details table">
                {EXPLAINERS.similarity.outputs!.matchDetails}
              </OutputDescription>
              <ResultsTable table={result.raw} hideColumns={hideColumns} />
            </>
          ) : (
            <Body1>No matches found for these parameters.</Body1>
          )}
        </Card>
      )}
      {timelineAnnot.dialogInitial && (
        <AnnotationDialog
          open={timelineAnnot.dialogOpen}
          mode={timelineAnnot.dialogMode}
          tags={tags}
          initial={timelineAnnot.dialogInitial}
          onClose={timelineAnnot.closeDialog}
          onSaved={timelineAnnot.reload}
        />
      )}
    </div>
  );
}
