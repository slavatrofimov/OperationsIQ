import {
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { WizardState, WizardAction } from '../../../state/wizardState';
import { effectiveBinSeconds, resolveLength } from '../../../state/wizardState';
import { recipeById } from '../../../lib/mp/recipes';
import { estimateJob } from '../../../lib/mp/jobPath';
import { formatDuration } from '../../../lib/mp/units';
import { computeBinningOutputs } from '../../../lib/binningSettings';
import { defaultAnalysisName } from '../../../lib/mp/naming';
import { toJobInput } from '../../../state/wizardState';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  summary: { padding: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** Step 5 — plain-language review + honest compute-path estimate (design spec §7.1, §8). */
export function ReviewStep({
  state,
  dispatch,
  signalName,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  signalName: string;
}) {
  const styles = useStyles();
  const recipe = state.recipeId ? recipeById(state.recipeId) : undefined;
  const resolved = resolveLength(state);
  const binSec = effectiveBinSeconds(state);
  const isScan = resolved.type === 'PAN_MP';

  // Projected point count after binning drives the honest compute estimate — the same bin
  // width the Spark source read will use.
  const points =
    state.windowStart && state.windowEnd
      ? computeBinningOutputs(
          { start: new Date(state.windowStart), end: new Date(state.windowEnd) },
          state.binning,
        ).points
      : 0;

  // Representative length for the estimate: the scan's upper bound, or the single length.
  const estimateSubLen = resolved.subLen ?? resolved.lengthMax ?? 200;
  const estimate = estimateJob(points, estimateSubLen, { panScan: isScan });

  const lengthText = isScan
    ? `patterns from ~${formatDuration(state.lengthMinSec)} to ~${formatDuration(state.lengthMaxSec)}`
    : state.lengthMode === 'range'
      ? `~${formatDuration(Math.sqrt(state.lengthMinSec * state.lengthMaxSec))} patterns`
      : `~${formatDuration(state.lengthSec)} patterns`;

  const suggestedName = defaultAnalysisName({
    type: toJobInput(state).type,
    signalName: signalName === 'the selected signal' ? undefined : signalName,
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
  });

  return (
    <div className={styles.root}>
      <Text weight="semibold">Review & run</Text>

      <Field label="Analysis name" hint="Shown in your run history so you can tell analyses apart.">
        <Input
          value={state.name ?? ''}
          placeholder={suggestedName}
          onChange={(_e, data) => dispatch({ kind: 'setName', name: data.value })}
        />
      </Field>

      <Card className={styles.summary}>
        <Text>
          {recipe?.title ?? 'Analyze'}: find the top {state.resultCount} {lengthText} in{' '}
          <strong>{signalName}</strong> between <strong>{state.windowStart}</strong> and{' '}
          <strong>{state.windowEnd}</strong>, at ~{formatDuration(binSec)}/point
          {points > 0 ? ` (~${points.toLocaleString()} points)` : ''}.
        </Text>
      </Card>

      <MessageBar intent={estimate.path === 'interactive' ? 'success' : 'info'}>
        <MessageBarBody>{estimate.message}</MessageBarBody>
      </MessageBar>

      {recipe && (
        <Text size={200} className={styles.hint}>
          {recipe.explainer}
        </Text>
      )}
    </div>
  );
}
