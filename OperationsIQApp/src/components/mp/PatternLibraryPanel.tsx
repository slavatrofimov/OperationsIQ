import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Input,
  Option,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSortUpRegular,
  ArrowSortDownRegular,
  DeleteRegular,
  OpenRegular,
  Search20Regular,
} from '@fluentui/react-icons';
import type { Label, LabelCategory, JobType } from '../../lib/mp/types';
import { jobTypeLabel } from '../../lib/mp/naming';
import {
  filterLibrary,
  libraryAnalysisTypes,
  librarySignals,
  patternDuration,
  patternName,
  sortLibrary,
  type LibraryFilter,
  type LibrarySortDir,
  type LibrarySortKey,
} from '../../lib/mp/patternLibrary';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
  filter: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  filterLabel: { color: tokens.colorNeutralForeground3 },
  grow: { flex: 1, minWidth: '180px' },
  sortRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  swatch: { width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3 },
  cardActions: { display: 'flex', gap: tokens.spacingHorizontalXS, marginTop: tokens.spacingVerticalXS },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalL },
  subtle: { color: tokens.colorNeutralForeground3 },
});

export interface PatternLibraryPanelProps {
  patterns: Label[];
  categories: LabelCategory[];
  labelFor?: (signalId: string) => string;
  onOpenRun?: (jobId: string) => void;
  onDelete?: (id: string) => void;
  /**
   * Resolve a saved pattern's originating run id to its analysis type. Enables the
   * "Analysis type" filter (patterns store only a `jobId`, so the type is looked up against
   * the run history). Omit to hide the analysis-type filter.
   */
  jobTypeFor?: (jobId?: string) => JobType | undefined;
  /**
   * Pre-select the analysis-type filter (e.g. so an analysis page's "Saved patterns" tab
   * shows only patterns of that page's analysis type). Defaults to "all".
   */
  initialAnalysisType?: JobType | 'all';
}

/**
 * Pattern library — a browsable, searchable gallery of every saved pattern across all runs.
 * Each saved pattern carries its provenance (source signal, originating run, location, kind,
 * category, saved date), so analysts can find and reuse patterns independent of the run they
 * came from. Built entirely on the existing Labels store.
 */
export function PatternLibraryPanel({
  patterns,
  categories,
  labelFor = (id) => id,
  onOpenRun,
  onDelete,
  jobTypeFor,
  initialAnalysisType = 'all',
}: PatternLibraryPanelProps) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<LibraryFilter['kind']>('all');
  const [category, setCategory] = useState<string>('all');
  const [signalId, setSignalId] = useState<string>('all');
  const [analysisType, setAnalysisType] = useState<JobType | 'all'>(initialAnalysisType);
  const [sortKey, setSortKey] = useState<LibrarySortKey>('date');
  const [sortDir, setSortDir] = useState<LibrarySortDir>('desc');

  // Re-sync the analysis-type filter when the host pre-selects a different type (e.g.
  // navigating between analysis pages that each represent a distinct analysis type).
  useEffect(() => {
    setAnalysisType(initialAnalysisType);
  }, [initialAnalysisType]);

  const categoryName = (id?: string) =>
    (id && categories.find((c) => c.id === id)?.name) || id || 'Uncategorized';
  const categoryColor = (id?: string) =>
    (id && categories.find((c) => c.id === id)?.color) || tokens.colorNeutralForeground3;

  // Resolve a saved pattern to its originating analysis type (via its run id).
  const typeForLabel = useMemo(
    () => (l: Label) => jobTypeFor?.(l.jobId),
    [jobTypeFor],
  );

  const signals = useMemo(() => librarySignals(patterns), [patterns]);
  const analysisTypes = useMemo(
    () => (jobTypeFor ? libraryAnalysisTypes(patterns, typeForLabel) : []),
    [patterns, jobTypeFor, typeForLabel],
  );
  const showAnalysisType = typeof jobTypeFor === 'function';

  const visible = useMemo(() => {
    const filtered = filterLibrary(
      patterns,
      { text, kind, category, signalId, analysisType },
      labelFor,
      typeForLabel,
    );
    return sortLibrary(filtered, sortKey, sortDir, labelFor);
  }, [patterns, text, kind, category, signalId, analysisType, sortKey, sortDir, labelFor, typeForLabel]);

  const toggleDir = () => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={`${styles.filter} ${styles.grow}`}>
          <Caption1 className={styles.filterLabel}>Search</Caption1>
          <Input
            value={text}
            onChange={(_, d) => setText(d.value)}
            contentBefore={<Search20Regular />}
            placeholder="Search saved patterns"
          />
        </div>
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Kind</Caption1>
          <Dropdown
            value={kind === 'all' ? 'All kinds' : kind === 'MOTIF' ? 'Patterns' : 'Anomalies'}
            selectedOptions={[kind ?? 'all']}
            onOptionSelect={(_, d) => setKind((d.optionValue as LibraryFilter['kind']) ?? 'all')}
          >
            <Option value="all">All kinds</Option>
            <Option value="MOTIF">Patterns</Option>
            <Option value="DISCORD">Anomalies</Option>
          </Dropdown>
        </div>
        {showAnalysisType && (
          <div className={styles.filter}>
            <Caption1 className={styles.filterLabel}>Analysis type</Caption1>
            <Dropdown
              value={analysisType === 'all' ? 'All analysis types' : jobTypeLabel(analysisType)}
              selectedOptions={[analysisType]}
              onOptionSelect={(_, d) =>
                setAnalysisType((d.optionValue as JobType | 'all') ?? 'all')
              }
            >
              <Option value="all">All analysis types</Option>
              {analysisTypes.map((t) => (
                <Option key={t} value={t}>
                  {jobTypeLabel(t)}
                </Option>
              ))}
            </Dropdown>
          </div>
        )}
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Category</Caption1>
          <Dropdown
            value={category === 'all' ? 'All categories' : categoryName(category)}
            selectedOptions={[category]}
            onOptionSelect={(_, d) => setCategory((d.optionValue as string) ?? 'all')}
          >
            <Option value="all">All categories</Option>
            {categories.map((c) => (
              <Option key={c.id} value={c.id}>
                {c.name}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Signal</Caption1>
          <Dropdown
            value={signalId === 'all' ? 'All signals' : labelFor(signalId)}
            selectedOptions={[signalId]}
            onOptionSelect={(_, d) => setSignalId((d.optionValue as string) ?? 'all')}
          >
            <Option value="all">All signals</Option>
            {signals.map((s) => (
              <Option key={s} value={s}>
                {labelFor(s)}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Sort by</Caption1>
          <div className={styles.sortRow}>
            <Dropdown
              value={{ date: 'Date saved', name: 'Name', kind: 'Kind', signal: 'Signal' }[sortKey]}
              selectedOptions={[sortKey]}
              onOptionSelect={(_, d) => setSortKey((d.optionValue as LibrarySortKey) ?? 'date')}
            >
              <Option value="date">Date saved</Option>
              <Option value="name">Name</Option>
              <Option value="kind">Kind</Option>
              <Option value="signal">Signal</Option>
            </Dropdown>
            <Button
              appearance="subtle"
              size="small"
              icon={sortDir === 'asc' ? <ArrowSortUpRegular /> : <ArrowSortDownRegular />}
              aria-label={sortDir === 'asc' ? 'Ascending' : 'Descending'}
              onClick={toggleDir}
            />
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <Text className={styles.empty}>
          {patterns.length === 0
            ? 'No saved patterns yet — label a pattern from a run to add it here.'
            : 'No saved patterns match the current filters.'}
        </Text>
      ) : (
        <>
          <div className={styles.grid}>
            {visible.map((p) => (
              <div key={p.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <div className={styles.titleRow}>
                    {p.color && <div className={styles.swatch} style={{ background: p.color }} />}
                    <Text weight="semibold" truncate wrap={false}>
                      {patternName(p)}
                    </Text>
                  </div>
                  <Badge
                    appearance="tint"
                    size="small"
                    color={p.kind === 'MOTIF' ? 'success' : 'danger'}
                  >
                    {p.kind === 'MOTIF' ? 'Pattern' : 'Anomaly'}
                  </Badge>
                </div>
                <Caption1 className={styles.meta}>{labelFor(p.signalId)}</Caption1>
                <Caption1 className={styles.meta} style={{ color: categoryColor(p.category) }}>
                  {categoryName(p.category)}
                  {typeof p.confidence === 'number' ? ` · ${Math.round(p.confidence * 100)}% confidence` : ''}
                </Caption1>
                <Caption1 className={styles.meta}>
                  at sample {p.startIndex} · {p.length} samples
                  {patternDuration(p) ? ` · ${patternDuration(p)}` : ''}
                  {p.createdAt ? ` · saved ${new Date(p.createdAt).toLocaleDateString()}` : ''}
                </Caption1>
                <div className={styles.cardActions}>
                  {onOpenRun && p.jobId && (
                    <Tooltip content="Open the run this pattern came from" relationship="description">
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<OpenRegular />}
                        onClick={() => onOpenRun(p.jobId as string)}
                      >
                        Open run
                      </Button>
                    </Tooltip>
                  )}
                  {onDelete && (
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<DeleteRegular />}
                      aria-label="Delete saved pattern"
                      onClick={() => onDelete(p.id)}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          <Caption1 className={styles.subtle}>
            {visible.length} of {patterns.length} saved pattern{patterns.length === 1 ? '' : 's'}
          </Caption1>
        </>
      )}
    </div>
  );
}
