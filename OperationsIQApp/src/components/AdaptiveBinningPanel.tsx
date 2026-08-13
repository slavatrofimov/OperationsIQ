/**
 * AdaptiveBinningPanel: the single, reusable adaptive-binning surface used by
 * every analysis area. It bundles, in one consistent layout:
 *
 *  - INPUTS: an Absolute / Relative time toggle (Absolute shows Start / End via
 *    the shared SegmentPicker incl. "select visually"; Relative shows a "Last N
 *    unit" window that resolves against now), Max points, Preferred resolution
 *    (value + unit), Aggregation.
 *  - OUTPUTS: Effective resolution (sec/bin), Duration, Number of points.
 *  - A soft over-resolution warning when the chosen resolution is finer than
 *    the raw data supports (opt in by passing `densityTagIds`).
 *
 * Flexible props let it adapt to every case:
 *  - `rangeReadOnly` — show Start/End but disable editing (e.g. Explore Detail,
 *    whose range is driven by the overview brush).
 *  - `showInputs={false}` — outputs-only mode (e.g. the Similarity query pattern
 *    area, whose resolution is dictated by the search-space controls).
 */

import {
  Body1Strong,
  Button,
  Caption1,
  Field,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Select,
  SpinButton,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowCounterclockwise16Regular, Bookmark16Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRawDataDensity } from '../hooks/useRawDataDensity';
import { useDataLimits } from '../context/DataLimitsContext';
import {
  AGGREGATION_OPTIONS,
  BIN_COUNT_MIN,
  BIN_COUNT_STEP,
  DEFAULT_RELATIVE_SPEC,
  PREFERRED_MILLIS_MAX,
  RELATIVE_UNIT_OPTIONS,
  RESOLUTION_UNIT_OPTIONS,
  chooseBinFor,
  formatResolution,
  millisToValueUnit,
  resolveRelativeRange,
  valueUnitToMillis,
  type BinningSettings,
  type RelativeTimeSpec,
  type RelativeUnit,
  type ResolutionUnit,
} from '../lib/binningSettings';import type { Aggregation } from '../lib/kql';
import { BinningOutputs } from './BinningOutputs';
import { SegmentPicker } from './SegmentPicker';
import type { PreviewSignal } from './TimeRangeOverlay';
import type { TimeRange } from './TimeRangePicker';
import { withInfo } from './fieldInfo';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { formatInstant } from '../lib/timezone';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  inputs: {
    display: 'flex',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  agg: { minWidth: '150px' },
  num: { maxWidth: '160px' },
  prefRow: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' },
  prefNum: { maxWidth: '110px' },
  prefUnit: { minWidth: '110px' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  relField: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  relRow: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalL,
    flexWrap: 'wrap',
  },
  effRange: { color: tokens.colorNeutralForeground3 },
});

const AGG_INFO =
  'How multiple raw readings inside each time bucket are combined into one plotted point. Average smooths, Min/Max keep extremes, Sum totals, Count shows how many readings arrived.';
const MAX_POINTS_INFO =
  'The most data points computed per series. The bin width is chosen automatically to stay under this limit, keeping analysis fast and readable. Raise it for more detail on a narrow range.';
const PREFERRED_INFO =
  'Force a specific bucket width instead of choosing one automatically. Only applied when it still fits within the max-points limit. Leave the value at 0 for automatic.';
const TIME_MODE_INFO =
  'Absolute pins the window to fixed Start / End timestamps. Relative tracks a rolling window that always ends "now" (e.g. the last hour), so re-running keeps up with the latest data.';
const LAST_INFO =
  'A rolling window measured back from the current time. Enter a whole number and a unit (e.g. 1 hour, 30 minutes, 3 months); the effective start/end shown below is recomputed from "now" each time you change it.';

/** Format a Date for the effective-range readout in the preferred analysis tz. */
function formatDateTime(d: Date, offsetMinutes: number): string {
  return formatInstant(d, offsetMinutes, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export interface AdaptiveBinningPanelProps {
  /** Optional heading shown above the controls. */
  title?: string;

  // --- range ---
  range: TimeRange;
  onRangeChange?: (range: TimeRange) => void;
  /** Show Start/End but disable editing (range is controlled elsewhere). */
  rangeReadOnly?: boolean;
  /**
   * Lock the time control to relative ("Last N unit") mode: the Absolute/Relative
   * switch and the absolute Start/End picker are hidden entirely. Used by the Live
   * view page, whose window is always a rolling window ending at "now".
   */
  relativeOnly?: boolean;
  /**
   * Controlled relative-window spec. When provided (together with
   * {@link onRelSpecChange}) the panel uses it instead of its own internal state,
   * letting the parent derive the window length (e.g. to drive a live poll).
   */
  relSpec?: RelativeTimeSpec;
  /** Change handler for the controlled {@link relSpec}. */
  onRelSpecChange?: (spec: RelativeTimeSpec) => void;
  /** Signals to preview in the "select visually" overlay. */
  signals?: PreviewSignal[];
  tagId?: string;
  tagName?: string;
  contextRange?: TimeRange;
  /** Explanatory popover next to the Start field. */
  rangeInfo?: Parameters<typeof withInfo>[1];

  // --- binning inputs ---
  settings: BinningSettings;
  onChange?: (patch: Partial<BinningSettings>) => void;
  /** Render the Max points / Preferred resolution / Aggregation inputs (default true). */
  showInputs?: boolean;
  /** Hide just the aggregation control. */
  hideAggregation?: boolean;
  /**
   * Upper bound for the Max points input. When omitted, defaults to the
   * user-configurable visualization cap (`visualizationMaxPoints`, 50k by
   * default) from DataLimitsContext; the Matrix Profile wizard passes the
   * larger, user-configurable pattern-search ceiling (up to ~1M) because its
   * Spark jobs can need that many points.
   */
  maxBinsLimit?: number;
  /** Promote current settings to the global default. */
  onSaveAsDefault?: () => void;
  /** Reset current settings back to the global default. */
  onReset?: () => void;
  /** Whether current settings differ from the global default. */
  isCustom?: boolean;

  /**
   * Force the displayed effective resolution to a specific bin width
   * (milliseconds), overriding what this panel's range + settings would produce.
   * Used for outputs-only areas whose resolution is dictated elsewhere (e.g. the
   * Similarity query pattern, which inherits the search-space resolution).
   */
  effectiveMillisOverride?: number | null;

  /** Disable all inputs (e.g. while a query runs). */
  disabled?: boolean;
  /**
   * Lock the binning inputs (Max points, Preferred resolution, Save/Reset) so the
   * effective resolution can't be changed. Used by the granularity-locked
   * Similarity search (Scenario 2), whose bin is pinned to the discovered
   * pattern. The range and outputs stay visible; only the bin controls disable.
   */
  lockBinningInputs?: boolean;

  // --- over-resolution safeguard ---
  /** When provided, runs a lightweight raw-count check and shows a soft warning. */
  densityTagIds?: string[];
  /** Turn the density check off without removing the tag ids. */
  densityEnabled?: boolean;
}

/** Bounded numeric SpinButton field. */
function NumberField(props: {
  label: string;
  info: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  className?: string;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={withInfo(props.label, props.info)} className={props.className}>
      <SpinButton
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onChange={(_, d) => {
          const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
          if (Number.isFinite(n)) {
            props.onChange(Math.min(props.max, Math.max(props.min, Math.floor(n))));
          }
        }}
      />
    </Field>
  );
}

/** Preferred-resolution input: a numeric value plus a unit (ms / sec / min / hour). */
function PreferredResolutionField(props: {
  millis: number;
  disabled?: boolean;
  onChange: (millis: number) => void;
}) {
  const styles = useStyles();
  const { value, unit } = millisToValueUnit(props.millis);
  const emit = (v: number, u: ResolutionUnit) =>
    props.onChange(Math.min(PREFERRED_MILLIS_MAX, valueUnitToMillis(v, u)));
  return (
    <Field
      label={withInfo('Preferred resolution', PREFERRED_INFO)}
    >
      <div className={styles.prefRow}>
        <SpinButton
          className={styles.prefNum}
          value={value}
          min={0}
          step={1}
          disabled={props.disabled}
          onChange={(_, d) => {
            const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
            if (Number.isFinite(n)) emit(Math.max(0, n), unit);
          }}
        />
        <Select
          className={styles.prefUnit}
          value={unit}
          disabled={props.disabled}
          onChange={(_, d) => emit(value, d.value as ResolutionUnit)}
        >
          {RESOLUTION_UNIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

/**
 * Relative-window input: an integer value plus a unit (seconds … months), under
 * a "Last" heading, with a read-only readout of the effective absolute range the
 * window currently resolves to. Mirrors {@link PreferredResolutionField} but
 * adds `months` support.
 */
function RelativeTimeField(props: {
  spec: RelativeTimeSpec;
  range: TimeRange;
  disabled?: boolean;
  onChange: (spec: RelativeTimeSpec) => void;
  /** Extra control rendered at the end of the Last / unit row. */
  trailing?: ReactNode;
}) {
  const styles = useStyles();
  const tzOffset = useTimezoneOffset();
  return (
    <div className={styles.relField}>
      <div className={styles.relRow}>
        <Field label={withInfo('Last', LAST_INFO)}>
          <div className={styles.prefRow}>
            <SpinButton
              className={styles.prefNum}
              value={props.spec.value}
              min={1}
              step={1}
              disabled={props.disabled}
              onChange={(_, d) => {
                const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
                if (Number.isFinite(n)) {
                  props.onChange({ ...props.spec, value: Math.max(1, Math.floor(n)) });
                }
              }}
            />
            <Select
              className={styles.prefUnit}
              value={props.spec.unit}
              disabled={props.disabled}
              onChange={(_, d) => props.onChange({ ...props.spec, unit: d.value as RelativeUnit })}
            >
              {RELATIVE_UNIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        {props.trailing}
      </div>
      <Caption1 className={styles.effRange}>
        Effective range: {formatDateTime(props.range.start, tzOffset)} – {formatDateTime(props.range.end, tzOffset)}
      </Caption1>
    </div>
  );
}

export function AdaptiveBinningPanel({
  title,
  range,
  onRangeChange,
  rangeReadOnly,
  relativeOnly,
  relSpec: relSpecProp,
  onRelSpecChange,
  signals,
  tagId,
  tagName,
  contextRange,
  rangeInfo,
  settings,
  onChange,
  showInputs = true,
  hideAggregation,
  maxBinsLimit,
  onSaveAsDefault,
  onReset,
  isCustom,
  effectiveMillisOverride,
  disabled,
  lockBinningInputs,
  densityTagIds,
  densityEnabled = true,
}: AdaptiveBinningPanelProps) {
  const styles = useStyles();
  const { visualizationMaxPoints } = useDataLimits();
  // When no explicit ceiling is passed, honor the user-configurable visualization
  // cap (the Matrix Profile wizard passes its own, larger pattern-search ceiling).
  const effectiveMaxBins = maxBinsLimit ?? visualizationMaxPoints;

  const effectiveMillis =
    effectiveMillisOverride && effectiveMillisOverride > 0
      ? effectiveMillisOverride
      : chooseBinFor(range, settings).millis;
  const density = useRawDataDensity({
    tagIds: densityTagIds ?? [],
    start: range.start,
    end: range.end,
    effectiveMillis,
    enabled: (densityTagIds?.length ?? 0) > 0 && densityEnabled && !disabled,
  });

  const rangeEditable = !rangeReadOnly && !!onRangeChange;

  // Absolute (fixed Start/End) vs Relative (rolling "Last N unit") time mode.
  // Absolute is the default; relative mode is only offered when the range is
  // editable here (not when it is driven by an external selector, e.g. the
  // Explore detail window controlled by the overview brush). When `relativeOnly`
  // is set the mode is forced to relative and the toggle/absolute picker are hidden.
  const [timeMode, setTimeMode] = useState<'absolute' | 'relative'>('absolute');
  const [internalRelSpec, setInternalRelSpec] = useState<RelativeTimeSpec>(DEFAULT_RELATIVE_SPEC);

  // Effective relative spec: controlled (prop) when provided, else internal state.
  const relSpec = relSpecProp ?? internalRelSpec;
  const setRelSpec = onRelSpecChange ?? setInternalRelSpec;
  const effectiveTimeMode: 'absolute' | 'relative' = relativeOnly ? 'relative' : timeMode;

  // Keep the latest onRangeChange in a ref so the resolver effect below can push
  // the computed window up without listing the callback in its deps (which would
  // re-fire on every parent render and, because each run re-anchors to "now",
  // create a feedback loop).
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  useEffect(() => {
    if (effectiveTimeMode !== 'relative' || !rangeEditable) return;
    onRangeChangeRef.current?.(resolveRelativeRange(relSpec));
  }, [effectiveTimeMode, relSpec, rangeEditable]);

  return (
    <div className={styles.root}>
      {title && <Body1Strong>{title}</Body1Strong>}

      {rangeEditable ? (
        (() => {
          const relativeToggle = relativeOnly ? null : (
            <Field label={withInfo('Use relative time range', TIME_MODE_INFO)}>
              <Switch
                checked={timeMode === 'relative'}
                disabled={disabled}
                onChange={(_, d) => setTimeMode(d.checked ? 'relative' : 'absolute')}
              />
            </Field>
          );
          return effectiveTimeMode === 'relative' ? (
            <RelativeTimeField
              spec={relSpec}
              range={range}
              disabled={disabled}
              onChange={setRelSpec}
              trailing={relativeToggle}
            />
          ) : (
            <SegmentPicker
              value={range}
              onChange={onRangeChange ?? (() => {})}
              signals={signals}
              tagId={tagId}
              tagName={tagName}
              contextRange={contextRange}
              aggregation={settings.aggregation}
              disabled={disabled}
              info={rangeInfo}
              trailing={relativeToggle}
            />
          );
        })()
      ) : (
        <SegmentPicker
          value={range}
          onChange={onRangeChange ?? (() => {})}
          signals={signals}
          tagId={tagId}
          tagName={tagName}
          contextRange={contextRange}
          aggregation={settings.aggregation}
          disabled={disabled || !rangeEditable}
          info={rangeInfo}
        />
      )}

      {showInputs && onChange && (
        <div className={styles.inputs}>
          {!hideAggregation && (
            <Field label={withInfo('Aggregation (per bin)', AGG_INFO)} className={styles.agg}>
              <Select
                value={settings.aggregation}
                disabled={disabled}
                onChange={(_, d) => onChange({ aggregation: d.value as Aggregation })}
              >
                {AGGREGATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <NumberField
            label="Max points"
            info={MAX_POINTS_INFO}
            value={settings.maxBins}
            min={BIN_COUNT_MIN}
            max={effectiveMaxBins}
            step={BIN_COUNT_STEP}
            disabled={disabled || lockBinningInputs}
            className={styles.num}
            onChange={(n) => onChange({ maxBins: n })}
          />

          <PreferredResolutionField
            millis={settings.preferredMillis ?? 0}
            disabled={disabled || lockBinningInputs}
            onChange={(ms) => onChange({ preferredMillis: ms > 0 ? ms : null })}
          />

          {(onSaveAsDefault || onReset) && (
            <div className={styles.actions}>
              {onReset && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<ArrowCounterclockwise16Regular />}
                  disabled={disabled || lockBinningInputs || isCustom === false}
                  onClick={onReset}
                >
                  Reset
                </Button>
              )}
              {onSaveAsDefault && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Bookmark16Regular />}
                  disabled={disabled || lockBinningInputs}
                  onClick={onSaveAsDefault}
                  title="Use these binning settings as the default on all pages"
                >
                  Set as default
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <BinningOutputs
        range={range}
        settings={settings}
        effectiveMillisOverride={effectiveMillisOverride}
      />

      {density.overResolved && (
        <MessageBar intent="warning">
          <MessageBarBody>
            The chosen resolution ({formatResolution(effectiveMillis)}/bin) is finer than this data
            supports — the densest selected signal has about{' '}
            {density.maxTagCount?.toLocaleString()} raw records here (≈ 1 every{' '}
            {formatResolution(Math.round(density.nativeMillis ?? 0))}), but the range projects{' '}
            {density.projectedPoints.toLocaleString()} points. Empty bins will be interpolated;
            examine the data before relying on fine detail.
          </MessageBarBody>
          {onChange && density.recommendedMillis != null && (
            <MessageBarActions>
              <Link
                onClick={() =>
                  onChange({ preferredMillis: density.recommendedMillis ?? null })
                }
              >
                Use {formatResolution(density.recommendedMillis)}
              </Link>
            </MessageBarActions>
          )}
        </MessageBar>
      )}
    </div>
  );
}
