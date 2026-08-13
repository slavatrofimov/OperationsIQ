import {
  Card,
  CardHeader,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { availableRecipes, RECIPES } from '../../../lib/mp/recipes';
import type { WizardState, WizardAction } from '../../../state/wizardState';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  goalCard: {
    cursor: 'pointer',
    transition: 'outline 0.1s, background 0.1s',
    borderLeft: '3px solid transparent',
  },
  goalCardSelected: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorBrandBackground2,
  },
  comingSoon: { color: tokens.colorNeutralForeground3 },
  soonList: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
});

/** Step 1 — "What do you want to find?" plain-language goal cards (design spec §7.1). */
export function GoalStep({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: (a: WizardAction) => void;
}) {
  const styles = useStyles();
  const shipping = availableRecipes();
  const comingSoon = RECIPES.filter((r) => !r.available);

  return (
    <div className={styles.root}>
      <Text weight="semibold">What do you want to find?</Text>
      <Text size={200} className={styles.hint}>
        Pick a goal — we'll set everything else up for you.
      </Text>

      <div className={styles.grid}>
        {shipping.map((r) => (
          <Card
            key={r.id}
            className={
              state.recipeId === r.id
                ? `${styles.goalCard} ${styles.goalCardSelected}`
                : styles.goalCard
            }
            onClick={() => dispatch({ kind: 'pickRecipe', recipeId: r.id })}
            role="option"
            aria-selected={state.recipeId === r.id}
          >
            <CardHeader header={<Text weight="semibold">{r.title}</Text>} />
            <Text size={200}>{r.blurb}</Text>
          </Card>
        ))}
      </div>

      {comingSoon.length > 0 && (
        <div>
          <Text size={200} className={styles.comingSoon}>
            More analyses (coming soon):
          </Text>
          <ul className={styles.soonList}>
            {comingSoon.map((r) => (
              <li key={r.id}>
                <Text size={200}>
                  <strong>{r.title}</strong> — {r.blurb}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
