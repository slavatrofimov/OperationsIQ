import { useMemo } from 'react';
import { Badge, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { EChart } from '../EChart';
import { describeRegimes, regimeBadge } from '../../lib/mp/interpret';
import { PATTERN_COLORS, regimeBand, withAlpha } from '../../lib/mp/patternColors';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import type { EChartsOption } from 'echarts';

export interface RegimeBoundary {
  rank: number;
  boundaryIdx: number;
  cac: number | null;
}

/**
 * Regime / mode-change view (design spec §7.3 item 6). Renders:
 *  - a colored ribbon splitting the timeline into operating modes at the change points;
 *  - the "change score" (Corrected Arc Curve) lane, whose dips mark the switch-overs;
 *  - a plain-language summary of how many modes were found and where.
 * No MP jargon — boundaries are "mode changes", the CAC is a "change score".
 */
export function RegimeRibbon({
  boundaries,
  cac,
  totalSamples,
  selectedBoundaryIdx = null,
  onSelectBoundary,
}: {
  boundaries: RegimeBoundary[];
  cac: number[];
  totalSamples: number;
  /** boundaryIdx of the currently highlighted change (drives chart + chip emphasis). */
  selectedBoundaryIdx?: number | null;
  /** Select a change point (toggles when the same one is clicked again). */
  onSelectBoundary?: (boundaryIdx: number | null) => void;
}) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();

  const total = Math.max(1, totalSamples || cac.length);
  const sortedBounds = useMemo(
    () => [...boundaries].sort((a, b) => a.boundaryIdx - b.boundaryIdx),
    [boundaries],
  );

  // Build contiguous mode segments [start,end) between successive boundaries.
  const segments = useMemo(() => {
    const edges = [0, ...sortedBounds.map((b) => b.boundaryIdx), total];
    const segs: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < edges.length - 1; i += 1) {
      const start = Math.max(0, Math.min(total, edges[i]));
      const end = Math.max(start, Math.min(total, edges[i + 1]));
      if (end > start) segs.push({ start, end });
    }
    return segs;
  }, [sortedBounds, total]);

  const arcOption: EChartsOption = useMemo(() => {
    return {
      animation: false,
      grid: { top: 8, bottom: 20, left: 8, right: 8, containLabel: true },
      xAxis: { type: 'value' as const, min: 0, max: Math.max(1, cac.length - 1), show: false },
      yAxis: {
        type: 'value' as const,
        min: 0,
        max: 1,
        splitNumber: 1,
        axisLabel: {
          formatter: (_v: number, i: number) => (i === 0 ? '▼ mode change' : 'steady'),
          fontSize: 10,
          color: '#666',
        },
      },
      series: [
        {
          name: 'Change score',
          type: 'line' as const,
          data: cac.map((v, i) => [i, v]),
          showSymbol: false,
          lineStyle: { color: PATTERN_COLORS.chain, width: 1 },
          smooth: false,
          sampling: 'lttb',
          markLine: {
            symbol: 'none' as const,
            silent: true,
            data: sortedBounds.map((b) => ({
              xAxis: b.boundaryIdx,
              lineStyle:
                b.boundaryIdx === selectedBoundaryIdx
                  ? { color: PATTERN_COLORS.discord, type: 'solid' as const, width: 2, opacity: 0.95 }
                  : { color: PATTERN_COLORS.discord, type: 'dashed' as const, width: 1, opacity: 0.3 },
            })),
          },
        },
      ],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
    };
  }, [cac, sortedBounds, selectedBoundaryIdx, tooltipDecimals]);

  const numRegimes = segments.length || 1;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Badge appearance="tint" color="brand" size="small">
          {regimeBadge({ numRegimes })}
        </Badge>
        <Text size={200}>{describeRegimes({ numRegimes })}</Text>
      </div>

      {/* Mode ribbon */}
      <div className={styles.ribbon} role="img" aria-label={`${numRegimes} operating modes`}>
        {segments.map((s, i) => {
          const widthPct = ((s.end - s.start) / total) * 100;
          return (
            <div
              key={s.start}
              className={styles.band}
              style={{ width: `${widthPct}%`, background: withAlpha(regimeBand(i), 0.16) }}
              title={`Mode ${i + 1}: samples ${s.start}–${s.end}`}
            >
              <span className={styles.bandLabel}>Mode {i + 1}</span>
            </div>
          );
        })}
      </div>

      {/* Change-score (CAC) lane */}
      {cac.length > 0 && <EChart option={arcOption} height={100} />}

      {sortedBounds.length > 0 && (
        <>
          {onSelectBoundary && (
            <Text size={200} className={styles.hint}>
              Select a change to highlight where it occurs on the signal charts above.
            </Text>
          )}
          <ul className={styles.list}>
            {sortedBounds.map((b, i) => {
              const selected = b.boundaryIdx === selectedBoundaryIdx;
              const content = (
                <>
                  <Badge appearance={selected ? 'filled' : 'outline'} color="danger" size="small">
                    Change {i + 1}
                  </Badge>
                  <Text size={200}>at sample {b.boundaryIdx}</Text>
                </>
              );
              return (
                <li key={b.boundaryIdx} className={styles.item}>
                  {onSelectBoundary ? (
                    <button
                      type="button"
                      className={mergeClasses(styles.chip, selected && styles.chipSelected)}
                      aria-pressed={selected}
                      onClick={() => onSelectBoundary(selected ? null : b.boundaryIdx)}
                    >
                      {content}
                    </button>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  ribbon: {
    display: 'flex',
    width: '100%',
    height: '20px',
    borderRadius: '4px',
    overflow: 'hidden',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  band: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
  },
  bandLabel: {
    fontSize: '10px',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
    padding: '0 4px',
  },
  list: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    listStyleType: 'none',
    margin: 0,
    padding: 0,
  },
  item: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  hint: { color: tokens.colorNeutralForeground3 },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    padding: `2px ${tokens.spacingHorizontalXS}`,
    ':hover': { background: tokens.colorNeutralBackground1Hover },
  },
  chipSelected: {
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    background: tokens.colorPaletteRedBackground1,
  },
});
