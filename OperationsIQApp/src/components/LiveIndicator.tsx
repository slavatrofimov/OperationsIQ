/**
 * Live status indicator component for live-tail mode.
 * Shows a pulsing dot, countdown timer, and last updated timestamp.
 */

import { useEffect, useState } from 'react';
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';

export interface LiveIndicatorProps {
  /** Whether live-tail is currently active. */
  active: boolean;
  /** Seconds until next refresh. */
  countdown: number;
  /** Whether data is currently being fetched. */
  isFetching: boolean;
  /** Timestamp of last successful update. */
  lastUpdated: Date | null;
  /** Number of ticks since last new data (for gray dot after 2 ticks). */
  ticksSinceData?: number;
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    transition: 'background-color 0.3s ease',
  },
  dotActive: {
    backgroundColor: tokens.colorPaletteRedBackground3,
    animation: 'pulse 2s ease-in-out infinite',
  },
  dotStale: {
    backgroundColor: tokens.colorNeutralForeground4,
  },
  '@keyframes pulse': {
    '0%': { opacity: 1 },
    '50%': { opacity: 0.4 },
    '100%': { opacity: 1 },
  },
  text: {
    color: tokens.colorNeutralForeground2,
  },
  textStale: {
    color: tokens.colorNeutralForeground4,
  },
});

/**
 * Live status indicator showing real-time update status.
 */
export function LiveIndicator({
  active,
  countdown,
  isFetching,
  lastUpdated,
  ticksSinceData = 0,
}: LiveIndicatorProps) {
  const styles = useStyles();

  // Re-tick every second while active so the "last updated … ago" label stays
  // accurate between refreshes. Without this the label is memoized/frozen at the
  // moment of the last fetch and appears stuck at "0s ago".
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const isStale = ticksSinceData >= 2;
  const dotClass = isStale ? styles.dotStale : styles.dotActive;
  const textClass = isStale ? styles.textStale : styles.text;

  const lastUpdatedText = (() => {
    if (!lastUpdated) return 'Never';
    const diffSec = Math.max(0, Math.floor((nowMs - lastUpdated.getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  })();

  if (!active) return null;

  return (
    <div className={styles.container}>
      <div className={`${styles.dot} ${dotClass}`} />
      <Caption1 className={textClass}>
        {isFetching ? (
          'Refreshing...'
        ) : countdown > 0 ? (
          `Refreshing in ${countdown}s`
        ) : (
          'Live'
        )}
      </Caption1>
      <Caption1 className={textClass}>Last updated: {lastUpdatedText}</Caption1>
    </div>
  );
}