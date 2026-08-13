import type { ReactNode } from 'react';
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { useShowExplanations } from '../context/ExplanationsContext';

/**
 * A short, plain-language description of a specific output (chart, table, or
 * stat panel) explaining what it represents and how to read it
 * (functional spec §Democratization).
 *
 * Visibility is governed by the global "show explanations" preference
 * (see {@link useShowExplanations}) so expert users can hide it.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    marginTop: tokens.spacingVerticalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
});

export interface OutputDescriptionProps {
  children: ReactNode;
  /** Optional aria-label describing which output this annotates. */
  label?: string;
}

export function OutputDescription({ children, label }: OutputDescriptionProps) {
  const styles = useStyles();
  const show = useShowExplanations();

  if (!show) return null;

  return (
    <div className={styles.root} role="note" aria-label={label}>
      <Caption1>{children}</Caption1>
    </div>
  );
}
