import { useEffect } from 'react';
import {
  Field,
  Text,
  Radio,
  RadioGroup,
  SpinButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { WizardState, WizardAction, AbMode } from '../../../state/wizardState';
import {
  isCompareType,
  isMultiSeriesType,
  isMultiDimType,
  isConsensusType,
  MULTI_SERIES_MIN_SIGNALS,
} from '../../../state/wizardState';
import type { TagInfo } from '../../../lib/tags';
import { TagPicker } from '../../TagPicker';
import { useDataLimits } from '../../../context/DataLimitsContext';
import { AdaptiveBinningPanel } from '../../AdaptiveBinningPanel';
import type { TimeRange } from '../../TimeRangePicker';
import { DateTimeField } from '../../DateTimeField';
import { useTagLabeler } from '../../../context/TagDisplayContext';
import { useTerminology } from '../../../hooks/useTerminology';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
  timeRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  arrow: { color: tokens.colorNeutralForeground3 },
  seriesBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    borderLeft: `2px solid ${tokens.colorNeutralStroke2}`,
  },
});

/** A sensible starting window when none is set yet: the last 24 hours. */
function defaultRange(): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  return { start, end };
}

/**
 * Step 2 — "Which signal and time range?" The plain date pickers are replaced with the
 * shared adaptive-binning panel used across the app: the range picker (incl. "select
 * visually"), plus Max points, Preferred resolution and Aggregation. The chosen bin width
 * becomes the effective sample interval the Matrix Profile analysis runs at, so the same
 * controls that keep charts fast also bound the size of large Spark jobs (up to ~1M points).
 *
 * For the two-series "compare two periods or machines" recipes (AB-join), the step also
 * collects series B — either a second signal (two-signals mode) or a second time window of
 * the same signal (two-windows mode).
 */
export function SignalStep({
  state,
  dispatch,
  tags,
}: {
  state: WizardState;
  dispatch: (a: WizardAction) => void;
  tags: TagInfo[];
}) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const term = useTerminology();
  const { patternSearchMaxPoints } = useDataLimits();

  const selectedTag = tags.find((t) => t.tagId === state.signalId);
  const compareTag = tags.find((t) => t.tagId === state.compareSignalId);
  const isCompare = isCompareType(state.jobType);
  const isMulti = isMultiSeriesType(state.jobType);
  const isMultiDim = isMultiDimType(state.jobType);
  const isConsensus = isConsensusType(state.jobType);
  const abMode: AbMode = state.abMode ?? 'two-signals';
  const multiIds = state.signalIds ?? [];

  // Seed a default window on first mount so the binning panel always shows a valid range
  // (and the step can advance) without forcing the user to type two timestamps first.
  useEffect(() => {
    if (!state.windowStart || !state.windowEnd) {
      const r = defaultRange();
      dispatch({ kind: 'setWindow', start: r.start.toISOString(), end: r.end.toISOString() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const range: TimeRange =
    state.windowStart && state.windowEnd
      ? { start: new Date(state.windowStart), end: new Date(state.windowEnd) }
      : defaultRange();

  const handleTagChange = (ids: string[]) => {
    const id = ids[0];
    const tag = tags.find((t) => t.tagId === id);
    if (!tag) return;
    dispatch({
      kind: 'pickSignal',
      dataSourceId: tag.tagId, // use tagId as proxy dataSourceId (see note in spec §3)
      signalId: tag.tagId,
      sampleRateHz: 1,
    });
  };

  const handleCompareTagChange = (ids: string[]) => {
    const id = ids[0];
    const tag = tags.find((t) => t.tagId === id);
    if (!tag) return;
    dispatch({ kind: 'pickCompareSignal', signalId: tag.tagId, sampleRateHz: 1 });
  };

  const handleMultiTagsChange = (ids: string[]) => {
    dispatch({
      kind: 'setSignalIds',
      dataSourceId: ids[0] ?? '',
      signalIds: ids,
      sampleRateHz: 1,
    });
  };

  const handleRangeChange = (r: TimeRange) => {
    dispatch({ kind: 'setWindow', start: r.start.toISOString(), end: r.end.toISOString() });
  };

  const signalName = selectedTag ? labeler(selectedTag.tagId, selectedTag.tagName) : undefined;
  const multiSelectedTags = multiIds
    .map((id) => tags.find((t) => t.tagId === id))
    .filter((t): t is TagInfo => !!t);
  const multiHeading = isConsensus
    ? 'Which signals across the fleet?'
    : 'Which sensors and time range?';

  return (
    <div className={styles.root}>
      <Text weight="semibold">
        {isMulti
          ? multiHeading
          : isCompare
            ? 'Compare two series'
            : 'Which signal and time range?'}
      </Text>

      {isMulti && (
        <div className={styles.seriesBlock}>
          <TagPicker
            label={isConsensus ? `Fleet ${term.metricIdLabelPlural.toLowerCase()}` : `${term.metricIdLabelPlural} (one asset)`}
            tags={tags}
            selected={multiIds}
            onChange={handleMultiTagsChange}
            multiselect
            info={
              isConsensus
                ? 'Pick the same measurement from several assets. We find the one shape common to all of them — no time alignment needed.'
                : 'Pick several sensors from the same asset. We line them up on a common clock and find the events they share, then name which sensors took part.'
            }
          />
          <Text size={200} className={styles.hint}>
            {multiIds.length < MULTI_SERIES_MIN_SIGNALS
              ? `Select at least ${MULTI_SERIES_MIN_SIGNALS} signals.`
              : `${multiIds.length} signals selected.`}
          </Text>

          {isMultiDim && (
            <Text size={200} className={styles.hint}>
              These sensors are aligned onto a common clock at the resolution below, so a
              bin width is required — every sensor is read and gap-filled at the same
              interval before the analysis.
            </Text>
          )}

          <Field
            label={
              isConsensus
                ? 'Time window & resolution (shared by all signals)'
                : 'Time window & resolution (common clock)'
            }
          >
            <AdaptiveBinningPanel
              range={range}
              onRangeChange={handleRangeChange}
              settings={state.binning}
              onChange={(patch) => dispatch({ kind: 'setBinning', patch })}
              maxBinsLimit={patternSearchMaxPoints}
              signals={multiSelectedTags.map((t) => ({
                tagId: t.tagId,
                name: labeler(t.tagId, t.tagName),
              }))}
              tagId={multiSelectedTags[0]?.tagId}
              tagName={
                multiSelectedTags[0]
                  ? labeler(multiSelectedTags[0].tagId, multiSelectedTags[0].tagName)
                  : undefined
              }
              densityTagIds={multiIds.length > 0 ? multiIds : undefined}
            />
          </Field>

          {isConsensus && (
            <Field
              label="How many signals must share the shape?"
              hint={
                state.minCount == null
                  ? 'All selected signals (strict consensus).'
                  : `At least ${state.minCount} of ${multiIds.length}.`
              }
            >
              <SpinButton
                min={MULTI_SERIES_MIN_SIGNALS}
                max={Math.max(MULTI_SERIES_MIN_SIGNALS, multiIds.length)}
                value={state.minCount ?? multiIds.length}
                onChange={(_, data) => {
                  const v = data.value ?? Number(data.displayValue);
                  if (v == null || Number.isNaN(v)) return;
                  // Selecting all N is treated as strict consensus (minCount cleared).
                  dispatch({ kind: 'setMinCount', value: v >= multiIds.length ? undefined : v });
                }}
              />
            </Field>
          )}
        </div>
      )}

      {isCompare && (
        <Field label="What do you want to compare?">
          <RadioGroup
            layout="horizontal"
            value={abMode}
            onChange={(_, data) => dispatch({ kind: 'setAbMode', mode: data.value as AbMode })}
          >
            <Radio value="two-signals" label="Two signals" />
            <Radio value="two-windows" label="Two periods of one signal" />
          </RadioGroup>
        </Field>
      )}

      {!isMulti && (
        <div className={isCompare ? styles.seriesBlock : undefined}>
          {isCompare && <Text weight="semibold">Baseline (series A)</Text>}

          <TagPicker
            label={isCompare && abMode === 'two-signals' ? `Baseline ${term.metricIdLabel.toLowerCase()}` : term.metricIdLabel}
            tags={tags}
            selected={selectedTag ? [selectedTag.tagId] : []}
            onChange={handleTagChange}
          />

          <Field label={isCompare && abMode === 'two-windows' ? 'Baseline period & resolution' : 'Time window & resolution'}>
            <AdaptiveBinningPanel
              range={range}
              onRangeChange={handleRangeChange}
              settings={state.binning}
              onChange={(patch) => dispatch({ kind: 'setBinning', patch })}
              maxBinsLimit={patternSearchMaxPoints}
              signals={
                selectedTag
                  ? [{ tagId: selectedTag.tagId, name: signalName ?? selectedTag.tagName }]
                  : undefined
              }
              tagId={selectedTag?.tagId}
              tagName={signalName}
              densityTagIds={selectedTag ? [selectedTag.tagId] : undefined}
            />
          </Field>
        </div>
      )}
      {isCompare && (
        <div className={styles.seriesBlock}>
          <Text weight="semibold">Comparison (series B)</Text>

          {abMode === 'two-signals' ? (
            <>
              <TagPicker
                label={`Comparison ${term.metricIdLabel.toLowerCase()}`}
                tags={tags}
                selected={compareTag ? [compareTag.tagId] : []}
                onChange={handleCompareTagChange}
              />
              <Text size={200} className={styles.hint}>
                Series B is read over the same time window and resolution as the baseline.
              </Text>
            </>
          ) : (
            <Field label="Comparison period (same signal)">
              <div className={styles.timeRow}>
                <DateTimeField
                  value={state.compareWindowStart ?? ''}
                  onChange={(v) =>
                    dispatch({
                      kind: 'setCompareWindow',
                      start: v,
                      end: state.compareWindowEnd ?? v,
                    })
                  }
                />
                <Text className={styles.arrow}>→</Text>
                <DateTimeField
                  value={state.compareWindowEnd ?? ''}
                  onChange={(v) =>
                    dispatch({
                      kind: 'setCompareWindow',
                      start: state.compareWindowStart ?? v,
                      end: v,
                    })
                  }
                />
              </div>
            </Field>
          )}
        </div>
      )}

      {tags.length === 0 && (
        <Text size={200} className={styles.hint}>
          No tags available. Make sure a profile is active and sign in to the Eventhouse.
        </Text>
      )}
    </div>
  );
}
