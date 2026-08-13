import { useMemo } from 'react';
import {
  Table,
  TableHeader,
  TableRow,
  TableHeaderCell,
  TableBody,
  TableCell,
  Subtitle2,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ExploreSeries } from '../lib/series';
import { computeStats, correlationMatrix } from '../lib/stats';
import { CorrelationCharts } from './CorrelationCharts';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  // Horizontal scroll so many-signal tables never squeeze columns into each
  // other (long tag names would otherwise overlap in the correlation matrix).
  scroll: { overflowX: 'auto', maxWidth: '100%' },
  // Fluent's Table root forces `table-layout: fixed` + `width: 100%`, which
  // splits the width into equal shares and makes long `nowrap` tag names overflow
  // into the next column. `table-layout: auto` restores content-based column
  // sizing (the label column grows to fit its name, remaining space is shared by
  // the value columns), while `min-width: max-content` + the `.scroll` wrapper add
  // horizontal scroll when there are too many columns to fit.
  wideTable: { minWidth: 'max-content', tableLayout: 'auto' },
  headCell: { whiteSpace: 'nowrap' },
  // Row-label column: keep the name on one line and pin it while scrolling
  // horizontally so you can always tell which row you're reading.
  labelCell: {
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
    position: 'sticky',
    left: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  corrCell: {
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    minWidth: '64px',
  },
});

export interface StatisticsPanelProps {
  series: ExploreSeries[];
  nameById: Map<string, string>;
  /**
   * Render only the descriptive statistics table, omitting the Pearson
   * correlation matrix and correlation charts (used by the Live view page).
   */
  descriptiveOnly?: boolean;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '\u2014';
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Color a correlation cell from red (-1) through neutral (0) to blue (+1). */
function corrColor(r: number): string {
  if (!Number.isFinite(r)) return 'transparent';
  const a = Math.min(1, Math.abs(r));
  return r >= 0 ? `rgba(15, 108, 189, ${a * 0.35})` : `rgba(209, 52, 56, ${a * 0.35})`;
}

/** Descriptive statistics per series plus a Pearson correlation matrix. */
export function StatisticsPanel({ series, nameById, descriptiveOnly = false }: StatisticsPanelProps) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const names = series.map((s) => labeler(s.tagId, nameById.get(s.tagId)));
  const stats = useMemo(() => series.map((s) => computeStats(s.values)), [series]);
  const corr = useMemo(
    () => (!descriptiveOnly && series.length > 1 ? correlationMatrix(series.map((s) => s.values)) : null),
    [series, descriptiveOnly],
  );

  if (series.length === 0) return null;

  return (
    <div className={styles.root}>
      <div className={styles.section}>
        <Subtitle2>Descriptive statistics</Subtitle2>
        <div className={styles.scroll}>
          <Table size="small" aria-label="Descriptive statistics" className={styles.wideTable}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={styles.labelCell}>Series</TableHeaderCell>
                <TableHeaderCell>Count</TableHeaderCell>
                <TableHeaderCell>Min</TableHeaderCell>
                <TableHeaderCell>Max</TableHeaderCell>
                <TableHeaderCell>Mean</TableHeaderCell>
                <TableHeaderCell>Median</TableHeaderCell>
                <TableHeaderCell>Std dev</TableHeaderCell>
                <TableHeaderCell>P05</TableHeaderCell>
                <TableHeaderCell>P95</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.map((s, i) => (
                <TableRow key={series[i].tagId}>
                  <TableCell className={styles.labelCell}>{names[i]}</TableCell>
                  <TableCell>{s.count}</TableCell>
                  <TableCell>{fmt(s.min)}</TableCell>
                  <TableCell>{fmt(s.max)}</TableCell>
                  <TableCell>{fmt(s.mean)}</TableCell>
                  <TableCell>{fmt(s.median)}</TableCell>
                  <TableCell>{fmt(s.stdev)}</TableCell>
                  <TableCell>{fmt(s.p05)}</TableCell>
                  <TableCell>{fmt(s.p95)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {corr && (
        <div className={styles.section}>
          <Subtitle2>Correlation (Pearson)</Subtitle2>
          <Caption1>Computed over bins where both series have a value.</Caption1>
          <div className={styles.scroll}>
            <Table size="small" aria-label="Correlation matrix" className={styles.wideTable}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={styles.labelCell}></TableHeaderCell>
                  {names.map((n, i) => (
                    <TableHeaderCell key={series[i].tagId} className={styles.headCell}>{n}</TableHeaderCell>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {corr.map((row, i) => (
                  <TableRow key={series[i].tagId}>
                    <TableCell className={styles.labelCell}>{names[i]}</TableCell>
                    {row.map((r, j) => (
                      <TableCell
                        key={series[j].tagId}
                        className={styles.corrCell}
                        style={{ backgroundColor: corrColor(r) }}
                      >
                        {fmt(r)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {series.length > 1 && !descriptiveOnly && <CorrelationCharts series={series} nameById={nameById} />}
    </div>
  );
}
