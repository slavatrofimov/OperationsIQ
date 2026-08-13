import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button, Link, Text, makeStyles, tokens } from '@fluentui/react-components';
import { TagRegular } from '@fluentui/react-icons';
import { severityColor, discordStrength, describeDiscord } from '../../lib/mp/interpret';
import { shortPatternId } from '../../lib/mp/patternId';
import { formatDuration } from '../../lib/mp/units';
import { formatQueryInstant } from '../../lib/timezone';
import { PatternStat, PatternStatRow } from './PatternStat';
import { PatternMasterDetail } from './PatternMasterDetail';
import { PatternListTable, type PatternRow, type PatternBadgeTone } from './PatternListTable';

export interface DiscordFlag {
  idx: number;
  severity: number; // 0..1
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  track: {
    position: 'relative',
    height: '12px',
    background: tokens.colorNeutralBackground3,
    borderRadius: '4px',
    overflow: 'visible',
  },
  pin: {
    position: 'absolute',
    top: '-2px',
    width: '8px',
    height: '16px',
    borderRadius: '2px',
    cursor: 'pointer',
    transform: 'translateX(-50%)',
  },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  detailHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  swatch: { width: '12px', height: '12px', borderRadius: '2px', flexShrink: 0 },
  empty: { color: tokens.colorNeutralForeground3 },
});

function toneFor(severity: number): PatternBadgeTone {
  const s = discordStrength(severity);
  return s === 'strong' ? 'danger' : s === 'moderate' ? 'warning' : 'informative';
}

/**
 * Discord (anomaly) results as a master-detail: a proportional severity pin track for
 * at-a-glance placement, a compact selectable table of every anomaly on the left (styled
 * like the runs table), and the selected anomaly's stats on the right. Responsive — the
 * table stacks above the detail on narrow screens.
 */
export function DiscordFlags({
  discords,
  totalSamples,
  onJump,
  secondsPerSample,
  subLen,
  windowStartMs,
  selectedRank,
  onSelectRank,
  onAnnotate,
  visibleIds,
  onToggleVisible,
  colorForId,
  renderLabels,
  hasLabels,
}: {
  discords: DiscordFlag[];
  totalSamples: number;
  onJump?: (idx: number) => void;
  /** Estimated seconds per sample, for human-readable start time + duration. */
  secondsPerSample?: number;
  /** Discord subsequence length (samples), for the duration stat. */
  subLen?: number;
  /** Absolute window start (epoch ms), so a sample index maps to a timestamp. */
  windowStartMs?: number;
  /** Controlled selection by severity rank (D1 = most severe). Falls back to internal state. */
  selectedRank?: number;
  onSelectRank?: (rank: number) => void;
  /** Open the label form pre-filled with the selected anomaly. */
  onAnnotate?: () => void;
  /** Chart-overlay visibility state (enables the "Show" checkbox column). */
  visibleIds?: Set<string>;
  onToggleVisible?: (id: string) => void;
  colorForId?: (id: string) => string;
  /** Renders saved-label chips for a given pattern id (labels reflected in detail). */
  renderLabels?: (id: string) => ReactNode;
  /** Whether a pattern has ≥1 label — drives the per-row tag icon in the list. */
  hasLabels?: (id: string) => boolean;
}) {
  const styles = useStyles();

  // By severity rank (most severe = D1), independent of the by-index pin-track order.
  const bySeverity = [...discords].sort((a, b) => b.severity - a.severity);
  const rankByIdx = new Map<number, number>();
  bySeverity.forEach((d, i) => rankByIdx.set(d.idx, i + 1));
  const sortedByIdx = [...discords].sort((a, b) => a.idx - b.idx);

  const [internalIdx, setInternalIdx] = useState<number | undefined>(bySeverity[0]?.idx);
  // Controlled by rank when the parent supplies it; otherwise use internal by-idx state.
  const controlled = typeof selectedRank === 'number' && typeof onSelectRank === 'function';
  const selected = controlled
    ? bySeverity[(selectedRank as number) - 1] ?? bySeverity[0]
    : discords.find((d) => d.idx === internalIdx) ?? bySeverity[0];
  const selectIdx = (idx: number) => {
    if (controlled) onSelectRank?.(rankByIdx.get(idx) ?? 1);
    else setInternalIdx(idx);
  };

  const hasTiming = typeof secondsPerSample === 'number' && secondsPerSample > 0;
  const startMs = (idx: number): number | undefined =>
    hasTiming && typeof windowStartMs === 'number'
      ? windowStartMs + idx * (secondsPerSample as number) * 1000
      : undefined;
  const startText = (idx: number): string => {
    const ms = startMs(idx);
    return ms !== undefined
      ? formatQueryInstant(ms, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : `@${idx}`;
  };
  const durationText =
    hasTiming && typeof subLen === 'number' && subLen > 0
      ? formatDuration(subLen * (secondsPerSample as number))
      : undefined;

  if (discords.length === 0) return null;

  const rows: PatternRow[] = bySeverity.map((d) => ({
    id: shortPatternId('discord', rankByIdx.get(d.idx) ?? 1),
    badge: discordStrength(d.severity),
    tone: toneFor(d.severity),
    metric: `Severity ${Math.round(d.severity * 100)}% · ${describeDiscord(d.severity)}`,
    start: startText(d.idx),
    duration: durationText,
  }));

  const selectedRankResolved = selected ? rankByIdx.get(selected.idx) ?? 1 : 1;
  const selectedMs = selected ? startMs(selected.idx) : undefined;

  const detail = selected ? (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <div className={styles.swatch} style={{ background: severityColor(selected.severity) }} />
        <Badge appearance="filled" color={toneFor(selected.severity)} size="small">
          {shortPatternId('discord', selectedRankResolved)}
        </Badge>
        <Text weight="semibold">{discordStrength(selected.severity)} anomaly</Text>
        {onJump ? (
          <Link onClick={() => onJump(selected.idx)}>Sample {selected.idx}</Link>
        ) : (
          <Text size={200}>Sample {selected.idx}</Text>
        )}
        {renderLabels?.(shortPatternId('discord', selectedRankResolved))}
      </div>
      <Text size={200}>{describeDiscord(selected.severity)}</Text>
      <PatternStatRow>
        <PatternStat
          label="Severity"
          value={`${Math.round(selected.severity * 100)}%`}
          hint="How far this stretch sits from everything else — higher means more unusual."
          accentColor={severityColor(selected.severity)}
        />
        {selectedMs !== undefined && (
          <PatternStat
            label="Start"
            value={formatQueryInstant(selectedMs)}
            hint="When the anomalous stretch begins."
          />
        )}
        {durationText && (
          <PatternStat
            label="Duration"
            value={durationText}
            hint="How long the anomalous stretch lasts."
          />
        )}
      </PatternStatRow>
      {onAnnotate && (
        <div>
          <Button appearance="primary" icon={<TagRegular />} onClick={onAnnotate}>
            Label this anomaly
          </Button>
        </div>
      )}
    </div>
  ) : (
    <Text className={styles.empty}>Select an anomaly to see its details.</Text>
  );

  return (
    <div className={styles.root}>
      {/* Proportional pin track — at-a-glance placement across the whole window. */}
      <div className={styles.track}>
        {sortedByIdx.map((d) => (
          <div
            key={d.idx}
            className={styles.pin}
            style={{
              left: `${(d.idx / Math.max(1, totalSamples)) * 100}%`,
              background: severityColor(d.severity),
              outline: d.idx === selected?.idx ? `2px solid ${tokens.colorBrandStroke1}` : undefined,
            }}
            title={describeDiscord(d.severity)}
            onClick={() => selectIdx(d.idx)}
            role="button"
            aria-label={`${discordStrength(d.severity)} anomaly at sample ${d.idx}`}
          />
        ))}
      </div>

      <PatternMasterDetail
        listTitle={discords.length === 1 ? 'Found anomaly' : `Found anomalies (${discords.length})`}
        detailTitle="Anomaly details"
        list={
          <PatternListTable
            rows={rows}
            selectedId={selected ? shortPatternId('discord', selectedRankResolved) : undefined}
            onSelect={(id) => {
              const hit = bySeverity.find(
                (d) => shortPatternId('discord', rankByIdx.get(d.idx) ?? 1) === id,
              );
              if (hit) selectIdx(hit.idx);
            }}
            ariaLabel="Found anomalies"
            visibleIds={visibleIds}
            onToggleVisible={onToggleVisible}
            colorForId={colorForId}
            hasLabels={hasLabels}
          />
        }
        detail={detail}
      />
    </div>
  );
}
