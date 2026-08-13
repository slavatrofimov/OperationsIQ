import type { ReactNode } from 'react';
import {
  Card,
  CardHeader,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { LightbulbRegular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  card: { width: '100%' },
  body: { padding: `0 ${tokens.spacingHorizontalM} ${tokens.spacingVerticalM}` },
  glossaryItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    marginBottom: tokens.spacingVerticalS,
    '&:last-child': { borderBottom: 'none', marginBottom: 0 },
  },
  term: { fontWeight: tokens.fontWeightSemibold },
  def: { color: tokens.colorNeutralForeground2 },
});

const GLOSSARY: Array<{ term: string; plain: string }> = [
  {
    term: 'Repeating pattern (motif)',
    plain: 'A shape in the signal that shows up more than once — usually normal, healthy behavior.',
  },
  {
    term: 'Anomaly (discord)',
    plain: "The stretch that looks least like anything else — often the first sign of a fault.",
  },
  {
    term: 'Pattern length',
    plain: 'Roughly how long one cycle or event lasts. Being approximately right is fine.',
  },
  {
    term: 'Similarity score',
    plain: 'Low means this stretch looks a lot like somewhere else; high means it stands out.',
  },
];

/**
 * The persistent "what does this mean?" explanation rail (design spec §7, §7.5).
 * Every step and result element can push a plain-language note here so users
 * never need MP vocabulary.
 */
export function ExplainRail({ title, children }: { title: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <Card className={styles.card}>
      <CardHeader
        header={
          <Text weight="semibold">
            <LightbulbRegular /> {title}
          </Text>
        }
      />
      <div className={styles.body}>{children}</div>
    </Card>
  );
}

export function Glossary() {
  const styles = useStyles();
  return (
    <div>
      {GLOSSARY.map((g) => (
        <div key={g.term} className={styles.glossaryItem}>
          <Text className={styles.term}>{g.term}</Text>
          <Text size={200} className={styles.def}>
            {g.plain}
          </Text>
        </div>
      ))}
    </div>
  );
}
