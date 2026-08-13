import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Field,
  Select,
  SpinButton,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { WizardState, WizardAction, GapFill, ScanGranularity } from '../../../state/wizardState';
import { MAX_RESULT_COUNT } from '../../../state/wizardState';
import { DurationField } from './DurationField';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
  count: { maxWidth: '160px' },
  advanced: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  select: { minWidth: '180px' },
});

/**
 * Step 4 — how many results to return, plus advanced quality knobs. The old friendly
 * sensitivity slider (capped at 8) is replaced with an explicit count so complex data sets
 * (e.g. accelerometer behavior classes) can surface up to 100 motifs/discords. Advanced
 * options let power users control result separation, gap handling and Pan-MP scan detail.
 */
export function ResultsStep({
  state,
  dispatch,
}: {
  state: WizardState;
  dispatch: (a: WizardAction) => void;
}) {
  const styles = useStyles();
  const showScanGranularity =
    state.lengthMode === 'range' &&
    state.jobType !== 'SEGMENTATION' &&
    state.jobType !== 'CHAIN';

  return (
    <div className={styles.root}>
      <Text weight="semibold">How many results should we find?</Text>

      <Field
        label={`Number of results (1–${MAX_RESULT_COUNT})`}
        className={styles.count}
        hint="Fewer results are the clearest and easiest to trust; more cast a wider net."
      >
        <SpinButton
          value={state.resultCount}
          min={1}
          max={MAX_RESULT_COUNT}
          step={1}
          onChange={(_, d) => {
            const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
            if (Number.isFinite(n)) dispatch({ kind: 'setResultCount', value: n });
          }}
        />
      </Field>

      <Accordion collapsible>
        <AccordionItem value="advanced">
          <AccordionHeader>Advanced options</AccordionHeader>
          <AccordionPanel>
            <div className={styles.advanced}>
              <DurationField
                label="Minimum separation between results"
                seconds={state.minSeparationSec}
                onChange={(s) => dispatch({ kind: 'setMinSeparation', seconds: s })}
                hint="How far apart distinct results must be, so the top matches aren't near-duplicates of each other. 0 = automatic (based on the pattern length)."
              />

              <Field
                label="Missing-data handling"
                className={styles.select}
                hint="After aggregating into bins, some buckets may have no readings. Linear fill interpolates them so the analysis sees a continuous signal."
              >
                <Select
                  value={state.gapFill}
                  onChange={(_, d) =>
                    dispatch({ kind: 'setGapFill', value: d.value as GapFill })
                  }
                >
                  <option value="linear">Linear fill (recommended)</option>
                  <option value="none">Leave gaps as-is</option>
                </Select>
              </Field>

              {showScanGranularity && (
                <Field
                  label="Length-scan detail"
                  className={styles.select}
                  hint="How finely we slice the length range. Finer scans are more thorough but take longer."
                >
                  <Select
                    value={state.scanGranularity}
                    onChange={(_, d) =>
                      dispatch({
                        kind: 'setScanGranularity',
                        value: d.value as ScanGranularity,
                      })
                    }
                  >
                    <option value="coarse">Coarse (fastest)</option>
                    <option value="balanced">Balanced</option>
                    <option value="fine">Fine (most thorough)</option>
                  </Select>
                </Field>
              )}
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
