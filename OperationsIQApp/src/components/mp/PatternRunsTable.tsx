import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Input,
  Option,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowSortRegular,
  ArrowSortUpRegular,
  ArrowSortDownRegular,
  DeleteRegular,
  DismissCircleRegular,
  Search20Regular,
} from '@fluentui/react-icons';
import type { AnalysisJob, JobType } from '../../lib/mp/types';
import { jobTypeLabel, JOB_TYPE_ORDER } from '../../lib/mp/naming';
import { describeJobStatus } from '../../lib/mp/livyStatus';
import {
  filterRuns,
  runDurationLabel,
  runResultCount,
  runTitle,
  shortRunId,
  sortRuns,
  timeAgo,
  type RunFilter,
  type RunSortKey,
  type SortDir,
} from '../../lib/mp/runHistory';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  filter: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  filterLabel: { color: tokens.colorNeutralForeground3 },
  grow: { flex: 1, minWidth: '180px' },
  scroll: { overflowX: 'auto', maxHeight: '560px', overflowY: 'auto' },
  table: { width: '100%', tableLayout: 'fixed', minWidth: '760px' },
  colRun: { width: '92px' },
  colType: { width: '150px' },
  colDate: { width: '104px' },
  colStatus: { width: '104px' },
  colDuration: { width: '104px' },
  colPatterns: { width: '92px' },
  colActions: { width: '48px' },
  nameCell: { overflow: 'hidden' },
  headerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
  },
  runId: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  subtle: { color: tokens.colorNeutralForeground3 },
  row: { cursor: 'pointer' },
  rowSelected: { cursor: 'pointer', background: tokens.colorBrandBackground2 },
  nowrap: { whiteSpace: 'nowrap' },
  empty: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalL },
  approx: { color: tokens.colorNeutralForeground3 },
});

type StatusFilter = AnalysisJob['status'] | 'all';

export interface PatternRunsTableProps {
  jobs: AnalysisJob[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Cancel a still-running / queued run (tears down its Spark session). */
  onCancel?: (id: string) => void;
  /** Initial type filter (e.g. defaulted from a recipe entry point). */
  initialType?: JobType | 'all';
  /** Controlled type filter — when provided the table defers to the parent. */
  typeFilter?: JobType | 'all';
  onTypeFilterChange?: (type: JobType | 'all') => void;
  emptyMessage?: string;
}

function badgeColorFor(tone: ReturnType<typeof describeJobStatus>['tone']) {
  switch (tone) {
    case 'warning':
      return 'warning' as const;
    case 'danger':
      return 'danger' as const;
    case 'success':
      return 'success' as const;
    case 'subtle':
      return 'subtle' as const;
    case 'important':
      return 'important' as const;
    default:
      return 'informative' as const;
  }
}

/**
 * Deep Discovery Runs list — a sortable, filterable table of every pattern-search run,
 * surfacing the metadata analysts need up front: unique id, name, date, type, status,
 * duration, and a best-effort result count. Row click opens the run in the detail view.
 */
export function PatternRunsTable({
  jobs,
  selectedId,
  onSelect,
  onDelete,
  onCancel,
  initialType = 'all',
  typeFilter: typeFilterProp,
  onTypeFilterChange,
  emptyMessage,
}: PatternRunsTableProps) {
  const styles = useStyles();
  const [typeFilterState, setTypeFilterState] = useState<JobType | 'all'>(initialType);
  const typeFilter = typeFilterProp ?? typeFilterState;
  const setTypeFilter = (t: JobType | 'all') => {
    setTypeFilterState(t);
    onTypeFilterChange?.(t);
  };
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [text, setText] = useState('');
  const [sortKey, setSortKey] = useState<RunSortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const availableTypes = useMemo(() => {
    const present = new Set<JobType>(jobs.map((j) => j.type));
    if (typeFilter !== 'all') present.add(typeFilter);
    return JOB_TYPE_ORDER.filter((t) => present.has(t));
  }, [jobs, typeFilter]);

  const visible = useMemo(() => {
    const filter: RunFilter = { type: typeFilter, status: statusFilter, text };
    return sortRuns(filterRuns(jobs, filter), sortKey, sortDir);
  }, [jobs, typeFilter, statusFilter, text, sortKey, sortDir]);

  const toggleSort = (key: RunSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'duration' ? 'desc' : 'asc');
    }
  };

  const sortIcon = (key: RunSortKey) => {
    if (key !== sortKey) return <ArrowSortRegular />;
    return sortDir === 'asc' ? <ArrowSortUpRegular /> : <ArrowSortDownRegular />;
  };

  const header = (key: RunSortKey, label: string) => (
    <button type="button" className={styles.headerButton} onClick={() => toggleSort(key)}>
      {label}
      {sortIcon(key)}
    </button>
  );

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: 'All statuses' },
    { value: 'SUCCEEDED', label: 'Succeeded' },
    { value: 'RUNNING', label: 'Running' },
    { value: 'QUEUED', label: 'Queued' },
    { value: 'FAILED', label: 'Failed' },
    { value: 'CANCELLED', label: 'Cancelled' },
  ];

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={`${styles.filter} ${styles.grow}`}>
          <Caption1 className={styles.filterLabel}>Search</Caption1>
          <Input
            value={text}
            onChange={(_, d) => setText(d.value)}
            contentBefore={<Search20Regular />}
            placeholder="Search by name, id, or type"
          />
        </div>
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Analysis type</Caption1>
          <Dropdown
            value={typeFilter === 'all' ? 'All types' : jobTypeLabel(typeFilter)}
            selectedOptions={[typeFilter]}
            onOptionSelect={(_, d) => setTypeFilter((d.optionValue as JobType | 'all') ?? 'all')}
          >
            <Option value="all">All types</Option>
            {availableTypes.map((t) => (
              <Option key={t} value={t}>
                {jobTypeLabel(t)}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.filter}>
          <Caption1 className={styles.filterLabel}>Status</Caption1>
          <Dropdown
            value={statusOptions.find((o) => o.value === statusFilter)?.label ?? 'All statuses'}
            selectedOptions={[statusFilter]}
            onOptionSelect={(_, d) => setStatusFilter((d.optionValue as StatusFilter) ?? 'all')}
          >
            {statusOptions.map((o) => (
              <Option key={o.value} value={o.value}>
                {o.label}
              </Option>
            ))}
          </Dropdown>
        </div>
      </div>

      {visible.length === 0 ? (
        <Text className={styles.empty}>
          {jobs.length === 0
            ? emptyMessage ?? 'No pattern-search runs yet — start one with “New search”.'
            : 'No runs match the current filters.'}
        </Text>
      ) : (
        <div className={styles.scroll}>
          <Table size="small" aria-label="Pattern search runs" className={styles.table}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={styles.colRun}>Run</TableHeaderCell>
                <TableHeaderCell>{header('name', 'Name')}</TableHeaderCell>
                <TableHeaderCell className={styles.colType}>{header('type', 'Type')}</TableHeaderCell>
                <TableHeaderCell className={styles.colDate}>{header('date', 'Run')}</TableHeaderCell>
                <TableHeaderCell className={styles.colStatus}>{header('status', 'Status')}</TableHeaderCell>
                <TableHeaderCell className={styles.colDuration}>{header('duration', 'Duration')}</TableHeaderCell>
                <TableHeaderCell className={styles.colPatterns}>
                  <Tooltip
                    content="Best-effort count from the run summary (top results). Open a run for the full list."
                    relationship="description"
                    withArrow
                  >
                    <span>Patterns</span>
                  </Tooltip>
                </TableHeaderCell>
                {(onDelete || onCancel) && <TableHeaderCell className={styles.colActions} />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((j) => {
                const view = describeJobStatus(j);
                const dur = runDurationLabel(j);
                const count = runResultCount(j);
                const selected = j.id === selectedId;
                return (
                  <TableRow
                    key={j.id}
                    className={selected ? styles.rowSelected : styles.row}
                    onClick={() => onSelect?.(j.id)}
                  >
                    <TableCell className={styles.nowrap}>
                      <Tooltip content={j.id} relationship="description" withArrow>
                        <Text className={styles.runId} size={200}>
                          {shortRunId(j.id)}
                        </Text>
                      </Tooltip>
                    </TableCell>
                    <TableCell className={styles.nameCell}>
                      <Tooltip content={runTitle(j)} relationship="description" withArrow>
                        <TableCellLayout truncate>
                          <Text weight="semibold" truncate wrap={false}>
                            {runTitle(j)}
                          </Text>
                        </TableCellLayout>
                      </Tooltip>
                    </TableCell>
                    <TableCell className={styles.nowrap}>{jobTypeLabel(j.type)}</TableCell>
                    <TableCell className={styles.nowrap}>
                      <Tooltip
                        content={j.submittedAt ? new Date(j.submittedAt).toLocaleString() : ''}
                        relationship="description"
                      >
                        <Text size={200}>{j.submittedAt ? timeAgo(j.submittedAt) : '—'}</Text>
                      </Tooltip>
                    </TableCell>
                    <TableCell className={styles.nowrap}>
                      <Badge appearance="filled" color={badgeColorFor(view.tone)} size="small">
                        {view.label}
                      </Badge>
                    </TableCell>
                    <TableCell className={styles.nowrap}>{dur ?? '—'}</TableCell>
                    <TableCell className={styles.nowrap}>
                      {count ? (
                        <span>
                          {count.count}
                          {count.approximate && <span className={styles.approx}>+</span>}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    {(onDelete || onCancel) && (
                      <TableCell className={styles.nowrap}>
                        {onCancel && (j.status === 'RUNNING' || j.status === 'QUEUED') ? (
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<DismissCircleRegular />}
                            aria-label="Cancel run"
                            title="Cancel this run and tear down its Spark session"
                            onClick={(e) => {
                              e.stopPropagation();
                              onCancel(j.id);
                            }}
                          />
                        ) : onDelete ? (
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<DeleteRegular />}
                            aria-label="Delete run"
                            title="Delete this run and tear down its Spark session"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete(j.id);
                            }}
                          />
                        ) : null}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <Caption1 className={styles.subtle}>
            {visible.length} of {jobs.length} run{jobs.length === 1 ? '' : 's'}
          </Caption1>
        </div>
      )}
    </div>
  );
}
