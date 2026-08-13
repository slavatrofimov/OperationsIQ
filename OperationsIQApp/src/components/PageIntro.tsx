import { useState, type ReactNode } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronDown12Regular, ChevronRight12Regular } from '@fluentui/react-icons';
import { useShowExplanations } from '../context/ExplanationsContext';

/**
 * Standardized page introduction block (functional spec §Democratization).
 *
 * Renders a plain-language overview of the analytical method used on a page,
 * how to interpret its results, and an optional collapsible "Technical details"
 * section that names the underlying algorithms/functions so technical users can
 * research them.
 *
 * Visibility is governed by the global "show explanations" preference
 * (see {@link useShowExplanations}) so expert users can hide it.
 */

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
  },
  overview: { color: tokens.colorNeutralForeground1 },
  interpret: { color: tokens.colorNeutralForeground2 },
  techToggle: {
    alignSelf: 'flex-start',
    marginTop: tokens.spacingVerticalXS,
  },
  techBody: {
    color: tokens.colorNeutralForeground2,
    paddingTop: tokens.spacingVerticalXS,
  },
});

export interface PageIntroProps {
  /** Short page/method title (e.g. "Forecast"). */
  title: string;
  /** Plain-language overview of what this page does (2-4 sentences). */
  overview: ReactNode;
  /** Optional guidance on how to read/interpret the results. */
  interpretation?: ReactNode;
  /**
   * Optional technical specifics — algorithms, KQL functions, model names —
   * for technical users. Rendered inside a collapsible "Technical details"
   * section.
   */
  technical?: ReactNode;
}

export function PageIntro({ title, overview, interpretation, technical }: PageIntroProps) {
  const styles = useStyles();
  const show = useShowExplanations();
  const [techOpen, setTechOpen] = useState(false);

  if (!show) return null;

  return (
    <section className={styles.root} aria-label={`About ${title}`}>
      <Body1 className={styles.overview}>{overview}</Body1>
      {interpretation && <Body1 className={styles.interpret}>{interpretation}</Body1>}
      {technical && (
        <>
          <Button
            className={styles.techToggle}
            appearance="transparent"
            size="small"
            icon={techOpen ? <ChevronDown12Regular /> : <ChevronRight12Regular />}
            aria-expanded={techOpen}
            onClick={() => setTechOpen((o) => !o)}
          >
            <Subtitle2>Technical details</Subtitle2>
          </Button>
          {techOpen && (
            <div className={styles.techBody}>
              {typeof technical === 'string' ? <Caption1>{technical}</Caption1> : technical}
            </div>
          )}
        </>
      )}
    </section>
  );
}
