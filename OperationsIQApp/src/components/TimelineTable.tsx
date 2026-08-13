import { useMemo } from 'react';
import {
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  TableCellLayout,
  Checkbox,
  Badge,
  Button,
  Caption1,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Edit16Regular, Delete16Regular } from '@fluentui/react-icons';
import type { TimelineMarker, MarkerTypeGroup } from '../lib/timelineMarkers';
import { formatQueryInstant } from '../lib/timezone';

const useStyles = makeStyles({
  wrapper: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  filters: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
  },
  filterItem: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  scroll: { maxHeight: '300px', overflowY: 'auto', overflowX: 'auto' },
  table: { minWidth: '860px' },
  checkCell: { width: '44px' },
  sourceCell: { width: '96px' },
  timeCell: { minWidth: '150px', whiteSpace: 'normal', overflowWrap: 'break-word' },
  typeCell: { width: '130px' },
  titleCell: { minWidth: '160px', whiteSpace: 'normal', overflowWrap: 'break-word' },
  detailCell: { minWidth: '200px', whiteSpace: 'normal', overflowWrap: 'break-word' },
  scopeCell: { minWidth: '120px', whiteSpace: 'normal', overflowWrap: 'break-word' },
  actionsCell: { width: '96px' },
  detail: { color: tokens.colorNeutralForeground3 },
  swatch: {
    display: 'inline-block',
    width: '10px',
    height: '10px',
    borderRadius: '2px',
    marginRight: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
});

export interface TimelineTableProps {
  /** Markers within the selected time range (already scoped by the caller). */
  markers: TimelineMarker[];
  /** Marker ids individually hidden from the chart. */
  hiddenIds: Set<string>;
  /** Distinct (source, type) groups present across the range, for the filters. */
  typeGroups: MarkerTypeGroup[];
  /** Type-filter keys currently hidden (markerTypeKey values). */
  hiddenTypes: Set<string>;
  onToggle: (id: string, visible: boolean) => void;
  onToggleAll: (visible: boolean) => void;
  onToggleType: (key: string, visible: boolean) => void;
  /** Current user's id, so only the author sees edit/delete on annotations. */
  currentUserId?: string;
  onEdit: (marker: TimelineMarker) => void;
  onDelete: (marker: TimelineMarker) => void;
}

function fmtTime(d: Date): string {
  // Marker times are normalized to query-tick space (see timelineMarkers), so
  // render verbatim as UTC to show the preferred-zone wall clock.
  return formatQueryInstant(d, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Unified, interactive list of the timeline markers (Events UNION Annotations)
 * inside the selected window. Type-filter toggles at the top show/hide whole
 * Event/Annotation types on the chart and list; each row's checkbox toggles a
 * single marker. Annotation rows authored by the current user expose edit and
 * delete actions.
 */
export function TimelineTable({
  markers,
  hiddenIds,
  typeGroups,
  hiddenTypes,
  onToggle,
  onToggleAll,
  onToggleType,
  currentUserId,
  onEdit,
  onDelete,
}: TimelineTableProps) {
  const styles = useStyles();

  const visibleCount = useMemo(
    () => markers.reduce((n, m) => n + (hiddenIds.has(m.id) ? 0 : 1), 0),
    [markers, hiddenIds],
  );
  const allChecked: boolean | 'mixed' =
    visibleCount === 0 ? false : visibleCount === markers.length ? true : 'mixed';

  return (
    <div className={styles.wrapper}>
      {typeGroups.length > 0 && (
        <div className={styles.filters}>
          <Caption1>Show types:</Caption1>
          {typeGroups.map((g) => (
            <span key={g.key} className={styles.filterItem}>
              <Checkbox
                checked={!hiddenTypes.has(g.key)}
                onChange={(_, d) => onToggleType(g.key, d.checked === true)}
                label={
                  <span className={styles.filterItem}>
                    <span className={styles.swatch} style={{ backgroundColor: g.color }} />
                    {g.type}
                    <Badge appearance="tint" size="small">
                      {g.count}
                    </Badge>
                    <Caption1 className={styles.detail}>
                      {g.source === 'annotation' ? 'annotation' : 'event'}
                    </Caption1>
                  </span>
                }
              />
            </span>
          ))}
        </div>
      )}

      {markers.length === 0 ? (
        <Caption1>No events or annotations in the selected time range.</Caption1>
      ) : (
        <>
          <Caption1>
            {visibleCount} of {markers.length} item(s) shown in the selected range.
          </Caption1>
          <div className={styles.scroll}>
            <Table size="small" className={styles.table} aria-label="Timeline markers in selected range">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={styles.checkCell}>
                    <Checkbox
                      checked={allChecked}
                      aria-label="Show or hide all markers"
                      onChange={(_, d) => onToggleAll(d.checked === true)}
                    />
                  </TableHeaderCell>
                  <TableHeaderCell className={styles.sourceCell}>Source</TableHeaderCell>
                  <TableHeaderCell className={styles.timeCell}>Time</TableHeaderCell>
                  <TableHeaderCell className={styles.typeCell}>Type</TableHeaderCell>
                  <TableHeaderCell className={styles.titleCell}>Title</TableHeaderCell>
                  <TableHeaderCell className={styles.detailCell}>Detail</TableHeaderCell>
                  <TableHeaderCell className={styles.scopeCell}>Scope</TableHeaderCell>
                  <TableHeaderCell className={styles.actionsCell}>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {markers.map((m) => {
                  const visible = !hiddenIds.has(m.id);
                  const isAuthor =
                    m.source === 'annotation' &&
                    !!currentUserId &&
                    m.authorId === currentUserId;
                  return (
                    <TableRow key={m.id}>
                      <TableCell className={styles.checkCell}>
                        <Checkbox
                          checked={visible}
                          aria-label={`Show ${m.title} on chart`}
                          onChange={(_, d) => onToggle(m.id, d.checked === true)}
                        />
                      </TableCell>
                      <TableCell className={styles.sourceCell}>
                        <Badge
                          appearance="tint"
                          size="small"
                          color={m.source === 'annotation' ? 'brand' : 'informative'}
                        >
                          {m.source === 'annotation' ? 'Annotation' : 'Event'}
                        </Badge>
                      </TableCell>
                      <TableCell className={styles.timeCell}>
                        <TableCellLayout>
                          <span className={styles.swatch} style={{ backgroundColor: m.color }} />
                          {fmtTime(m.timestamp)}
                          {m.endTimestamp ? ` \u2013 ${fmtTime(m.endTimestamp)}` : ''}
                        </TableCellLayout>
                      </TableCell>
                      <TableCell className={styles.typeCell}>{m.type}</TableCell>
                      <TableCell className={styles.titleCell}>{m.title}</TableCell>
                      <TableCell className={mergeClasses(styles.detail, styles.detailCell)}>
                        {m.detail ?? ''}
                      </TableCell>
                      <TableCell className={styles.scopeCell}>{m.scopeLabel}</TableCell>
                      <TableCell className={styles.actionsCell}>
                        {isAuthor && (
                          <>
                            <Tooltip content="Edit annotation" relationship="label">
                              <Button
                                appearance="subtle"
                                size="small"
                                icon={<Edit16Regular />}
                                aria-label={`Edit ${m.title}`}
                                onClick={() => onEdit(m)}
                              />
                            </Tooltip>
                            <Tooltip content="Delete annotation" relationship="label">
                              <Button
                                appearance="subtle"
                                size="small"
                                icon={<Delete16Regular />}
                                aria-label={`Delete ${m.title}`}
                                onClick={() => onDelete(m)}
                              />
                            </Tooltip>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
