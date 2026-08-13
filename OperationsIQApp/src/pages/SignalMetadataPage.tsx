import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Divider,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  Subtitle1,
  Subtitle2,
  Tab,
  TabList,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownloadRegular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useProfile } from '../context/ProfileContext';
import { useCatalog } from '../context/CatalogContext';
import { getHierarchyLevels } from '../lib/tagTree';
import { buildTagPath } from '../lib/tagTree';
import { PageIntro } from '../components/PageIntro';
import { TagSelect } from '../components/TagSelect';
import { withInfo } from '../components/fieldInfo';
import { DataTable } from '../components/DataTable';
import { chartDataToCsv, downloadText, fileStamp, type ChartData } from '../lib/export';
import {
  listSignalMetadata,
  saveSignalMetadata,
  updateDraftSignalMetadata,
  approveSignalMetadata,
  retireSignalMetadata,
  reviseSignalMetadata,
  type SignalMetadataView,
  type SignalMetadataValues,
  type SignalMetadataStatus,
} from '../lib/signalMetadata';
import { listBaselines, type SpcBaselineView } from '../lib/spc/baseline';
import { RULE_PROFILES } from '../lib/spc/rules';
import type { ControlChartType } from '../lib/spc/controlChart';
import { executeKql, rowsToObjects } from '../lib/eventhouse';
import { buildSignalProfileQuery } from '../lib/kql';
import { chooseBinFor, DEFAULT_BINNING_SETTINGS } from '../lib/binningSettings';
import { defaultRange } from '../lib/appTypes';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  selectorRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  selector: { minWidth: '320px', flex: 1 },
  coverage: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  editor: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  card: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  seedRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap', alignItems: 'center' },
  audit: { display: 'flex', flexDirection: 'column', gap: '2px' },
  sectionLabel: { marginTop: tokens.spacingVerticalS },
  tableHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

// ---------------------------------------------------------------------------
// Field configuration
// ---------------------------------------------------------------------------

type NumericKey =
  | 'operatingSetpoint'
  | 'upperOperatingLimit'
  | 'lowerOperatingLimit'
  | 'maxRateOfChange'
  | 'usl'
  | 'lsl'
  | 'target'
  | 'physicalMin'
  | 'physicalMax'
  | 'sensorUncertainty'
  | 'recommendedAlertThreshold'
  | 'recommendedConfidence';

interface NumField {
  key: NumericKey;
  label: string;
  /** Plain-language explanation shown via a clickable info icon next to the label. */
  info: string;
}

interface FieldGroup {
  title: string;
  fields: NumField[];
}

const FIELD_GROUPS: FieldGroup[] = [
  {
    title: 'Operating envelope',
    fields: [
      {
        key: 'operatingSetpoint',
        label: 'Setpoint',
        info: 'The target value the process is expected to hold during normal operation. Used as the default reference level across analysis pages.',
      },
      {
        key: 'upperOperatingLimit',
        label: 'Upper operating limit',
        info: 'The highest value considered normal during routine operation. Excursions above it mean the process is running higher than intended — distinct from a control limit (how it behaves) or a spec limit (what the product requires).',
      },
      {
        key: 'lowerOperatingLimit',
        label: 'Lower operating limit',
        info: 'The lowest value considered normal during routine operation. Excursions below it mean the process is running below its intended operating band.',
      },
      {
        key: 'maxRateOfChange',
        label: 'Max rate of change',
        info: 'The largest change per minute considered physically plausible (engineering units / minute). Faster jumps usually indicate a sensor glitch or step disturbance rather than genuine process movement.',
      },
    ],
  },
  {
    title: 'Specification limits',
    fields: [
      {
        key: 'usl',
        label: 'USL',
        info: 'Upper specification limit — the maximum value the product/process requirement allows. A customer/engineering requirement, not a statistically derived control limit.',
      },
      {
        key: 'lsl',
        label: 'LSL',
        info: 'Lower specification limit — the minimum value the product/process requirement allows. A customer/engineering requirement, not a statistically derived control limit.',
      },
      {
        key: 'target',
        label: 'Target',
        info: 'The nominal value the specification is centered on. Used by capability metrics (e.g. Cpm) and drawn as a reference line.',
      },
    ],
  },
  {
    title: 'Physical / plausible range',
    fields: [
      {
        key: 'physicalMin',
        label: 'Physical min',
        info: 'The smallest value the sensor can plausibly report. Readings below it are treated as invalid / out-of-range during signal validation.',
      },
      {
        key: 'physicalMax',
        label: 'Physical max',
        info: 'The largest value the sensor can plausibly report. Readings above it are treated as invalid / out-of-range during signal validation.',
      },
      {
        key: 'sensorUncertainty',
        label: 'Sensor uncertainty',
        info: 'The measurement uncertainty (± engineering units) of the sensor. Used to avoid alerting on changes smaller than the instrument can reliably resolve.',
      },
    ],
  },
  {
    title: 'Monitoring defaults',
    fields: [
      {
        key: 'recommendedAlertThreshold',
        label: 'Recommended alert threshold',
        info: 'A default threshold suggested when creating alerts for this signal, so operators start from a governed value instead of guessing.',
      },
      {
        key: 'recommendedConfidence',
        label: 'Recommended confidence',
        info: 'The default confidence (0–1) for the normal-behavior band used by Monitor and deviation detection. Higher values widen the band and reduce alerts.',
      },
    ],
  },
];

/** Info copy for the non-numeric fields (name, SPC binding, notes) + the selector. */
const FIELD_INFO = {
  signal: 'Choose the signal to govern. The picker is hierarchy-aware — search by name or drill through the asset hierarchy (plant / area / line / …) to find the right tag in context.',
  name: 'An optional human-friendly label for this metadata record. Helpful when a signal accumulates several governed revisions over time.',
  activeBaseline: 'The approved SPC baseline that supplies this signal’s control limits (UCL / LCL / center line). Create and approve baselines on the Control chart page, then bind one here.',
  preferredChartType: 'The control-chart family used by default for this signal: Individuals & Moving Range for single readings, or X̄-R / X̄-S when readings arrive in rational subgroups.',
  ruleProfile: 'The default special-cause rule set (e.g. Nelson, Western Electric) applied when charting this signal. Broader profiles catch smaller shifts sooner but raise the false-alarm rate.',
  notes: 'Free-form rationale, data source, or operating context for these values — captured so future reviewers understand why the limits were set.',
} as const;

const CHART_TYPES: { value: ControlChartType; label: string }[] = [
  { value: 'i-mr', label: 'I-MR (individuals)' },
  { value: 'xbar-r', label: 'X̄-R (subgroup range)' },
  { value: 'xbar-s', label: 'X̄-S (subgroup stddev)' },
];

type FormState = Record<NumericKey, string> & {
  name: string;
  notes: string;
  preferredChartType: string;
  ruleProfile: string;
  activeBaselineId: string;
};

const EMPTY_FORM: FormState = {
  operatingSetpoint: '',
  upperOperatingLimit: '',
  lowerOperatingLimit: '',
  maxRateOfChange: '',
  usl: '',
  lsl: '',
  target: '',
  physicalMin: '',
  physicalMax: '',
  sensorUncertainty: '',
  recommendedAlertThreshold: '',
  recommendedConfidence: '',
  name: '',
  notes: '',
  preferredChartType: '',
  ruleProfile: '',
  activeBaselineId: '',
};

const NUMERIC_KEYS: NumericKey[] = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

function numToStr(v: number | undefined): string {
  return v == null ? '' : String(v);
}

function viewToForm(v: SignalMetadataView): FormState {
  const f: FormState = { ...EMPTY_FORM };
  for (const k of NUMERIC_KEYS) f[k] = numToStr(v[k]);
  f.name = v.name ?? '';
  f.notes = v.notes ?? '';
  f.preferredChartType = v.preferredChartType ?? '';
  f.ruleProfile = v.ruleProfile ?? '';
  f.activeBaselineId = v.activeBaselineId ?? '';
  return f;
}

function strToNum(s: string): number | undefined {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function formToValues(f: FormState): SignalMetadataValues {
  const values: SignalMetadataValues = {
    name: f.name.trim() || undefined,
    notes: f.notes.trim() || undefined,
    preferredChartType: f.preferredChartType || undefined,
    ruleProfile: f.ruleProfile || undefined,
    activeBaselineId: f.activeBaselineId || undefined,
  };
  for (const k of NUMERIC_KEYS) values[k] = strToNum(f[k]);
  return values;
}

const STATUS_COLOR: Record<SignalMetadataStatus, 'brand' | 'success' | 'subtle'> = {
  draft: 'brand',
  approved: 'success',
  retired: 'subtle',
};

/** Human-readable label for a stored preferred-chart-type key. */
function chartTypeLabel(v: string | undefined): string {
  if (!v) return '';
  return CHART_TYPES.find((c) => c.value === v)?.label ?? v;
}

/** Human-readable label for a stored rule-profile key. */
function ruleProfileLabel(v: string | undefined): string {
  if (!v) return '';
  return RULE_PROFILES[v]?.label ?? v;
}

export interface SignalMetadataPageProps {
  tags: TagInfo[];
}

/**
 * Signal Metadata Manager — the governed editor for per-tag process-health
 * metadata (operating/spec/physical limits, setpoint, rate limit, SPC binding and
 * monitoring defaults). Records follow a draft → approve → revise/retire lifecycle
 * with an append-only audit trail, mirroring the SPC baseline governance model.
 * These values are shared org-wide (read) and surface as first-class `TagInfo`
 * fields consumed by every analysis page and the AI agent.
 */
export function SignalMetadataPage({ tags }: SignalMetadataPageProps) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const { activeProfile } = useProfile();
  const levels = useMemo(() => getHierarchyLevels(activeProfile?.labels), [activeProfile]);

  const [view, setView] = useState<'editor' | 'table'>('editor');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [records, setRecords] = useState<SignalMetadataView[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [baselines, setBaselines] = useState<SpcBaselineView[]>([]);

  const tagById = useMemo(() => new Map(tags.map((t) => [t.tagId, t])), [tags]);

  // Governed metadata is keyed by signal id, and the page must show each
  // configured signal's name + hierarchy path plus the catalog total. Neither can
  // rely on the whole `tags` array being present (large catalogs don't load it),
  // so we resolve the bounded set of configured/selected ids through the catalog
  // cache and prefer it, falling back to the in-memory array. In small mode the
  // array already holds everything, so behavior is identical.
  const { getTag, resolveIds, approxCount } = useCatalog();
  const tagInfoFor = useCallback(
    (id: string): TagInfo | undefined => getTag(id) ?? tagById.get(id),
    [getTag, tagById],
  );
  const nameFor = useCallback(
    (id: string): string | undefined => tagInfoFor(id)?.tagName,
    [tagInfoFor],
  );

  // Effective (newest approved, else newest draft) record per signal, for badges + editing.
  const effectiveBySignal = useMemo(() => {
    const map = new Map<string, SignalMetadataView>();
    for (const r of [...records].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
      if (r.status === 'retired') continue;
      const cur = map.get(r.signalId);
      if (!cur) {
        map.set(r.signalId, r);
        continue;
      }
      const better =
        (r.status === 'approved' && cur.status !== 'approved') ||
        (r.status === cur.status && r.version > cur.version);
      if (better) map.set(r.signalId, r);
    }
    return map;
  }, [records]);

  // Ensure the catalog cache holds name + hierarchy metadata for every signal
  // this page renders (all configured signals, plus the one being edited), so
  // labels and paths resolve even when the full `tags` array isn't loaded.
  useEffect(() => {
    const ids = [...effectiveBySignal.keys()];
    if (selectedTag) ids.push(selectedTag);
    if (ids.length > 0) resolveIds(ids);
  }, [effectiveBySignal, selectedTag, resolveIds]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecords(await listSignalMetadata(undefined, activeProfile?.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeProfile?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = selectedTag ? effectiveBySignal.get(selectedTag) : undefined;
  const tagVersions = useMemo(
    () =>
      selectedTag
        ? records.filter((r) => r.signalId === selectedTag).sort((a, b) => b.version - a.version)
        : [],
    [records, selectedTag],
  );

  // Load the editor form whenever the selected tag / its effective record changes.
  useEffect(() => {
    if (!selectedTag) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm(current ? viewToForm(current) : EMPTY_FORM);
  }, [selectedTag, current]);

  // Load approved baselines for the selected tag (for SPC binding + seed).
  useEffect(() => {
    if (!selectedTag) {
      setBaselines([]);
      return;
    }
    let cancelled = false;
    listBaselines(selectedTag)
      .then((bs) => {
        if (!cancelled) setBaselines(bs);
      })
      .catch(() => {
        if (!cancelled) setBaselines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTag]);

  // Signals that carry at least one non-retired governed record.
  const configuredCount = effectiveBySignal.size;

  // Tabular model over every configured signal: hierarchy path + all settings.
  // Shared by the on-page grid and the CSV export so both always match.
  const tableData: ChartData = useMemo(() => {
    const columns = [
      'Signal',
      'Path',
      'Status',
      'Version',
      'Setpoint',
      'Upper op limit',
      'Lower op limit',
      'Max rate/min',
      'USL',
      'LSL',
      'Target',
      'Physical min',
      'Physical max',
      'Sensor uncertainty',
      'Rec. alert threshold',
      'Rec. confidence',
      'Preferred chart',
      'Rule profile',
      'Active baseline',
      'Label',
      'Notes',
      'Approved by',
      'Updated',
    ];
    const rows = [...effectiveBySignal.values()]
      .sort((a, b) =>
        labeler(a.signalId, nameFor(a.signalId)).localeCompare(
          labeler(b.signalId, nameFor(b.signalId)),
        ),
      )
      .map((r): (string | number | null)[] => {
        const tag = tagInfoFor(r.signalId);
        const path = tag ? buildTagPath(tag, levels) : '';
        return [
          labeler(r.signalId, nameFor(r.signalId)),
          path,
          r.status,
          r.version,
          r.operatingSetpoint ?? null,
          r.upperOperatingLimit ?? null,
          r.lowerOperatingLimit ?? null,
          r.maxRateOfChange ?? null,
          r.usl ?? null,
          r.lsl ?? null,
          r.target ?? null,
          r.physicalMin ?? null,
          r.physicalMax ?? null,
          r.sensorUncertainty ?? null,
          r.recommendedAlertThreshold ?? null,
          r.recommendedConfidence ?? null,
          chartTypeLabel(r.preferredChartType),
          ruleProfileLabel(r.ruleProfile),
          r.activeBaselineId ?? '',
          r.name ?? '',
          r.notes ?? '',
          r.approvedBy ?? '',
          r.updatedAt.toLocaleString(),
        ];
      });
    return { columns, rows };
  }, [effectiveBySignal, tagInfoFor, levels, labeler, nameFor]);

  const onExportCsv = () => {
    downloadText(`signal-metadata_${fileStamp()}.csv`, chartDataToCsv(tableData));
  };

  const setField = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const clearBanners = () => {
    setError(null);
    setInfo(null);
  };

  const guard = async (fn: () => Promise<void>, successMsg: string) => {
    setBusy(true);
    clearBanners();
    try {
      await fn();
      await reload();
      setInfo(successMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveDraft = () =>
    guard(async () => {
      if (!selectedTag) return;
      const values = formToValues(form);
      if (current && current.status === 'draft') {
        await updateDraftSignalMetadata(current, values);
      } else if (current && current.status === 'approved') {
        await reviseSignalMetadata(current, values);
      } else {
        await saveSignalMetadata({ signalId: selectedTag, scopeKey: activeProfile?.id, ...values });
      }
    }, 'Draft saved.');

  const onApprove = () =>
    guard(async () => {
      if (!current) return;
      // Persist any pending edits into the draft before freezing it.
      if (current.status === 'draft') {
        await updateDraftSignalMetadata(current, formToValues(form));
        const fresh = (await listSignalMetadata(current.signalId)).find((r) => r.id === current.id);
        await approveSignalMetadata(fresh ?? current);
      }
    }, 'Metadata approved.');

  const onRetire = () =>
    guard(async () => {
      if (current) await retireSignalMetadata(current);
    }, 'Metadata retired.');

  const onSeedFromBaseline = () => {
    const approved = baselines.find((b) => b.status === 'approved') ?? baselines[0];
    if (!approved) {
      setError('No SPC baseline found for this tag. Create/approve one on the Control chart page first.');
      return;
    }
    setForm((f) => ({
      ...f,
      activeBaselineId: approved.id,
      preferredChartType: approved.chartType,
      ruleProfile: approved.ruleProfile,
      usl: f.usl || numToStr(approved.usl),
      lsl: f.lsl || numToStr(approved.lsl),
      target: f.target || numToStr(approved.target),
      operatingSetpoint: f.operatingSetpoint || numToStr(approved.centerLine),
    }));
    setInfo(`Seeded from baseline "${approved.name}" (v${approved.version}, ${approved.status}). Review, then save a draft.`);
  };

  const onSuggestFromData = () =>
    guard(async () => {
      if (!selectedTag) return;
      const range = defaultRange();
      const bin = chooseBinFor({ start: range.start, end: range.end }, DEFAULT_BINNING_SETTINGS);
      const table = await executeKql(
        buildSignalProfileQuery({
          tagId: selectedTag,
          start: range.start,
          end: range.end,
          binKql: bin.kql,
        }),
      );
      const [profile] = rowsToObjects<{
        Count: number | null;
        Min: number | null;
        Max: number | null;
        Mean: number | null;
        Stdev: number | null;
        MaxRatePerMin: number | null;
      }>(table);
      if (
        !profile ||
        profile.Count == null ||
        profile.Count < 5 ||
        profile.Mean == null ||
        profile.Stdev == null ||
        profile.Min == null ||
        profile.Max == null
      ) {
        throw new Error('Not enough data in the default window to derive suggestions.');
      }
      const mean = profile.Mean;
      const sd = profile.Stdev;
      const min = profile.Min;
      const max = profile.Max;
      // Max |rate of change| per minute across consecutive bins (computed server-side).
      const maxRate = profile.MaxRatePerMin ?? 0;
      setForm((f) => ({
        ...f,
        operatingSetpoint: f.operatingSetpoint || mean.toFixed(4),
        upperOperatingLimit: f.upperOperatingLimit || (mean + 3 * sd).toFixed(4),
        lowerOperatingLimit: f.lowerOperatingLimit || (mean - 3 * sd).toFixed(4),
        physicalMin: f.physicalMin || min.toFixed(4),
        physicalMax: f.physicalMax || max.toFixed(4),
        maxRateOfChange: f.maxRateOfChange || maxRate.toFixed(4),
      }));
      setInfo('Suggested operating envelope from recent data (mean ± 3σ, observed range). Review, then save a draft.');
    }, 'Suggestions applied.');

  const readOnlyApproved = current?.status === 'approved';

  return (
    <div className={styles.root}>
      <Subtitle1>Signal metadata</Subtitle1>

      <PageIntro
        title="Signal metadata"
        overview="Define the governed, org-wide 'normal / healthy' envelope for each signal: operating and specification limits, setpoint, rate limit, plausible physical range, preferred control-chart profile, and monitoring defaults."
        interpretation="These values become defaults across every analysis (control charts, alerts, forecasts, what-if, deviations, signal validation) and inform the AI agent — so limits are entered once, governed, and consistent everywhere instead of re-typed per page."
        technical="Records follow a draft → approve → revise/retire lifecycle with an append-only audit trail. Approved values are immutable; editing an approved record creates a new version. Stored in the Fabric App SQL database, mirrored to OneLake, and surfaced to the catalog via a KQL external table joined into the metadata base query."
      />

      {error && (
        <ErrorMessageBar error={error} />
      )}
      {info && (
        <MessageBar intent="success">
          <MessageBarBody>{info}</MessageBarBody>
        </MessageBar>
      )}

      <TabList
        selectedValue={view}
        onTabSelect={(_, d) => setView(d.value as 'editor' | 'table')}
      >
        <Tab value="editor">Editor</Tab>
        <Tab value="table">{`All metadata (${configuredCount})`}</Tab>
      </TabList>

      {view === 'editor' ? (
        <div className={styles.editor}>
          <div className={styles.selectorRow}>
            <div className={styles.selector}>
              <TagSelect
                label="Signal"
                tags={tags}
                selected={selectedTag ? [selectedTag] : []}
                onChange={(ids) => setSelectedTag(ids[0] ?? null)}
                info={FIELD_INFO.signal}
              />
            </div>
            <div className={styles.coverage}>
              <Caption1>
                {`${configuredCount} of ${tags.length > 0 ? tags.length : (approxCount ?? 0)} signals have governed metadata.`}
              </Caption1>
              {loading && <Spinner size="tiny" label="Loading metadata…" />}
            </div>
          </div>

          {selectedTag ? (
            <>
              <Card className={styles.card}>
                <div className={styles.cardHead}>
                  <Subtitle2>{labeler(selectedTag, nameFor(selectedTag))}</Subtitle2>
                  {current && (
                    <Badge appearance="tint" color={STATUS_COLOR[current.status]}>
                      {current.status} · v{current.version}
                    </Badge>
                  )}
                  {!current && <Badge appearance="outline">No metadata yet</Badge>}
                  <div className={styles.spacer} />
                </div>

                {readOnlyApproved && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      This record is approved and immutable. Editing the fields and saving will create a new draft
                      version that supersedes it once approved.
                    </MessageBarBody>
                  </MessageBar>
                )}

                <div className={styles.seedRow}>
                  <Text weight="semibold">Seed:</Text>
                  <Button size="small" disabled={busy} onClick={onSeedFromBaseline}>
                    Import from SPC baseline
                  </Button>
                  <Button size="small" disabled={busy} onClick={onSuggestFromData}>
                    Suggest from data
                  </Button>
                  {busy && <Spinner size="tiny" />}
                </div>

                <Field label={withInfo('Name / label', FIELD_INFO.name)}>
                  <Input value={form.name} onChange={(_, d) => setField('name', d.value)} placeholder="Optional label" />
                </Field>

                {FIELD_GROUPS.map((group) => (
                  <div key={group.title}>
                    <Caption1 className={styles.sectionLabel}>{group.title}</Caption1>
                    <div className={styles.grid}>
                      {group.fields.map((f) => (
                        <Field key={f.key} label={withInfo(f.label, f.info)}>
                          <Input
                            type="number"
                            value={form[f.key]}
                            placeholder="none"
                            onChange={(_, d) => setField(f.key, d.value)}
                          />
                        </Field>
                      ))}
                    </div>
                  </div>
                ))}

                <Caption1 className={styles.sectionLabel}>SPC binding</Caption1>
                <div className={styles.grid}>
                  <Field label={withInfo('Active SPC baseline', FIELD_INFO.activeBaseline)}>
                    <Dropdown
                      value={
                        form.activeBaselineId
                          ? baselines.find((b) => b.id === form.activeBaselineId)?.name ?? form.activeBaselineId
                          : 'None'
                      }
                      selectedOptions={form.activeBaselineId ? [form.activeBaselineId] : ['']}
                      onOptionSelect={(_, d) => setField('activeBaselineId', d.optionValue ?? '')}
                    >
                      <Option value="">None</Option>
                      {baselines.map((b) => (
                        <Option key={b.id} value={b.id}>
                          {`${b.name} (v${b.version}, ${b.status})`}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label={withInfo('Preferred chart type', FIELD_INFO.preferredChartType)}>
                    <Dropdown
                      value={chartTypeLabel(form.preferredChartType) || 'None'}
                      selectedOptions={form.preferredChartType ? [form.preferredChartType] : ['']}
                      onOptionSelect={(_, d) => setField('preferredChartType', d.optionValue ?? '')}
                    >
                      <Option value="">None</Option>
                      {CHART_TYPES.map((c) => (
                        <Option key={c.value} value={c.value}>
                          {c.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field label={withInfo('Rule profile', FIELD_INFO.ruleProfile)}>
                    <Dropdown
                      value={ruleProfileLabel(form.ruleProfile) || 'None'}
                      selectedOptions={form.ruleProfile ? [form.ruleProfile] : ['']}
                      onOptionSelect={(_, d) => setField('ruleProfile', d.optionValue ?? '')}
                    >
                      <Option value="">None</Option>
                      {Object.entries(RULE_PROFILES).map(([key, p]) => (
                        <Option key={key} value={key}>
                          {p.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                </div>

                <Field label={withInfo('Notes', FIELD_INFO.notes)}>
                  <Textarea
                    value={form.notes}
                    onChange={(_, d) => setField('notes', d.value)}
                    placeholder="Rationale, source, or operating context for these limits."
                    rows={3}
                  />
                </Field>

                <Divider />
                <div className={styles.actions}>
                  <Button appearance="primary" disabled={busy} onClick={onSaveDraft}>
                    {current?.status === 'approved' ? 'Save as new draft' : 'Save draft'}
                  </Button>
                  {current?.status === 'draft' && (
                    <Button appearance="secondary" disabled={busy} onClick={onApprove}>
                      Approve
                    </Button>
                  )}
                  {current && current.status !== 'retired' && (
                    <Button appearance="subtle" disabled={busy} onClick={onRetire}>
                      Retire
                    </Button>
                  )}
                </div>
              </Card>

              {tagVersions.length > 0 && (
                <Card className={styles.card}>
                  <Subtitle2>Version history &amp; audit</Subtitle2>
                  {tagVersions.map((v) => (
                    <div key={v.id}>
                      <div className={styles.cardHead}>
                        <Badge appearance="tint" color={STATUS_COLOR[v.status]}>
                          v{v.version} · {v.status}
                        </Badge>
                        {v.approvedBy && <Caption1>Approved by {v.approvedBy}</Caption1>}
                        <div className={styles.spacer} />
                        <Caption1>{v.updatedAt.toLocaleString()}</Caption1>
                      </div>
                      <div className={styles.audit}>
                        {v.audit.map((a, i) => (
                          <Caption1 key={i}>
                            {a.action} — {a.by} · {new Date(a.at).toLocaleString()}
                            {a.note ? ` · ${a.note}` : ''}
                          </Caption1>
                        ))}
                      </div>
                      <Divider />
                    </div>
                  ))}
                </Card>
              )}
            </>
          ) : (
            <Card className={styles.card}>
              <Body1>Select a signal above to view or edit its governed metadata.</Body1>
            </Card>
          )}
        </div>
      ) : (
        <Card className={styles.card}>
          <div className={styles.tableHead}>
            <Subtitle2>Configured signal metadata</Subtitle2>
            <Badge appearance="tint">{configuredCount}</Badge>
            <div className={styles.spacer} />
            <Button
              appearance="secondary"
              icon={<ArrowDownloadRegular />}
              disabled={tableData.rows.length === 0}
              onClick={onExportCsv}
            >
              Export CSV
            </Button>
          </div>
          <Caption1>
            One row per configured signal, showing its hierarchy path and every governed setting. Retired records
            are excluded; when both a draft and an approved record exist, the approved one is shown.
          </Caption1>
          {loading && <Spinner size="tiny" label="Loading metadata…" />}
          {tableData.rows.length === 0 ? (
            <Body1>No signal metadata has been configured yet. Use the Editor tab to govern a signal.</Body1>
          ) : (
            <DataTable data={tableData} pageSize={50} />
          )}
        </Card>
      )}
    </div>
  );
}
