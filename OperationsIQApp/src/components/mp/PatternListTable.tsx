import {
  Badge,
  Checkbox,
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
import { TagRegular } from '@fluentui/react-icons';

/** Badge tone for a pattern row (mirrors Fluent Badge colors). */
export type PatternBadgeTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'informative'
  | 'brand'
  | 'subtle';

/** One row in the found-patterns list — a normalized view across pattern kinds. */
export interface PatternRow {
  /** Stable short id, e.g. "M1" / "D2". */
  id: string;
  /** Full id (e.g. P-<run>-M1) shown on hover. */
  fullId?: string;
  /** Short kind/strength label for the badge (e.g. "Strong", "Anomaly"). */
  badge: string;
  /** Badge color tone. */
  tone: PatternBadgeTone;
  /** Key metric text (e.g. "92% consistent", "Severity 78%"). */
  metric: string;
  /** When the pattern starts — timestamp or "@1234". */
  start?: string;
  /** Human-readable duration (e.g. "1 h 20 m"). */
  duration?: string;
}

const useStyles = makeStyles({
  scroll: { overflowX: 'auto', maxHeight: '420px', overflowY: 'auto' },
  table: { width: '100%', tableLayout: 'fixed', minWidth: '500px' },
  colShow: { width: '56px' },
  colId: { width: '64px' },
  colBadge: { width: '96px' },
  colStart: { width: '120px' },
  colDuration: { width: '88px' },
  metricCell: { overflow: 'hidden' },
  id: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2 },
  idCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  tagIcon: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  subtle: { color: tokens.colorNeutralForeground3 },
  nowrap: { whiteSpace: 'nowrap' },
  row: { cursor: 'pointer' },
  rowSelected: { cursor: 'pointer', background: tokens.colorBrandBackground2 },
  showCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  swatch: {
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    flexShrink: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

/**
 * A compact, selectable table of the patterns found in a run — styled to match
 * {@link PatternRunsTable} (fixed layout, native table, truncation) so the run and its
 * results read consistently. Row click selects a pattern to drive the detail pane. When
 * {@link onToggleVisible} is supplied, a leading "Show" column with a color-swatch checkbox
 * lets the analyst toggle each pattern's overlay on the synchronized chart independently of
 * which one is selected for detail.
 */
export function PatternListTable({
  rows,
  selectedId,
  onSelect,
  ariaLabel = 'Found patterns',
  visibleIds,
  onToggleVisible,
  colorForId,
  hasLabels,
}: {
  rows: PatternRow[];
  selectedId?: string;
  onSelect?: (id: string) => void;
  ariaLabel?: string;
  /** Ids whose overlay is currently shown on the chart (checkbox state). */
  visibleIds?: Set<string>;
  /** Toggle a pattern's chart-overlay visibility (enables the "Show" column). */
  onToggleVisible?: (id: string) => void;
  /** Per-pattern overlay color, drawn as a swatch next to the checkbox. */
  colorForId?: (id: string) => string;
  /** Whether a pattern has ≥1 label — shows a tag icon next to its id when true. */
  hasLabels?: (id: string) => boolean;
}) {
  const styles = useStyles();
  if (rows.length === 0) return null;

  const showToggle = typeof onToggleVisible === 'function';
  const showStart = rows.some((r) => r.start);
  const showDuration = rows.some((r) => r.duration);

  return (
    <div className={styles.scroll}>
      <Table size="small" aria-label={ariaLabel} className={styles.table}>
        <TableHeader>
          <TableRow>
            {showToggle && <TableHeaderCell className={styles.colShow}>Show</TableHeaderCell>}
            <TableHeaderCell className={styles.colId}>ID</TableHeaderCell>
            <TableHeaderCell className={styles.colBadge}>Kind</TableHeaderCell>
            <TableHeaderCell>Key metric</TableHeaderCell>
            {showStart && <TableHeaderCell className={styles.colStart}>Start</TableHeaderCell>}
            {showDuration && (
              <TableHeaderCell className={styles.colDuration}>Duration</TableHeaderCell>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const selected = r.id === selectedId;
            return (
              <TableRow
                key={r.id}
                className={selected ? styles.rowSelected : styles.row}
                onClick={() => onSelect?.(r.id)}
                aria-selected={selected}
              >
                {showToggle && (
                  <TableCell className={styles.nowrap}>
                    <div className={styles.showCell} onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={visibleIds ? visibleIds.has(r.id) : true}
                        onChange={() => onToggleVisible?.(r.id)}
                        aria-label={`Show ${r.id} on chart`}
                      />
                      {colorForId && (
                        <span
                          className={styles.swatch}
                          style={{ background: colorForId(r.id) }}
                          aria-hidden
                        />
                      )}
                    </div>
                  </TableCell>
                )}
                <TableCell className={styles.nowrap}>
                  <div className={styles.idCell}>
                    <Tooltip content={r.fullId ?? r.id} relationship="description" withArrow>
                      <Text className={styles.id} size={200}>
                        {r.id}
                      </Text>
                    </Tooltip>
                    {hasLabels?.(r.id) && (
                      <Tooltip content="Labeled" relationship="label" withArrow>
                        <TagRegular className={styles.tagIcon} aria-label="Labeled" />
                      </Tooltip>
                    )}
                  </div>
                </TableCell>
                <TableCell className={styles.nowrap}>
                  <Badge appearance="filled" color={r.tone} size="small">
                    {r.badge}
                  </Badge>
                </TableCell>
                <TableCell className={styles.metricCell}>
                  <Tooltip content={r.metric} relationship="description" withArrow>
                    <TableCellLayout truncate>
                      <Text size={200} truncate wrap={false}>
                        {r.metric}
                      </Text>
                    </TableCellLayout>
                  </Tooltip>
                </TableCell>
                {showStart && (
                  <TableCell className={styles.nowrap}>
                    <Text size={200} className={styles.subtle}>
                      {r.start ?? '—'}
                    </Text>
                  </TableCell>
                )}
                {showDuration && (
                  <TableCell className={styles.nowrap}>
                    <Text size={200} className={styles.subtle}>
                      {r.duration ?? '—'}
                    </Text>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
