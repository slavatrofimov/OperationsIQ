import { Badge, Button, Switch, Text, makeStyles, tokens } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { TagRegular } from '@fluentui/react-icons';
import {
  motifStrength,
  motifBadge,
  motifConsistencyPct,
  normalizedMotifDistance,
  type MotifSummary,
} from '../../lib/mp/interpret';
import { type Span } from '../../lib/mp/labeling';
import { formatDuration } from '../../lib/mp/units';
import { formatQueryInstant } from '../../lib/timezone';
import { shortPatternId } from '../../lib/mp/patternId';
import { patternColor } from '../../lib/mp/patternColors';
import { PatternInspector } from './PatternInspector';
import { PatternStat, PatternStatRow } from './PatternStat';
import { PatternMasterDetail } from './PatternMasterDetail';
import { PatternListTable, type PatternRow, type PatternBadgeTone } from './PatternListTable';

/** A found motif pair (as read from the `motif_pairs` KQL table). */
export interface MotifPair {
  rank: number;
  idxA: number;
  idxB: number;
  dist: number;
  subLen: number;
}

const useStyles = makeStyles({
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground2,
  },
  detailHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  inspectorHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  labelRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  empty: { color: tokens.colorNeutralForeground3 },
});

function strengthTone(m: MotifSummary): PatternBadgeTone {
  const s = motifStrength(m);
  return s === 'strong' ? 'success' : s === 'moderate' ? 'warning' : 'danger';
}

/**
 * The list of found repeating patterns (motifs) presented as a master-detail: a compact,
 * selectable table of every returned motif on the left (styled like the runs table), and
 * the selected motif's aligned shape overlay, per-motif statistics, and labeling controls
 * on the right. Responsive — the table stacks above the detail on narrow screens.
 */
export function MotifDetails({
  motifs,
  rawSignal,
  secondsPerSample,
  windowStartMs,
  selectedRank,
  onSelectRank,
  onLabel,
  visibleIds,
  onToggleVisible,
  colorForId,
  occurrenceSpans,
  showAllOccurrences,
  onToggleShowAll,
  renderLabels,
  hasLabels,
}: {
  motifs: MotifPair[];
  rawSignal: number[];
  /** Estimated seconds per sample for this window, for human-readable lengths. */
  secondsPerSample?: number;
  /** Absolute window start (epoch ms), so a sample index maps to a start time. */
  windowStartMs?: number;
  selectedRank: number;
  onSelectRank: (rank: number) => void;
  /** Ask the parent to open the label form pre-filled with this span. */
  onLabel: (span: Span) => void;
  /** Chart-overlay visibility state (enables the "Show" checkbox column). */
  visibleIds?: Set<string>;
  onToggleVisible?: (id: string) => void;
  colorForId?: (id: string) => string;
  /** All exact occurrences of the selected motif (from the backend motif_occurrences
   *  table). When present with more than the matched pair, enables the "Show all
   *  occurrences" toggle. */
  occurrenceSpans?: Span[];
  showAllOccurrences?: boolean;
  onToggleShowAll?: () => void;
  /** Renders saved-label chips for a given pattern id (labels reflected in detail). */
  renderLabels?: (id: string) => ReactNode;
  /** Whether a pattern has ≥1 label — drives the per-row tag icon in the list. */
  hasLabels?: (id: string) => boolean;
}) {
  const styles = useStyles();

  const selected = motifs.find((m) => m.rank === selectedRank) ?? motifs[0];

  // Exact occurrence count from the backend (single source of truth with the chart overlay).
  const occurrences = occurrenceSpans?.length;
  const canShowAll = !!occurrenceSpans && occurrenceSpans.length > 2;
  const showingAll = !!showAllOccurrences && canShowAll;

  if (motifs.length === 0) return null;

  const instances: number[][] = showingAll
    ? occurrenceSpans!
        .map((s) => rawSignal.slice(s.startIndex, s.startIndex + s.length))
        .filter((a) => a.length > 0)
    : selected
      ? [
          rawSignal.slice(selected.idxA, selected.idxA + selected.subLen),
          rawSignal.slice(selected.idxB, selected.idxB + selected.subLen),
        ].filter((a) => a.length > 0)
      : [];

  const summary: MotifSummary | undefined = selected
    ? {
        distance: selected.dist,
        subLen: selected.subLen,
        secondDistance: motifs.find((m) => m.rank !== selected.rank)?.dist,
      }
    : undefined;

  const hasTiming = typeof secondsPerSample === 'number' && secondsPerSample > 0;
  const durationText = (subLen: number): string | undefined =>
    hasTiming ? formatDuration(subLen * (secondsPerSample as number)) : undefined;
  const lengthText = (subLen: number): string => {
    const dur = durationText(subLen);
    return dur ? `${subLen} samples · ${dur}` : `${subLen} samples`;
  };
  const startText = (idx: number): string =>
    hasTiming && typeof windowStartMs === 'number'
      ? formatQueryInstant(windowStartMs + idx * (secondsPerSample as number) * 1000, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : `@${idx}`;

  const rows: PatternRow[] = motifs.map((m) => {
    const s: MotifSummary = { distance: m.dist, subLen: m.subLen };
    return {
      id: shortPatternId('motif', m.rank),
      badge: motifStrength(s),
      tone: strengthTone(s),
      metric: `${motifConsistencyPct(s)}% consistent · ${motifBadge(s)}`,
      start: startText(m.idxA),
      duration: durationText(m.subLen),
    };
  });

  const detail =
    selected && summary ? (
      <div className={styles.detail}>
        <div className={styles.detailHeader}>
          <Badge appearance="filled" color={strengthTone(summary)} size="small">
            {shortPatternId('motif', selected.rank)}
          </Badge>
          <Text weight="semibold">{motifBadge(summary)}</Text>
          {renderLabels?.(shortPatternId('motif', selected.rank))}
        </div>

        {canShowAll && (
          <div className={styles.inspectorHeader}>
            <Switch
              checked={showingAll}
              onChange={() => onToggleShowAll?.()}
              label={
                showingAll
                  ? `Showing all ${occurrences} occurrences`
                  : `Show all ${occurrences} occurrences`
              }
            />
          </div>
        )}

        {instances.length > 0 && (
          <PatternInspector
            instances={instances}
            caption={
              showingAll
                ? `All ${instances.length} occurrences, aligned so you can compare their shapes`
                : undefined
            }
          />
        )}

        <PatternStatRow>
          <PatternStat
            label="Pattern length"
            value={lengthText(selected.subLen)}
            hint="How long each occurrence of this repeating shape lasts."
            accentColor={patternColor('motif')}
          />
          <PatternStat
            label="How alike"
            value={`${motifConsistencyPct(summary)}% (${motifBadge(summary).toLowerCase()})`}
            hint="How closely the two matched stretches resemble each other. Higher is a tighter, more reliable pattern."
          />
          <PatternStat
            label="How often it repeats"
            value={
              occurrences === undefined
                ? '—'
                : occurrences <= 2
                  ? 'Twice (this pair)'
                  : `${occurrences} occurrences`
            }
            hint="Exact number of stretches across this window that match this pattern's shape, computed on the server (not just the matched pair)."
          />
          <PatternStat
            label="Match distance"
            value={`${selected.dist.toFixed(2)} (norm ${normalizedMotifDistance(selected.dist, selected.subLen).toFixed(3)})`}
            hint="z-normalized Euclidean distance between the two matched stretches (lower = more alike). The normalized value is per-sample, so it is comparable across pattern lengths."
          />
        </PatternStatRow>

        <div className={styles.labelRow}>
          <Button
            size="small"
            appearance="primary"
            icon={<TagRegular />}
            onClick={() => onLabel({ startIndex: selected.idxA, length: selected.subLen })}
          >
            Label instance A
          </Button>
          <Button
            size="small"
            appearance="secondary"
            icon={<TagRegular />}
            onClick={() => onLabel({ startIndex: selected.idxB, length: selected.subLen })}
          >
            Label instance B
          </Button>
        </div>
      </div>
    ) : (
      <Text className={styles.empty}>Select a pattern to see its details.</Text>
    );

  return (
    <PatternMasterDetail
      listTitle={motifs.length === 1 ? 'Found pattern' : `Found patterns (${motifs.length})`}
      detailTitle="Pattern details"
      list={
        <PatternListTable
          rows={rows}
          selectedId={selected ? shortPatternId('motif', selected.rank) : undefined}
          onSelect={(id) => {
            const hit = motifs.find((m) => shortPatternId('motif', m.rank) === id);
            if (hit) onSelectRank(hit.rank);
          }}
          ariaLabel="Found repeating patterns"
          visibleIds={visibleIds}
          onToggleVisible={onToggleVisible}
          colorForId={colorForId}
          hasLabels={hasLabels}
        />
      }
      detail={detail}
    />
  );
}

