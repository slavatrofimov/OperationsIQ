import type { ReactNode } from 'react';
import { Caption1, Text, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { InfoRegular } from '@fluentui/react-icons';

/**
 * Shared metric card for pattern statistics (design: consistent "PatternStat" so every
 * pattern-search type presents duration / start / end / distance / similarity / severity /
 * algorithm-specific values with identical formatting and an on-demand "what this means"
 * hint). Progressive disclosure: the number is always visible; the explanation is a hover.
 */
const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '84px',
  },
  labelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
  },
  info: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    cursor: 'help',
  },
  value: { fontWeight: tokens.fontWeightSemibold },
  accent: { width: '24px', height: '3px', borderRadius: '2px', marginTop: '2px' },
});

export interface PatternStatProps {
  /** Short label, e.g. "Duration", "Similarity", "Distance". */
  label: string;
  /** Formatted value to display (caller formats units/precision). */
  value: ReactNode;
  /** One-line plain-language interpretation, shown on hover of the info glyph. */
  hint?: string;
  /** Optional accent color (e.g. the pattern kind color) drawn as a small bar. */
  accentColor?: string;
}

export function PatternStat({ label, value, hint, accentColor }: PatternStatProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.labelRow}>
        <Caption1>{label}</Caption1>
        {hint && (
          <Tooltip content={hint} relationship="description" withArrow>
            <InfoRegular className={styles.info} aria-label={`About ${label}`} />
          </Tooltip>
        )}
      </div>
      <Text className={styles.value}>{value}</Text>
      {accentColor && <div className={styles.accent} style={{ backgroundColor: accentColor }} />}
    </div>
  );
}

/** A horizontal group of PatternStat cards with consistent spacing. */
export function PatternStatRow({ children }: { children: ReactNode }) {
  const styles = usePatternStatRowStyles();
  return <div className={styles.row}>{children}</div>;
}

const usePatternStatRowStyles = makeStyles({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
  },
});
