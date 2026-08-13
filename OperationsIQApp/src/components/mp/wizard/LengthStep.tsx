import {
  Checkbox,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { WizardState, WizardAction } from '../../../state/wizardState';
import { effectiveBinSeconds, resolveLength } from '../../../state/wizardState';
import { formatDuration } from '../../../lib/mp/units';
import { DurationField } from './DurationField';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
  controls: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
});

/** Number of candidate lengths a Pan-MP scan will evaluate for the resolved range. */
function scannedLengthCount(min?: number, max?: number, step?: number): number {
  if (min == null || max == null || !step) return 0;
  return Math.max(1, Math.floor((max - min) / step) + 1);
}

/**
 * Step 3 — "How long is the pattern?" answered in domain time terms. The user either
 * provides a **range** (default — an uncertain lower/upper bound we slice into candidate
 * lengths for a Pan-MP scan) or a single **value**. Durations are entered as a number +
 * unit (sec / min / hour / day) so cycles from a few seconds to a year or more are
 * expressible, and are converted to subsequence lengths against the chosen bin width.
 */
export function LengthStep({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: (a: WizardAction) => void;
}) {
  const styles = useStyles();

  // Segmentation and chains run on a single concrete window length, so the range option is
  // not offered for them.
  const singleOnly = state.jobType === 'SEGMENTATION' || state.jobType === 'CHAIN';
  const isRange = state.lengthMode === 'range' && !singleOnly;

  const binSec = effectiveBinSeconds(state);
  const resolved = resolveLength(state);
  const scanCount = scannedLengthCount(resolved.lengthMin, resolved.lengthMax, resolved.lengthStep);

  return (
    <div className={styles.root}>
      <Text weight="semibold">How long is the pattern you care about?</Text>

      {!singleOnly && (
        <Checkbox
          checked={isRange}
          onChange={(_, d) =>
            dispatch({ kind: 'setLengthMode', mode: d.checked === true ? 'range' : 'point' })
          }
          label="I'm not sure, let me provide a range"
        />
      )}

      {isRange ? (
        <>
          <div className={styles.controls}>
            <DurationField
              label="Shortest cycle / event"
              seconds={state.lengthMinSec}
              onChange={(s) => dispatch({ kind: 'setLengthRange', minSec: s })}
            />
            <DurationField
              label="Longest cycle / event"
              seconds={state.lengthMaxSec}
              onChange={(s) => dispatch({ kind: 'setLengthRange', maxSec: s })}
            />
          </div>
          <Text size={200} className={styles.hint}>
            We'll scan {scanCount > 0 ? `~${scanCount}` : 'several'} lengths from{' '}
            {formatDuration(state.lengthMinSec)} to {formatDuration(state.lengthMaxSec)} (
            {resolved.lengthMin}–{resolved.lengthMax} points at ~{formatDuration(binSec)}/point) and
            keep the clearest — being approximately right is fine.
          </Text>
        </>
      ) : (
        <>
          <div className={styles.controls}>
            <DurationField
              label="About how long is one cycle or event?"
              seconds={state.lengthSec}
              onChange={(s) => dispatch({ kind: 'setLengthPoint', seconds: s })}
            />
          </div>
          <Text size={200} className={styles.hint}>
            That's {resolved.subLen} points at ~{formatDuration(binSec)}/point.
          </Text>
        </>
      )}
    </div>
  );
}
