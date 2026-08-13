import { useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  formatDetectedPeriod,
  periodToSeasonalityBins,
  type DetectedPeriod,
} from '../lib/periods';

/**
 * "Detect cycles" affordance backed by KQL `series_periods_detect`.
 *
 * Runs the caller-provided {@link SeasonalityDetectorProps.detect} query, then
 * renders the dominant recurring periods as clickable chips. Clicking a chip
 * calls {@link SeasonalityDetectorProps.onApply} so the host page can fill its
 * seasonality control (in bins) and re-run. The chip matching the currently
 * applied seasonality is highlighted.
 *
 * Kept UI-only and stateless w.r.t. the query so it composes with the existing
 * picker → analyze → chart pattern; the host still owns `executeKql`.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  chip: { cursor: 'pointer' },
});

export interface SeasonalityDetectorProps {
  /** Runs the detection query and resolves to the detected cycles. */
  detect: () => Promise<DetectedPeriod[]>;
  /** Invoked when the user picks a detected cycle to apply. */
  onApply: (period: DetectedPeriod) => void;
  /** Disable the trigger (e.g. no tag selected, or an analysis is running). */
  disabled?: boolean;
  /** Seasonality currently applied (in bins), used to highlight the active chip. */
  appliedBins?: number | null;
}

export function SeasonalityDetector({
  detect,
  onApply,
  disabled,
  appliedBins,
}: SeasonalityDetectorProps) {
  const styles = useStyles();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [periods, setPeriods] = useState<DetectedPeriod[] | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setPeriods(await detect());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPeriods(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <Button
        appearance="secondary"
        size="small"
        disabled={disabled || loading}
        onClick={() => void run()}
      >
        {loading ? <Spinner size="tiny" /> : 'Detect cycles'}
      </Button>

      {error && <Caption1>Detection failed: {error}</Caption1>}

      {!error && periods != null && periods.length === 0 && (
        <Caption1>No recurring cycles detected in this window.</Caption1>
      )}

      {!error &&
        periods?.map((p, i) => {
          const bins = periodToSeasonalityBins(p);
          const active = appliedBins != null && appliedBins === bins;
          return (
            <Badge
              key={`${bins}-${i}`}
              className={styles.chip}
              appearance={active ? 'filled' : 'tint'}
              color="brand"
              role="button"
              tabIndex={0}
              title="Apply this period as the seasonality"
              onClick={() => onApply(p)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onApply(p);
                }
              }}
            >
              {formatDetectedPeriod(p)}
            </Badge>
          );
        })}
    </div>
  );
}
