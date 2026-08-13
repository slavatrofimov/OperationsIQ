import { useMemo } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { TagRegular } from '@fluentui/react-icons';
import { EChart } from '../EChart';
import { PatternInspector } from './PatternInspector';
import {
  describeChainDrift,
  chainDriftBadge,
  chainDriftStrength,
  type ChainDriftSummary,
} from '../../lib/mp/interpret';
import { useTooltipDecimals } from '../../context/TooltipSettingsContext';
import { seriesColor } from '../../lib/mp/patternColors';
import { shortPatternId } from '../../lib/mp/patternId';
import { formatQueryInstant } from '../../lib/timezone';
import { formatDuration } from '../../lib/mp/units';
import type { EChartsOption } from 'echarts';

export interface ChainLink {
  chainRank: number;
  linkOrder: number;
  idx: number;
  subLen: number;
}

/** Least-squares slope of a series against 0..n-1 (0 for <2 points). */
function slope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i;
    sy += ys[i];
    sxx += i * i;
    sxy += i * ys[i];
  }
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

/** Per-link mean level + peak-to-peak amplitude of each chain member's window. */
function linkStats(rawSignal: number[], members: ChainLink[]) {
  const means: number[] = [];
  const amps: number[] = [];
  for (const m of members) {
    const seg = rawSignal.slice(m.idx, m.idx + m.subLen);
    if (seg.length === 0) continue;
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (const v of seg) {
      sum += v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    means.push(sum / seg.length);
    amps.push(mx - mn);
  }
  return { means, amps };
}

/**
 * Chain / slow-degradation view (design spec §7.3 item 7). Shows the recurring pattern's
 * links across the window, and — crucially for degradation — how its level/amplitude
 * drifts head→tail. A steady drift is the fingerprint of wear or fouling. No MP jargon:
 * "the pattern repeats N times and its swing keeps growing".
 *
 * When the run found more than one evolving chain, each chain is selectable (L1 = longest);
 * the selection is shared with the synchronized signal chart so its links highlight there.
 * A z-normalized shape overlay of the selected chain's repeats lets the analyst confirm the
 * links really are the same shape drifting (rather than unrelated stretches).
 */
export function ChainView({
  chains,
  rawSignal,
  secondsPerSample,
  windowStartMs,
  selectedIndex,
  onSelectIndex,
  visibleIds,
  onToggleVisible,
  colorForId,
  onAnnotate,
}: {
  chains: ChainLink[];
  rawSignal: number[];
  secondsPerSample?: number;
  /** Absolute window start (epoch ms), so a sample index maps to a timestamp. */
  windowStartMs?: number;
  /** Focused chain (1-based, longest first). Controlled by the parent so the chart syncs. */
  selectedIndex?: number;
  onSelectIndex?: (index: number) => void;
  /** Chart-overlay visibility state (enables the "Show on chart" checkbox). */
  visibleIds?: Set<string>;
  onToggleVisible?: (id: string) => void;
  colorForId?: (id: string) => string;
  /** Open the label form pre-filled with the selected chain's links. */
  onAnnotate?: () => void;
}) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();

  // Group links by chain, ordered longest→shortest (a longer chain is a stronger drift
  // signal), then assign a stable 1-based display index (L1 = longest).
  const grouped = useMemo(() => {
    const byRank = new Map<number, ChainLink[]>();
    for (const l of chains) {
      const arr = byRank.get(l.chainRank) ?? [];
      arr.push(l);
      byRank.set(l.chainRank, arr);
    }
    return [...byRank.entries()]
      .map(([rank, links]) => ({ rank, links: [...links].sort((a, b) => a.linkOrder - b.linkOrder) }))
      .sort((a, b) => b.links.length - a.links.length || a.rank - b.rank)
      .map((g, i) => ({ ...g, index: i + 1 }));
  }, [chains]);

  const active = grouped.find((g) => g.index === (selectedIndex ?? 1)) ?? grouped[0];
  const top = active?.links ?? [];
  const activeId = shortPatternId('chain', active?.index ?? 1);

  const { means, amps } = useMemo(() => linkStats(rawSignal, top), [rawSignal, top]);

  // Z-normalizable shape slices for the overlay: one line per repeat.
  const instances = useMemo(
    () => top.map((l) => rawSignal.slice(l.idx, l.idx + l.subLen)).filter((a) => a.length > 0),
    [rawSignal, top],
  );

  const drift: ChainDriftSummary = useMemo(
    () => ({
      links: top.length,
      meanSlope: slope(means),
      amplitudeSlope: slope(amps),
      meanStart: means[0] ?? null,
      meanEnd: means[means.length - 1] ?? null,
      amplitudeStart: amps[0] ?? null,
      amplitudeEnd: amps[amps.length - 1] ?? null,
    }),
    [top.length, means, amps],
  );

  const trendOption: EChartsOption = useMemo(
    () => ({
      animation: false,
      grid: { top: 20, bottom: 28, left: 8, right: 8, containLabel: true },
      legend: { top: 0, textStyle: { fontSize: 10 }, data: ['level', 'swing'] },
      xAxis: {
        type: 'category' as const,
        data: means.map((_, i) => `#${i + 1}`),
        name: 'repeat',
        nameLocation: 'middle' as const,
        nameGap: 18,
        nameTextStyle: { fontSize: 10 },
      },
      yAxis: { type: 'value' as const },
      series: [
        {
          name: 'level',
          type: 'line' as const,
          data: means,
          smooth: false,
          symbolSize: 5,
          lineStyle: { color: seriesColor(0) },
          itemStyle: { color: seriesColor(0) },
        },
        {
          name: 'swing',
          type: 'line' as const,
          data: amps,
          smooth: false,
          symbolSize: 5,
          lineStyle: { color: seriesColor(1) },
          itemStyle: { color: seriesColor(1) },
        },
      ],
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
    }),
    [means, amps, tooltipDecimals],
  );

  const strength = chainDriftStrength(drift);
  const badgeColor =
    strength === 'strong' ? 'danger' : strength === 'moderate' ? 'warning' : 'success';

  const startText = (idx: number): string => {
    if (windowStartMs != null && secondsPerSample) {
      return formatQueryInstant(windowStartMs + idx * secondsPerSample * 1000, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return secondsPerSample ? `${(idx * secondsPerSample).toFixed(0)}s` : `sample ${idx}`;
  };
  const lengthText = (len: number): string =>
    secondsPerSample ? formatDuration(len * secondsPerSample) : `${len} samples`;

  if (grouped.length === 0) return <Text size={200}>No evolving pattern found.</Text>;

  return (
    <div className={styles.root}>
      {/* Chain picker — one tab per evolving chain (L1 = longest). */}
      {grouped.length > 1 && (
        <TabList
          size="small"
          selectedValue={String(active?.index ?? 1)}
          onTabSelect={(_, d) => onSelectIndex?.(Number(d.value))}
        >
          {grouped.map((g) => (
            <Tab key={g.index} value={String(g.index)}>
              {shortPatternId('chain', g.index)} · {g.links.length} repeats
            </Tab>
          ))}
        </TabList>
      )}

      <div className={styles.header}>
        <Badge appearance="tint" color={badgeColor} size="small">
          {chainDriftBadge(drift)}
        </Badge>
        <Text size={200}>{describeChainDrift(drift)}</Text>
      </div>

      {/* Chart-sync + labeling controls for the focused chain. */}
      <div className={styles.controls}>
        {onToggleVisible && (
          <Checkbox
            checked={visibleIds ? visibleIds.has(activeId) : true}
            onChange={() => onToggleVisible(activeId)}
            label="Show on chart"
          />
        )}
        {colorForId && (
          <span className={styles.swatch} style={{ background: colorForId(activeId) }} aria-hidden />
        )}
        <Text size={200} className={styles.meta}>
          {top.length} repeats · each {lengthText(top[0]?.subLen ?? 0)}
        </Text>
        {onAnnotate && (
          <Button size="small" appearance="secondary" icon={<TagRegular />} onClick={onAnnotate}>
            Label this chain
          </Button>
        )}
      </div>

      {/* Aligned shapes of each repeat — confirms the links are the same shape drifting. */}
      {instances.length > 1 && (
        <PatternInspector
          instances={instances}
          caption="Each repeat in this chain, aligned so you can see the drift (or spot a mismatch)"
        />
      )}

      {/* Head→tail drift trend across the chain's repeats. */}
      {means.length > 1 && <EChart option={trendOption} height={140} />}

      {/* Where each repeat sits in the window. */}
      <ul className={styles.list}>
        {top.map((l, i) => (
          <li key={l.idx} className={styles.item}>
            <Badge appearance="outline" size="small">
              #{i + 1}
            </Badge>
            <Text size={200}>{startText(l.idx)}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  swatch: {
    width: '12px',
    height: '12px',
    borderRadius: tokens.borderRadiusSmall,
    display: 'inline-block',
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
  meta: { color: tokens.colorNeutralForeground3 },
});
