import { useEffect, useReducer, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  INITIAL_WIZARD,
  wizardReducer,
  canAdvance,
  toJobInput,
  STEP_ORDER,
  type WizardStep,
} from '../../../state/wizardState';
import { GoalStep } from './GoalStep';
import { SignalStep } from './SignalStep';
import { LengthStep } from './LengthStep';
import { ResultsStep } from './ResultsStep';
import { ReviewStep } from './ReviewStep';
import type { TagInfo } from '../../../lib/tags';
import { useTagLabeler } from '../../../context/TagDisplayContext';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  progress: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  stepLabel: { color: tokens.colorNeutralForeground3 },
  nav: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalS,
  },
});

const STEP_LABELS: Record<WizardStep, string> = {
  goal: 'Goal',
  signal: 'Signal',
  length: 'Length',
  results: 'Results',
  review: 'Review',
};

export interface WizardProps {
  tags: TagInfo[];
  onSubmit: (input: ReturnType<typeof toJobInput>) => void;
  /** Pre-select a recipe and jump to the signal step (from a menu deep-link). */
  initialRecipeId?: string;
}

/** The linear, resumable analysis wizard (design spec §7.1). */
export function Wizard({ tags, onSubmit, initialRecipeId }: WizardProps) {
  const styles = useStyles();
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD);
  const [submitting, setSubmitting] = useState(false);
  const labeler = useTagLabeler();

  // Apply a pre-selected recipe (e.g. from a "Deep discovery" menu item): reset
  // the flow, pick the recipe, then advance past the goal step to signal
  // selection. Re-applies whenever the incoming recipe changes.
  const appliedRecipe = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialRecipeId && initialRecipeId !== appliedRecipe.current) {
      appliedRecipe.current = initialRecipeId;
      dispatch({ kind: 'reset' });
      dispatch({ kind: 'pickRecipe', recipeId: initialRecipeId });
      dispatch({ kind: 'goto', step: 'signal' });
    }
  }, [initialRecipeId]);

  const stepNumber = STEP_ORDER.indexOf(state.step) + 1;

  const signalTag = tags.find((t) => t.tagId === state.signalId);
  const signalName = state.signalId ? labeler(state.signalId, signalTag?.tagName) : 'the selected signal';

  const handleSubmit = () => {
    setSubmitting(true);
    onSubmit(toJobInput(state));
  };

  return (
    <Card>
      <CardHeader
        header={
          <div className={styles.progress}>
            {STEP_ORDER.map((s, i) => (
              <Badge
                key={s}
                appearance={i + 1 <= stepNumber ? 'filled' : 'outline'}
                color={s === state.step ? 'brand' : i + 1 < stepNumber ? 'success' : 'informative'}
                size="small"
              >
                {i + 1}
              </Badge>
            ))}
            <Text size={200} className={styles.stepLabel}>
              Step {stepNumber}: {STEP_LABELS[state.step]}
            </Text>
          </div>
        }
      />

      <div className={styles.root}>
        {state.step === 'goal' && <GoalStep state={state} dispatch={dispatch} />}
        {state.step === 'signal' && (
          <SignalStep state={state} dispatch={dispatch} tags={tags} />
        )}
        {state.step === 'length' && <LengthStep state={state} dispatch={dispatch} />}
        {state.step === 'results' && (
          <ResultsStep state={state} dispatch={dispatch} />
        )}
        {state.step === 'review' && (
          <ReviewStep
            state={state}
            dispatch={dispatch}
            signalName={signalName}
          />
        )}

        <div className={styles.nav}>
          <Button
            appearance="subtle"
            onClick={() => dispatch({ kind: 'back' })}
            disabled={state.step === 'goal'}
          >
            Back
          </Button>
          {state.step !== 'review' ? (
            <Button
              appearance="primary"
              onClick={() => dispatch({ kind: 'next' })}
              disabled={!canAdvance(state)}
            >
              Next
            </Button>
          ) : (
            <Button
              appearance="primary"
              onClick={handleSubmit}
              disabled={submitting || !canAdvance(state)}
            >
              {submitting ? 'Starting…' : 'Run analysis'}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
