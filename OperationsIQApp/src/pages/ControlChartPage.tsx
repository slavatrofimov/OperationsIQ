import { useEffect, useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import * as echarts from 'echarts';
import {
  Body1,
  Button,
  Caption1,
  Card,
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Subtitle1,
  Subtitle2,
  ToggleButton,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentAdd24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildExploreQuery } from '../lib/kql';
import { executeKql } from '../lib/eventhouse';
import { parseExploreRows, PALETTE } from '../lib/series';
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
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { withInfo } from '../components/fieldInfo';
import { EXPLAINERS } from '../lib/explainers';
import { useSharedRange, useSharedPrimaryTag } from '../context/SelectionContext';
import type { ChartData } from '../lib/export';
import { fireAlert, type AlertSeverity } from '../lib/alertCenter';
import { TIME_AXIS_LABEL, tooltipValueFormatter } from '../lib/exploreSettings';
import { usePageBinning } from '../context/BinningContext';
import { chooseBinFor, type BinningSettings } from '../lib/binningSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useRegisterCaptureContext, type CaptureContextSummary } from '../context/CaptureContext';
import { fmtWindow, tagNames, binningFields } from '../lib/captureContextHelpers';
import {
  buildControlChart,
  estimateLimits,
  individualsToSubgroups,
  type ChartPanel,
  type ControlChartResult,
  type ControlChartType,
  type ControlPhase,
  type EstimatedLimits,
  type Subgroup,
} from '../lib/spc/controlChart';
import { CapabilityPanel } from '../components/CapabilityPanel';
import { withinSigmaFromChart } from '../lib/spc/capability';
import {
  approveBaseline,
  baselineSufficiency,
  listBaselines,
  reviseBaseline,
  saveBaseline,
  toFrozenLimits,
  type SaveBaselineInput,
  type SpcBaselineView,
} from '../lib/spc/baseline';
import {
  DEFAULT_RULE_PARAMS,
  estimateFalseAlarm,
  evaluateRules,
  flaggedIndices,
  resolveProfile,
  RULE_DEFS,
  RULE_PROFILES,
  type RuleConfig,
  type RuleId,
  type RuleViolation,
} from '../lib/spc/rules';
import { useChartAnnotations } from '../hooks/useChartAnnotations';
import { useHierarchyLevels } from '../hooks/useHierarchyLevels';
import { mergeAnnotationMarkers } from '../lib/annotationMarkers';
import { AnnotationDialog } from '../components/AnnotationDialog';
import { TimelineMarkersButton } from '../components/TimelineMarkersButton';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  actionRow: { display: 'flex', justifyContent: 'flex-end' },
  spacer: { flex: 1 },
  controls: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  card: { padding: tokens.spacingVerticalL },
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Rule and description columns hold long text; let the flex cell shrink and
  // wrap rather than overlap the adjacent column.
  wrapCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  ruleRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  ruleChecks: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalXS,
  },
  cardActions: { display: 'flex', alignItems: 'center', marginBottom: tokens.spacingVerticalS },
  num: { width: '110px' },
  kpis: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  kpi: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: '130px',
  },
  kpiValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold },
  signalsPager: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    justifyContent: 'flex-end',
    marginTop: tokens.spacingVerticalS,
  },
});

const POINT_COLOR = PALETTE[0];
const CL_COLOR = '#107c10';
const LIMIT_COLOR = '#a4262c';
const ZONE2_COLOR = '#c19c00';
const ZONE1_COLOR = '#8a8886';
const SPEC_COLOR = '#5c2e91';
const TARGET_COLOR = '#008272';
const VIOLATION_COLOR = '#d13438';
const BASELINE_SHADE = 'rgba(15, 108, 189, 0.08)';

/**
 * Above this many plotted points, per-point symbols are hidden and the line is
 * LTTB-downsampled so the primary/secondary charts stay responsive on large
 * datasets. Out-of-control points remain visible via the violation scatter.
 */
const SYMBOL_LIMIT = 2000;

/** Rows rendered per page in the special-cause signals table (paged to keep the DOM small). */
const SIGNALS_PAGE_SIZE = 100;

const CHART_TYPES: { value: ControlChartType; label: string }[] = [
  { value: 'i-mr', label: 'Individuals & Moving Range (I-MR)' },
  { value: 'xbar-r', label: 'X\u0304-R (subgroup mean & range)' },
  { value: 'xbar-s', label: 'X\u0304-S (subgroup mean & std dev)' },
];

const BASELINE_OPTIONS = [
  { value: 100, label: 'All data (Phase I \u2014 establish limits)' },
  { value: 75, label: 'First 75% (Phase II \u2014 monitor new data)' },
  { value: 50, label: 'First 50% (Phase II \u2014 monitor new data)' },
  { value: 25, label: 'First 25% (Phase II \u2014 monitor new data)' },
];

interface SpecLimits {
  lsl?: number;
  usl?: number;
  target?: number;
}

/** Plain-language gloss for the standard SPC phase terminology. */
const PHASE_GLOSS: Record<ControlPhase, string> = {
  I: 'Establishing limits',
  II: 'Monitoring vs frozen limits',
};

interface ControlChartPageResult {
  tagId: string;
  chart: ControlChartResult;
  primaryViolations: RuleViolation[];
  secondaryViolations: RuleViolation[];
  spec: SpecLimits;
  baselineCount: number;
  totalSubgroups: number;
  ruleProfile: string;
  /** All finite individual observations (for capability analysis). */
  values: number[];
  /** Within-subgroup (short-term) σ recovered from the control chart. */
  withinSigma: number;
  /** Whether the process is in statistical control (no special-cause signals). */
  inControl: boolean;
  /** Set when a governed baseline drove the (Phase II) limits. */
  governedByBaselineId?: string;
}

/** Group consecutive finite readings into rational subgroups of `size`. */
function buildSubgroups(
  type: ControlChartType,
  xMs: number[],
  values: (number | null)[],
  size: number,
): Subgroup[] {
  if (type === 'i-mr') return individualsToSubgroups(xMs, values);
  const groups: Subgroup[] = [];
  let cur: number[] = [];
  let lastX = xMs[0] ?? 0;
  for (let i = 0; i < xMs.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) {
      cur.push(v);
      lastX = xMs[i];
    }
    if (cur.length >= size) {
      groups.push({ x: lastX, values: cur });
      cur = [];
    }
  }
  // Keep a trailing partial subgroup only if it can still form a valid subgroup.
  if (cur.length >= 2) groups.push({ x: lastX, values: cur });
  return groups;
}

function parseSpec(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const PANEL_TITLES: Record<ChartPanel['kind'], string> = {
  individuals: 'Individuals',
  xbar: 'Subgroup mean (X\u0304)',
  'moving-range': 'Moving range (MR)',
  range: 'Range (R)',
  stdev: 'Std dev (S)',
};

/**
 * Control chart page: Shewhart I-MR / X̄-R / X̄-S charts with control-limit and
 * zone anatomy, configurable Nelson/WECO/Minitab special-cause rules, optional
 * specification-limit reference lines (kept visually distinct from control
 * limits), and a governed Phase I → Phase II baseline split.
 */
export function ControlChartPage({ tags }: { tags: TagInfo[] }) {
  const styles = useStyles();
  const [tag, setTag] = useSharedPrimaryTag();
  const [range, setRange] = useSharedRange();
  const [chartType, setChartType] = useState<ControlChartType>('i-mr');
  const [subgroupSize, setSubgroupSize] = useState(5);
  const [ruleProfile, setRuleProfile] = useState('nelson');
  const [selectedRules, setSelectedRules] = useState<RuleId[]>(() => [...resolveProfile('nelson').ruleIds]);
  const [baselinePct, setBaselinePct] = useState(100);
  const [lsl, setLsl] = useState('');
  const [usl, setUsl] = useState('');
  const [target, setTarget] = useState('');
  const [alertNote, setAlertNote] = useState<string | null>(null);
  // Governed baseline state: the applied Phase II baseline (if any), the list of
  // this tag's saved baselines, the dropdown selection, the save-name, and a
  // status message from baseline lifecycle actions.
  const [appliedBaseline, setAppliedBaseline] = useState<SpcBaselineView | null>(null);
  const [baselines, setBaselines] = useState<SpcBaselineView[]>([]);
  const [selectedBaselineId, setSelectedBaselineId] = useState('');
  const [baselineName, setBaselineName] = useState('');
  const [baselineNote, setBaselineNote] = useState<string | null>(null);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [signalsPage, setSignalsPage] = useState(0);
  const binning = usePageBinning();
  const tooltipDecimals = useTooltipDecimals();
  const labeler = useTagLabeler();
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const levels = useHierarchyLevels();
  const [showOnChart, setShowOnChart] = useState(false);
  const annot = useChartAnnotations({ tags, levels, tagIds: tag, range, showMarkers: showOnChart });

  // The currently selected profile and the individual rules it makes available.
  // A profile can override run-length params (e.g. WECO's 8-in-a-row), which we
  // must preserve when the user cherry-picks a subset of its rules.
  const profileConfig = useMemo(() => resolveProfile(ruleProfile), [ruleProfile]);
  const availableRuleIds = useMemo(
    () => [...profileConfig.ruleIds].sort((a, b) => a - b),
    [profileConfig],
  );
  const ruleParams = useMemo(
    () => ({ ...DEFAULT_RULE_PARAMS, ...(profileConfig.params ?? {}) }),
    [profileConfig],
  );
  // Effective config: the cherry-picked rule ids applied with the profile's params.
  const effectiveConfig = useMemo<RuleConfig>(
    () => ({ ruleIds: [...selectedRules].sort((a, b) => a - b), params: profileConfig.params }),
    [selectedRules, profileConfig],
  );

  // Changing the rule set resets the individual selection to ALL of the new
  // set's rules, so the profile choice always seeds a sensible default.
  const changeRuleProfile = (profile: string) => {
    setRuleProfile(profile);
    setSelectedRules([...resolveProfile(profile).ruleIds]);
  };

  const toggleRule = (id: RuleId, checked: boolean) => {
    setSelectedRules((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((r) => r !== id),
    );
  };

  const appliedRulesText =
    selectedRules.length === 0
      ? 'None (no special-cause tests applied)'
      : [...selectedRules]
          .sort((a, b) => a - b)
          .map((id) => `#${id} ${RULE_DEFS[id].name}`)
          .join(', ');

  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (tag.length === 0) return null;
    return {
      sections: [
        { title: 'Tags', fields: [{ label: 'Charted tag', value: tagNames(tag, nameById) }] },
        { title: 'Time range', fields: [{ label: 'Time window', value: fmtWindow(range.start, range.end) }] },
        {
          title: 'Configuration',
          fields: [
            { label: 'Chart type', value: CHART_TYPES.find((c) => c.value === chartType)?.label ?? chartType },
            ...(chartType === 'i-mr' ? [] : [{ label: 'Subgroup size', value: String(subgroupSize) }]),
            { label: 'Rule set', value: RULE_PROFILES[ruleProfile]?.label ?? ruleProfile },
            { label: 'Applied rules', value: appliedRulesText },
            { label: 'Baseline', value: BASELINE_OPTIONS.find((b) => b.value === baselinePct)?.label ?? `${baselinePct}%` },
            ...binningFields(binning.settings),
          ],
        },
      ],
    };
  }, [tag, nameById, range, chartType, subgroupSize, ruleProfile, appliedRulesText, baselinePct, binning.settings]);
  useRegisterCaptureContext(captureSummary);

  const [state, run] = useAsyncAction(
    async (
      tagId: string,
      r: TimeRange,
      type: ControlChartType,
      size: number,
      profile: string,
      ruleConfig: RuleConfig,
      pct: number,
      spec: SpecLimits,
      s: BinningSettings,
      governed?: EstimatedLimits & { baselineId: string },
    ): Promise<ControlChartPageResult | null> => {
      const bin = chooseBinFor({ start: r.start, end: r.end }, s);
      const table = await executeKql(
        buildExploreQuery({
          tagIds: [tagId],
          start: r.start,
          end: r.end,
          binKql: bin.kql,
          aggregation: s.aggregation,
        }),
      );
      const series = parseExploreRows(table)[0];
      if (!series) return null;

      const xMs = series.x.map((sec) => sec * 1000);
      const subgroups = buildSubgroups(type, xMs, series.values, size);
      if (subgroups.length < 2) return null;

      // A loaded governed baseline drives Phase II directly. Otherwise Phase I
      // estimates limits from the baseline window and (for a leading fraction)
      // freezes them for Phase II.
      let frozen: EstimatedLimits | undefined;
      let baselineCount: number;
      if (governed) {
        frozen = governed;
        baselineCount = subgroups.length;
      } else {
        baselineCount =
          pct >= 100 ? subgroups.length : Math.max(2, Math.floor((subgroups.length * pct) / 100));
        frozen = pct >= 100 ? undefined : estimateLimits(type, subgroups.slice(0, baselineCount));
      }
      const chart = buildControlChart(type, subgroups, frozen);

      const config = ruleConfig;
      const primaryViolations = evaluateRules(
        { values: chart.primary.points.map((p) => p.value), limits: chart.primary.limits },
        config,
      );
      // The variation chart conventionally uses only the beyond-limits test.
      const secondaryViolations = evaluateRules(
        { values: chart.secondary.points.map((p) => p.value), limits: chart.secondary.limits },
        { ruleIds: [1] },
      );

      const values = series.values.filter((v): v is number => v != null && Number.isFinite(v));
      const withinSigma = withinSigmaFromChart(chart.primary.limits.sigma, chart.subgroupSize);
      const inControl = primaryViolations.length === 0 && secondaryViolations.length === 0;

      return {
        tagId,
        chart,
        primaryViolations,
        secondaryViolations,
        spec,
        baselineCount,
        totalSubgroups: subgroups.length,
        ruleProfile: profile,
        values,
        withinSigma,
        inControl,
        governedByBaselineId: governed?.baselineId,
      };
    },
  );

  const compute = () => {
    if (tag.length === 0) return;
    setAlertNote(null);
    const governed =
      appliedBaseline && appliedBaseline.tagId === tag[0]
        ? { ...toFrozenLimits(appliedBaseline), baselineId: appliedBaseline.id }
        : undefined;
    run(
      tag[0],
      range,
      chartType,
      subgroupSize,
      ruleProfile,
      effectiveConfig,
      baselinePct,
      { lsl: parseSpec(lsl), usl: parseSpec(usl), target: parseSpec(target) },
      binning.settings,
      governed,
    ).catch(() => {});
  };

  const result = state.data;

  // Register this page with the Operations Advisor.
  useControlledPage({
    pageKey: 'controlchart',
    title: 'Control chart',
    fields: [
      tagField({ tags, current: tag, set: setTag }),
      rangeField({ current: range, set: setRange }),
      ...controllerBinningFields(binning),
      {
        field: pf.enumOf('chartType', 'Chart type', chartType, CHART_TYPES),
        apply: (v) =>
          setChartType(coerce.enumValue(v, CHART_TYPES.map((c) => c.value)) as ControlChartType),
      },
      {
        field: pf.integer('subgroupSize', 'Subgroup size', subgroupSize, {
          min: 2,
          max: 25,
          description: 'Rational subgroup size for X-bar charts.',
        }),
        apply: (v) => setSubgroupSize(coerce.integer(v, { min: 2, max: 25 })),
      },
      {
        field: pf.enumOf(
          'ruleProfile',
          'Rule set',
          ruleProfile,
          Object.entries(RULE_PROFILES).map(([value, p]) => ({ value, label: p.label })),
          { description: 'Special-cause rule profile.' },
        ),
        apply: (v) => changeRuleProfile(coerce.enumValue(v, Object.keys(RULE_PROFILES)) as string),
      },
      {
        field: pf.string('selectedRules', 'Applied rules', selectedRules.join(','), {
          description: 'Comma-separated special-cause rule numbers; empty applies none.',
        }),
        apply: (v) => {
          const raw = coerce.string(v).trim();
          const ids = raw === ''
            ? []
            : raw
                .split(/[,\s]+/)
                .filter(Boolean)
                .map((part) => Number(part));
          const invalid = ids.filter((id) => !availableRuleIds.includes(id as RuleId));
          if (invalid.length) {
            return `selectedRules must contain only available rule ids: ${availableRuleIds.join(', ')}`;
          }
          setSelectedRules([...new Set(ids.map((id) => id as RuleId))]);
        },
      },
      {
        field: pf.enumOf(
          'baselinePct',
          'Baseline',
          baselinePct,
          BASELINE_OPTIONS.map((b) => ({ value: b.value, label: b.label })),
          { description: 'Percent of data used to estimate Phase I limits.' },
        ),
        apply: (v) =>
          setBaselinePct(coerce.enumValue(v, BASELINE_OPTIONS.map((b) => b.value)) as number),
      },
      {
        field: pf.string('lsl', 'LSL', lsl, { description: 'Optional lower specification limit.' }),
        apply: (v) => setLsl(coerce.string(v)),
      },
      {
        field: pf.string('target', 'Target', target, { description: 'Optional target specification value.' }),
        apply: (v) => setTarget(coerce.string(v)),
      },
      {
        field: pf.string('usl', 'USL', usl, { description: 'Optional upper specification limit.' }),
        apply: (v) => setUsl(coerce.string(v)),
      },
    ],
    canRun: tag.length > 0 && !state.loading,
    run: compute,
    loading: state.loading,
    error: state.error ?? undefined,
    hasResult: !!result,
  });

  // Governed metadata can auto-apply a bound baseline for Phase II or prefill
  // spec limits and chart/rule preferences; all values remain overridable.
  const currentTag = tag[0];
  useEffect(() => {
    let cancelled = false;
    setSelectedBaselineId('');
    setAppliedBaseline(null);
    if (!currentTag) {
      setBaselines([]);
      return;
    }
    const info = tags.find((t) => t.tagId === currentTag);
    listBaselines(currentTag)
      .then((bs) => {
        if (cancelled) return;
        setBaselines(bs);
        if (!info) return;
        const bound = info.activeBaselineId ? bs.find((b) => b.id === info.activeBaselineId) : undefined;
        if (bound) {
          applyBaselineObject(bound);
          setSelectedBaselineId(bound.id);
          setBaselineNote(
            `Auto-applied governed baseline "${bound.name}" v${bound.version} (${bound.status}) bound to this signal's metadata. Build chart to monitor against these frozen Phase II limits.`,
          );
          return;
        }
        // No bound baseline: seed the setup from the tag's governed metadata.
        if (
          info.preferredChartType === 'i-mr' ||
          info.preferredChartType === 'xbar-r' ||
          info.preferredChartType === 'xbar-s'
        ) {
          setChartType(info.preferredChartType);
        }
        if (info.ruleProfile && RULE_PROFILES[info.ruleProfile]) {
          setRuleProfile(info.ruleProfile);
          setSelectedRules([...resolveProfile(info.ruleProfile).ruleIds]);
        }
        setUsl(info.usl != null ? String(info.usl) : '');
        setLsl(info.lsl != null ? String(info.lsl) : '');
        setTarget(info.target != null ? String(info.target) : '');
      })
      .catch(() => {
        if (!cancelled) setBaselines([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTag, tags]);

  const refreshBaselines = async () => {
    if (!currentTag) return;
    try {
      setBaselines(await listBaselines(currentTag));
    } catch {
      /* best-effort */
    }
  };

  /** Build the persist payload from the currently displayed chart. */
  const baselineInputFromResult = (name: string): SaveBaselineInput | null => {
    if (!result) return null;
    return {
      name,
      tagId: result.tagId,
      chartType: result.chart.type,
      subgroupSize: result.chart.subgroupSize,
      primary: result.chart.primary.limits,
      secondary: result.chart.secondary.limits,
      ruleProfile: result.ruleProfile,
      lsl: result.spec.lsl,
      usl: result.spec.usl,
      target: result.spec.target,
      baselineStart: range.start,
      baselineEnd: range.end,
      baselineSubgroupCount: result.baselineCount,
      phase: result.chart.phase,
    };
  };

  const saveAsBaseline = async () => {
    const name = baselineName.trim();
    if (!result || name === '') {
      setBaselineNote('Enter a name for the baseline first.');
      return;
    }
    // Guard against a stale result from a previously charted tag: only save when
    // the displayed chart belongs to the currently selected tag, so the
    // persisted tag_id and the governed name list always agree.
    if (result.tagId !== currentTag) {
      setBaselineNote('Rebuild the chart for the selected tag before saving a baseline.');
      return;
    }
    const input = baselineInputFromResult(name);
    if (!input) return;
    setBaselineBusy(true);
    setBaselineNote(null);
    try {
      // If a baseline of the same name exists for this tag, revise the current
      // head (highest active version) — a new version, never a silent overwrite.
      // Choose by max version (not list order) so approve/retire activity on an
      // older row can't make a stale version the revision parent.
      const matches = baselines.filter((b) => b.name === name && b.status !== 'retired');
      const prior =
        matches.length > 0 ? matches.reduce((a, b) => (b.version > a.version ? b : a)) : undefined;
      if (prior) {
        await reviseBaseline(prior, input);
        setBaselineNote(`Saved "${name}" as version ${prior.version + 1} (draft). Approve it to freeze the limits.`);
      } else {
        await saveBaseline(input);
        setBaselineNote(`Saved "${name}" as a draft baseline. Approve it to freeze the limits.`);
      }
      setBaselineName('');
      await refreshBaselines();
    } catch (e) {
      setBaselineNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBaselineBusy(false);
    }
  };

  const applyBaselineObject = (b: SpcBaselineView) => {
    // Adopt the baseline's configuration and freeze its limits for Phase II.
    setChartType(b.chartType);
    setSubgroupSize(b.subgroupSize);
    setRuleProfile(b.ruleProfile);
    setSelectedRules([...resolveProfile(b.ruleProfile).ruleIds]);
    setLsl(b.lsl != null ? String(b.lsl) : '');
    setUsl(b.usl != null ? String(b.usl) : '');
    setTarget(b.target != null ? String(b.target) : '');
    setAppliedBaseline(b);
  };

  const applySelectedBaseline = () => {
    const b = baselines.find((x) => x.id === selectedBaselineId);
    if (!b) return;
    applyBaselineObject(b);
    setBaselineNote(
      `Applied "${b.name}" v${b.version} (${b.status}). Choose Build chart to monitor new data against these frozen Phase II limits (Phase II \u2014 monitoring an established baseline).`,
    );
  };

  const clearAppliedBaseline = () => {
    setAppliedBaseline(null);
    setBaselineNote('Cleared the applied baseline. Limits will be re-estimated from the data (Phase I \u2014 establishing limits).');
  };

  const approveSelectedBaseline = async () => {
    const b = baselines.find((x) => x.id === selectedBaselineId);
    if (!b) return;
    setBaselineBusy(true);
    setBaselineNote(null);
    try {
      await approveBaseline(b);
      setBaselineNote(`Approved "${b.name}" v${b.version}. Its limits are now frozen and auditable.`);
      await refreshBaselines();
    } catch (e) {
      setBaselineNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBaselineBusy(false);
    }
  };

  const sendToAlertCenter = async () => {
    if (!result) return;
    const tagName = labeler(result.tagId, nameById.get(result.tagId));
    const total = result.chart.primary.points.filter((p) => p.value != null).length;
    const flagged = flaggedIndices(result.primaryViolations).size;
    const severity: AlertSeverity = flagged === 0 ? 'info' : flagged / Math.max(1, total) > 0.05 ? 'critical' : 'warning';
    try {
      await fireAlert({
        tagId: result.tagId,
        severity,
        title: `SPC signal on ${tagName}`,
        message: `${result.primaryViolations.length} rule violation(s) on ${result.chart.type.toUpperCase()} chart`,
        dedupKey: `controlchart:${result.tagId}`,
        evidence: {
          tagId: result.tagId,
          chartType: result.chart.type,
          phase: result.chart.phase,
          ruleProfile: result.ruleProfile,
          window: { start: range.start.toISOString(), end: range.end.toISOString() },
          limits: result.chart.primary.limits,
          violations: result.primaryViolations.map((v) => ({
            ruleId: v.ruleId,
            ruleName: v.ruleName,
            side: v.side,
            at: new Date(result.chart.primary.points[v.flaggedIndex]?.x ?? 0).toISOString(),
            description: v.description,
          })),
        },
      });
      setAlertNote('Finding recorded.');
    } catch (e) {
      setAlertNote(e instanceof Error ? e.message : String(e));
    }
  };

  const fmt = (n: number) =>
    Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '\u2014';

  const fmtArl = (n: number) =>
    Number.isFinite(n) ? Math.round(n).toLocaleString() : '\u221e';

  const buildPanelOption = (
    panel: ChartPanel,
    violations: RuleViolation[],
    isPrimary: boolean,
  ): echarts.EChartsCoreOption => {
    const fmtVal = tooltipValueFormatter(tooltipDecimals);
    const points = panel.points.map((p) => [p.x, p.value] as [number, number | null]);
    const flagged = flaggedIndices(violations);
    const violationPoints = panel.points
      .map((p, i) => (flagged.has(i) && p.value != null ? [p.x, p.value] : null))
      .filter((v): v is [number, number] => v != null);

    // Map a point's time to the rules that flagged it, for hover explanations.
    const byX = new Map<number, RuleViolation[]>();
    for (const v of violations) {
      const px = panel.points[v.flaggedIndex]?.x;
      if (px == null) continue;
      const list = byX.get(px) ?? [];
      list.push(v);
      byX.set(px, list);
    }

    const L = panel.limits;
    const line = (
      y: number,
      name: string,
      color: string,
      type: 'solid' | 'dashed' | 'dotted',
      width = 1,
    ) => ({
      yAxis: y,
      lineStyle: { color, type, width },
      label: { formatter: name, position: 'end' as const, color },
    });

    const markLines: Record<string, unknown>[] = [
      line(L.centerLine, 'CL', CL_COLOR, 'solid', 1.5),
      line(L.ucl, 'UCL', LIMIT_COLOR, 'dashed', 1.25),
      line(L.zoneUpper2, '2\u03c3', ZONE2_COLOR, 'dotted'),
      line(L.zoneUpper1, '1\u03c3', ZONE1_COLOR, 'dotted'),
      line(L.zoneLower1, '', ZONE1_COLOR, 'dotted'),
      line(L.zoneLower2, '', ZONE2_COLOR, 'dotted'),
      line(L.lcl, 'LCL', LIMIT_COLOR, 'dashed', 1.25),
    ];
    if (isPrimary) {
      if (result?.spec.usl != null) markLines.push(line(result.spec.usl, 'USL', SPEC_COLOR, 'dashed', 1.25));
      if (result?.spec.lsl != null) markLines.push(line(result.spec.lsl, 'LSL', SPEC_COLOR, 'dashed', 1.25));
      if (result?.spec.target != null) markLines.push(line(result.spec.target, 'Target', TARGET_COLOR, 'solid'));
    }

    // Shade the Phase I baseline-estimation window when a split is in effect.
    const markAreas: Record<string, unknown>[][] = [];
    if (isPrimary && result && result.baselineCount < result.totalSubgroups) {
      const endX = panel.points[result.baselineCount - 1]?.x;
      if (endX != null) {
        markAreas.push([
          { xAxis: panel.points[0]?.x, itemStyle: { color: BASELINE_SHADE }, name: 'Baseline (Phase I \u2014 establish limits)' },
          { xAxis: endX },
        ]);
      }
    }

    return {
      animation: false,
      grid: { left: 60, right: 60, top: 32, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: unknown) => {
          const arr = Array.isArray(params) ? params : [params];
          const first = arr[0] as { axisValue?: number } | undefined;
          const t = first?.axisValue;
          const when = typeof t === 'number' ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '';
          let html = `${when}<br/>`;
          for (const p of arr as { seriesName?: string; marker?: string; value?: [number, number | null] }[]) {
            if (p.seriesName === 'Rule violation') continue;
            const val = p.value?.[1];
            html += `${p.marker ?? ''} ${p.seriesName}: ${typeof val === 'number' ? fmtVal(val) : '\u2014'}<br/>`;
          }
          const vs = typeof t === 'number' ? byX.get(t) : undefined;
          if (vs && vs.length > 0) {
            html += `<b>Signals:</b><br/>`;
            html += vs.map((v) => `\u2022 Rule ${v.ruleId} \u2014 ${v.ruleName} (${v.side})`).join('<br/>');
          }
          return html;
        },
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: { type: 'value', scale: true },
      series: [
        {
          name: PANEL_TITLES[panel.kind],
          type: 'line',
          // For large series, drop per-point symbols and downsample the drawn
          // path (LTTB preserves the visual shape). The trend line plus the red
          // violation-scatter overlay still convey every special-cause signal,
          // and this keeps rendering responsive on thousands of points.
          showSymbol: points.length <= SYMBOL_LIMIT,
          symbolSize: 4,
          sampling: 'lttb',
          lineStyle: { width: 1.25, color: POINT_COLOR },
          itemStyle: { color: POINT_COLOR },
          data: points,
          markLine: {
            silent: true,
            symbol: 'none',
            data: markLines,
          },
          markArea: markAreas.length > 0 ? { silent: true, data: markAreas } : undefined,
        },
        {
          name: 'Rule violation',
          type: 'scatter',
          symbolSize: 9,
          itemStyle: { color: VIOLATION_COLOR },
          data: violationPoints,
          // Optimized renderer for the (potentially many) out-of-control points.
          large: true,
          largeThreshold: 500,
          z: 5,
        },
      ],
    };
  };

  const primaryOption = useMemo<echarts.EChartsCoreOption>(
    () => (result ? buildPanelOption(result.chart.primary, result.primaryViolations, true) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, tooltipDecimals],
  );
  const secondaryOption = useMemo<echarts.EChartsCoreOption>(
    () => (result ? buildPanelOption(result.chart.secondary, result.secondaryViolations, false) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, tooltipDecimals],
  );
  const annotatedPrimaryOption = useMemo<echarts.EChartsCoreOption>(
    () =>
      mergeAnnotationMarkers(primaryOption, annot.chartMarkers, {
        brushEnabled: annot.selecting,
        fullStart: range.start.getTime(),
        fullEnd: range.end.getTime(),
      }),
    [primaryOption, annot.chartMarkers, annot.selecting, range],
  );

  const panelChartData = (panel: ChartPanel, violations: RuleViolation[]): ChartData => {
    const flagged = flaggedIndices(violations);
    return {
      columns: ['Timestamp', PANEL_TITLES[panel.kind], 'CL', 'UCL', 'LCL', 'Violation'],
      rows: panel.points.map((p, i) => [
        new Date(p.x).toISOString(),
        p.value,
        panel.limits.centerLine,
        panel.limits.ucl,
        panel.limits.lcl,
        flagged.has(i) ? 'Yes' : null,
      ]),
    };
  };

  const inControlPct = useMemo(() => {
    if (!result) return 1;
    const total = result.chart.primary.points.filter((p) => p.value != null).length;
    if (total === 0) return 1;
    return 1 - flaggedIndices(result.primaryViolations).size / total;
  }, [result]);

  const allViolations = useMemo(() => {
    if (!result) return [] as { panel: string; v: RuleViolation; at: number }[];
    const p = result.chart.primary;
    const s = result.chart.secondary;
    return [
      ...result.primaryViolations.map((v) => ({ panel: PANEL_TITLES[p.kind], v, at: p.points[v.flaggedIndex]?.x ?? 0 })),
      ...result.secondaryViolations.map((v) => ({ panel: PANEL_TITLES[s.kind], v, at: s.points[v.flaggedIndex]?.x ?? 0 })),
    ].sort((a, b) => a.at - b.at);
  }, [result]);

  // Page the signals table so a run with thousands of out-of-control points does
  // not mount thousands of DOM rows at once (the full set is still CSV-exportable).
  const signalsPageCount = Math.max(1, Math.ceil(allViolations.length / SIGNALS_PAGE_SIZE));
  const signalsCurrentPage = Math.min(signalsPage, signalsPageCount - 1);
  const pagedViolations = useMemo(
    () =>
      allViolations.slice(
        signalsCurrentPage * SIGNALS_PAGE_SIZE,
        signalsCurrentPage * SIGNALS_PAGE_SIZE + SIGNALS_PAGE_SIZE,
      ),
    [allViolations, signalsCurrentPage],
  );

  // Reset to the first page whenever a new chart is built.
  useEffect(() => {
    setSignalsPage(0);
  }, [result]);

  // False-alarm transparency: expected in-control ARL₀ for the selected rule set,
  // compared against the plain 3σ rule as a baseline (SPC spec §7, §8.2).
  const falseAlarm = useMemo(() => estimateFalseAlarm(effectiveConfig), [effectiveConfig]);
  const baselineFalseAlarm = useMemo(() => estimateFalseAlarm(resolveProfile('basic')), []);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle1>Control chart</Subtitle1>
        {result && (
          <Button appearance="secondary" onClick={() => void sendToAlertCenter()}>
            Record Finding
          </Button>
        )}
      </div>

      <PageIntro
        title="Control chart"
        overview={EXPLAINERS.controlchart.overview}
        interpretation={EXPLAINERS.controlchart.interpretation}
        technical={EXPLAINERS.controlchart.technical}
      />

      {alertNote && (
        <MessageBar intent="success">
          <MessageBarBody>{alertNote}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.controls}>
        <div style={{ minWidth: 240 }}>
          <TagSelect
            tags={tags}
            selected={tag}
            onChange={setTag}
            info={EXPLAINERS.controlchart.inputs!.tag}
          />
        </div>
        <Field label="Chart type">
          <Select value={chartType} onChange={(_, d) => setChartType(d.value as ControlChartType)}>
            {CHART_TYPES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        {chartType !== 'i-mr' && (
          <Field label="Subgroup size">
            <Input
              className={styles.num}
              type="number"
              min={2}
              max={25}
              value={String(subgroupSize)}
              onChange={(_, d) => setSubgroupSize(Math.max(2, Math.min(25, Number(d.value) || 2)))}
            />
          </Field>
        )}
        <Field label={withInfo('Rule set', EXPLAINERS.controlchart.inputs!.rules)}>
          <Select value={ruleProfile} onChange={(_, d) => changeRuleProfile(d.value)}>
            {Object.entries(RULE_PROFILES).map(([key, p]) => (
              <option key={key} value={key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={withInfo('Baseline', EXPLAINERS.controlchart.inputs!.baseline)}>
          <Select value={String(baselinePct)} onChange={(_, d) => setBaselinePct(Number(d.value))}>
            {BASELINE_OPTIONS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={withInfo('LSL', EXPLAINERS.controlchart.inputs!.spec)}>
          <Input className={styles.num} value={lsl} onChange={(_, d) => setLsl(d.value)} placeholder="none" />
        </Field>
        <Field label="Target">
          <Input className={styles.num} value={target} onChange={(_, d) => setTarget(d.value)} placeholder="none" />
        </Field>
        <Field label="USL">
          <Input className={styles.num} value={usl} onChange={(_, d) => setUsl(d.value)} placeholder="none" />
        </Field>
      </div>

      <div className={styles.ruleRow}>
        <Field label={withInfo('Applied rules', EXPLAINERS.controlchart.inputs!.appliedRules)}>
          <div className={styles.ruleChecks}>
            {availableRuleIds.map((id) => (
              <Checkbox
                key={id}
                title={RULE_DEFS[id].describe(ruleParams)}
                checked={selectedRules.includes(id)}
                onChange={(_, d) => toggleRule(id, Boolean(d.checked))}
                label={`${id}. ${RULE_DEFS[id].name}`}
              />
            ))}
          </div>
        </Field>
        {selectedRules.length === 0 && (
          <Caption1>No rules selected — no special-cause signals will be flagged.</Caption1>
        )}
      </div>

      <AdaptiveBinningPanel
        range={range}
        onRangeChange={setRange}
        signals={tag[0] ? [{ tagId: tag[0], name: nameById.get(tag[0]) ?? tag[0] }] : []}
        settings={binning.settings}
        onChange={binning.patch}
        onSaveAsDefault={binning.saveAsDefault}
        onReset={binning.resetToDefault}
        isCustom={binning.isCustom}
        disabled={state.loading}
        densityTagIds={tag}
        densityEnabled={!state.loading}
      />

      <MessageBar intent="info">
        <MessageBarBody>
          <b>False-alarm outlook.</b> With the{' '}
          <b>{RULE_PROFILES[ruleProfile]?.label ?? ruleProfile}</b> rule set (
          {selectedRules.length} of {availableRuleIds.length} rules applied), an in-control
          process is expected to raise a false signal about once every{' '}
          <b>{fmtArl(falseAlarm.arl0)}</b> points (α ≈ {(falseAlarm.alpha * 100).toFixed(2)}%).
          {ruleProfile !== 'basic' && (
            <>
              {' '}The 3σ-only rule alone would flag about once every{' '}
              <b>{fmtArl(baselineFalseAlarm.arl0)}</b> points (α ≈{' '}
              {(baselineFalseAlarm.alpha * 100).toFixed(2)}%). Broader rule sets detect smaller
              shifts sooner but flag in-control data more often.
            </>
          )}{' '}
          Estimated by simulating in-control normal data through the selected rules.
        </MessageBarBody>
      </MessageBar>

      <Card className={styles.card}>
        <Subtitle2>Governed baseline</Subtitle2>
        <OutputDescription label="Baseline governance">
          {EXPLAINERS.controlchart.outputs!.baseline}
        </OutputDescription>
        {appliedBaseline && (
          <MessageBar intent="success">
            <MessageBarBody>
              Monitoring against <b>{appliedBaseline.name}</b> v{appliedBaseline.version} (
              {appliedBaseline.status}) — Phase II frozen limits (monitoring new data against an established baseline).{' '}
              <Button size="small" appearance="transparent" onClick={clearAppliedBaseline}>
                Clear
              </Button>
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.controls}>
          <Field label="Saved baselines">
            <Select
              value={selectedBaselineId}
              disabled={baselines.length === 0}
              onChange={(_, d) => setSelectedBaselineId(d.value)}
            >
              <option value="">{baselines.length === 0 ? 'None saved for this tag' : 'Select\u2026'}</option>
              {baselines.map((b) => (
                <option key={b.id} value={b.id}>
                  {`${b.name} \u2014 v${b.version} (${b.status})`}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            appearance="secondary"
            title="Freeze this baseline's limits and monitor new data against them (Phase II)."
            disabled={selectedBaselineId === '' || baselineBusy}
            onClick={applySelectedBaseline}
          >
            Load for Phase II
          </Button>
          <Button
            appearance="secondary"
            disabled={selectedBaselineId === '' || baselineBusy}
            onClick={() => void approveSelectedBaseline()}
          >
            Approve
          </Button>
          <div className={styles.spacer} />
          <Field label="Save current limits as">
            <Input
              value={baselineName}
              onChange={(_, d) => setBaselineName(d.value)}
              placeholder="baseline name"
            />
          </Field>
          <Button
            appearance="primary"
            disabled={!result || result.tagId !== currentTag || baselineName.trim() === '' || baselineBusy}
            onClick={() => void saveAsBaseline()}
          >
            {baselineBusy ? <Spinner size="tiny" /> : 'Save baseline'}
          </Button>
        </div>
        {result && (() => {
          const suff = baselineSufficiency(result.baselineCount);
          return suff.warning ? (
            <MessageBar intent={suff.sufficient ? 'warning' : 'error'}>
              <MessageBarBody>{suff.warning}</MessageBarBody>
            </MessageBar>
          ) : null;
        })()}
        {baselineNote && (
          <MessageBar intent="info">
            <MessageBarBody>{baselineNote}</MessageBarBody>
          </MessageBar>
        )}
      </Card>

      <div className={styles.actionRow}>
        <Button appearance="primary" disabled={tag.length === 0 || state.loading} onClick={compute}>
          {state.loading ? <Spinner size="tiny" /> : 'Build chart'}
        </Button>
      </div>

      {state.error && (
        <ErrorMessageBar error={state.error} />
      )}

      {result && (
        <>
          <OutputDescription label="Control chart summary">
            {EXPLAINERS.controlchart.outputs!.kpis}
          </OutputDescription>
          <div className={styles.kpis}>
            <div className={styles.kpi}>
              <Caption1>Phase</Caption1>
              <span className={styles.kpiValue}>{result.chart.phase}</span>
              <Caption1>{PHASE_GLOSS[result.chart.phase]}</Caption1>
            </div>
            <div className={styles.kpi}>
              <Caption1>In control</Caption1>
              <span className={styles.kpiValue}>{(inControlPct * 100).toFixed(1)}%</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>Signals</Caption1>
              <span className={styles.kpiValue}>{result.primaryViolations.length}</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>CL</Caption1>
              <span className={styles.kpiValue}>{fmt(result.chart.primary.limits.centerLine)}</span>
            </div>
            <div className={styles.kpi}>
              <Caption1>UCL / LCL</Caption1>
              <span className={styles.kpiValue}>
                {fmt(result.chart.primary.limits.ucl)} / {fmt(result.chart.primary.limits.lcl)}
              </span>
            </div>
          </div>
        </>
      )}

      <Card className={styles.card}>
        <div className={styles.cardActions}>
          <Subtitle2>
            {result
              ? `${PANEL_TITLES[result.chart.primary.kind]} \u2014 ${labeler(result.tagId, nameById.get(result.tagId))}`
              : 'Control chart'}
          </Subtitle2>
          <div className={styles.spacer} />
        </div>
        {annot.selecting && (
          <MessageBar intent="info">
            <MessageBarBody>
              Drag across the chart to select a time range, or click a single point, then fill in
              the annotation details.
            </MessageBarBody>
          </MessageBar>
        )}
        {annot.error && (
          <MessageBar intent="error">
            <MessageBarBody>{annot.error}</MessageBarBody>
          </MessageBar>
        )}
        {result ? (
          <>
            <Caption1>
              {`Control limits (CL/UCL/LCL) are computed from process variation${
                result.spec.lsl != null || result.spec.usl != null
                  ? '; specification limits (LSL/USL, purple) are drawn separately \u2014 a process can be in control yet not capable.'
                  : '.'
              }`}
            </Caption1>
            <OutputDescription label="Primary control chart">
              {EXPLAINERS.controlchart.outputs!.chart}
            </OutputDescription>
            <ChartFrame
              option={annotatedPrimaryOption}
              height={360}
              fileName="control_chart_primary"
              data={() => panelChartData(result.chart.primary, result.primaryViolations)}
              chartRef={annot.chartRef}
              onEvents={{ brushEnd: annot.onBrushEndEvent }}
              actions={
                <>
                  <ToggleButton
                    appearance="subtle"
                    size="small"
                    icon={<CommentAdd24Regular />}
                    checked={annot.selecting}
                    disabled={!annot.currentUserId || !result}
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
                    onToggleShowOnChart={setShowOnChart}
                  />
                </>
              }
            />
          </>
        ) : (
          <Body1>{state.loading ? 'Computing\u2026' : 'Pick a tag and range, then choose Build chart.'}</Body1>
        )}
      </Card>

      {result && (
        <Card className={styles.card}>
          <Subtitle2>{PANEL_TITLES[result.chart.secondary.kind]}</Subtitle2>
          <OutputDescription label="Variation chart">
            {EXPLAINERS.controlchart.outputs!.variation}
          </OutputDescription>
          <ChartFrame
            option={secondaryOption}
            height={240}
            fileName="control_chart_variation"
            data={() => panelChartData(result.chart.secondary, result.secondaryViolations)}
          />
        </Card>
      )}

      {result && (
        <Card className={styles.card}>
          <Subtitle2>Process capability</Subtitle2>
          <OutputDescription label="Capability analysis">
            {EXPLAINERS.controlchart.outputs!.capability}
          </OutputDescription>
          <CapabilityPanel
            values={result.values}
            withinSigma={result.withinSigma}
            lsl={result.spec.lsl}
            usl={result.spec.usl}
            target={result.spec.target}
            inControl={result.inControl}
          />
        </Card>
      )}

      {result && allViolations.length > 0 && (
        <Card className={styles.card}>
          <Subtitle2>Special-cause signals</Subtitle2>
          <OutputDescription label="Signals table">
            {EXPLAINERS.controlchart.outputs!.signals}
          </OutputDescription>
          <div className={styles.tableScroll}>
          <Table size="small" aria-label="Special-cause signals">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Time</TableHeaderCell>
                <TableHeaderCell>Chart</TableHeaderCell>
                <TableHeaderCell>Rule</TableHeaderCell>
                <TableHeaderCell>Side</TableHeaderCell>
                <TableHeaderCell>What it means</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedViolations.map(({ panel, v, at }, i) => (
                <TableRow key={`${v.ruleId}-${v.flaggedIndex}-${panel}-${signalsCurrentPage * SIGNALS_PAGE_SIZE + i}`}>
                  <TableCell>{new Date(at).toISOString().replace('T', ' ').slice(0, 19)}</TableCell>
                  <TableCell>{panel}</TableCell>
                  <TableCell className={styles.wrapCell}>{`${v.ruleId} \u2014 ${v.ruleName}`}</TableCell>
                  <TableCell>{v.side}</TableCell>
                  <TableCell className={styles.wrapCell}>{v.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
          <div className={styles.signalsPager}>
            <Caption1>
              {(() => {
                const first = signalsCurrentPage * SIGNALS_PAGE_SIZE + 1;
                const last = Math.min(allViolations.length, first + SIGNALS_PAGE_SIZE - 1);
                return `${first}\u2013${last} of ${allViolations.length} signals`;
              })()}
            </Caption1>
            {signalsPageCount > 1 && (
              <>
                <Button
                  appearance="subtle"
                  size="small"
                  disabled={signalsCurrentPage === 0}
                  onClick={() => setSignalsPage(signalsCurrentPage - 1)}
                >
                  Previous
                </Button>
                <Caption1>
                  {signalsCurrentPage + 1} / {signalsPageCount}
                </Caption1>
                <Button
                  appearance="subtle"
                  size="small"
                  disabled={signalsCurrentPage >= signalsPageCount - 1}
                  onClick={() => setSignalsPage(signalsCurrentPage + 1)}
                >
                  Next
                </Button>
              </>
            )}
          </div>
        </Card>
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
    </div>
  );
}
