import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
} from '@fluentui/react-components';
import type { KustoTable } from '../lib/eventhouse';

const useStyles = makeStyles({
  scroll: { overflowX: 'auto', width: '100%', maxWidth: '100%' },
  // min-width: 0 is essential so text-overflow: ellipsis works inside the flex-based table.
  cell: { minWidth: 0 },
  text: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '320px',
  },
});

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface ResultsTableProps {
  table: KustoTable;
  /** Optionally hide columns holding large dynamic arrays (e.g. raw series). */
  hideColumns?: string[];
}

/** Generic renderer for any Kusto result table (columns + row tuples). */
export function ResultsTable({ table, hideColumns = [] }: ResultsTableProps) {
  const styles = useStyles();
  const visible = table.columns
    .map((c, i) => ({ col: c, i }))
    .filter(({ col }) => !hideColumns.includes(col.name));

  return (
    <div className={styles.scroll}>
      <Table size="small" aria-label="Query results">
        <TableHeader>
          <TableRow>
            {visible.map(({ col }) => (
              <TableHeaderCell key={col.name} className={styles.cell}>
                <span className={styles.text} title={col.name}>
                  {col.name}
                </span>
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, r) => (
            <TableRow key={r}>
              {visible.map(({ col, i }) => {
                const text = formatCell(row[i]);
                return (
                  <TableCell key={col.name} className={styles.cell}>
                    <span className={styles.text} title={text}>
                      {text}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
