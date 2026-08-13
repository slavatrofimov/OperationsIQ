import { useMemo, useState } from 'react';
import {
  Button,
  Caption1,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronLeft20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { ChartData } from '../lib/export';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  scroll: { overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' },
  // Fluent's Table root forces `table-layout: fixed` + `width: 100%`, so with many
  // columns the equal shares squeeze the `nowrap` cells and long headers/values
  // overlap the neighbouring column. `table-layout: auto` + `min-width: max-content`
  // restores content-based sizing; the `.scroll` wrapper adds horizontal scroll.
  table: { minWidth: 'max-content', tableLayout: 'auto' },
  pager: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    justifyContent: 'flex-end',
  },
  spacer: { flex: 1 },
  cell: { whiteSpace: 'nowrap' },
});

/** Format a single cell the same way ResultsTable does (numbers to 6 decimals). */
function formatCell(v: string | number | null): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  return String(v);
}

export interface DataTableProps {
  data: ChartData;
  /** Rows per page (client-side paging). Defaults to 100. */
  pageSize?: number;
}

/**
 * Lightweight, client-side paged table over a ChartData model — the same model
 * the CSV export uses, so the table always reflects the plotted data. Paging
 * keeps the DOM small for series with thousands of points; the full dataset is
 * still available via CSV export.
 */
export function DataTable({ data, pageSize = 100 }: DataTableProps) {
  const styles = useStyles();
  const [page, setPage] = useState(0);

  const total = data.rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount - 1);

  const pageRows = useMemo(
    () => data.rows.slice(current * pageSize, current * pageSize + pageSize),
    [data.rows, current, pageSize],
  );

  const first = total === 0 ? 0 : current * pageSize + 1;
  const last = Math.min(total, current * pageSize + pageSize);

  return (
    <div className={styles.root}>
      <div className={styles.scroll}>
        <Table size="small" aria-label="Chart data" className={styles.table}>
          <TableHeader>
            <TableRow>
              {data.columns.map((c, i) => (
                <TableHeaderCell key={`${c}-${i}`}>{c}</TableHeaderCell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.map((row, r) => (
              <TableRow key={current * pageSize + r}>
                {data.columns.map((_, i) => (
                  <TableCell key={i} className={styles.cell}>
                    {formatCell(row[i] ?? null)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className={styles.pager}>
        <Caption1>
          {total === 0 ? 'No rows' : `${first}\u2013${last} of ${total} rows`}
        </Caption1>
        {pageCount > 1 && (
          <>
            <Button
              appearance="subtle"
              size="small"
              icon={<ChevronLeft20Regular />}
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
              aria-label="Previous page"
            />
            <Caption1>
              {current + 1} / {pageCount}
            </Caption1>
            <Button
              appearance="subtle"
              size="small"
              icon={<ChevronRight20Regular />}
              disabled={current >= pageCount - 1}
              onClick={() => setPage(current + 1)}
              aria-label="Next page"
            />
          </>
        )}
      </div>
    </div>
  );
}
