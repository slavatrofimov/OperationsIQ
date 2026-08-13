/**
 * Pure helpers that derive per-page defaults from a tag's governed
 * {@link TagInfo} metadata (operating/spec limits, setpoint, rate limit, plausible
 * range, monitoring defaults). Consumer pages use these to *prefill* inputs so a
 * governed limit is entered once and reused everywhere — the values are always
 * overridable and never hard constraints. Keeping the logic here (rather than
 * inline in each page) makes the propagation rules consistent and unit-testable.
 */
import type { TagInfo } from './tags';

export type ThresholdDirection = 'above' | 'below';

/**
 * Breach threshold + direction for the Forecast page. Prefers the specification
 * limits (USL breaches upward, LSL downward), falling back to the operating
 * envelope. Returns `undefined` when the tag carries no relevant limit.
 */
export function forecastThresholdDefault(
  tag: TagInfo | undefined,
): { threshold: number; direction: ThresholdDirection } | undefined {
  if (!tag) return undefined;
  const upper = tag.usl ?? tag.upperOperatingLimit;
  if (upper != null) return { threshold: upper, direction: 'above' };
  const lower = tag.lsl ?? tag.lowerOperatingLimit;
  if (lower != null) return { threshold: lower, direction: 'below' };
  return undefined;
}

/**
 * Upper / lower risk limits for the What-if (Scenario) page. Prefers the operating
 * envelope (the band the process is expected to run within), falling back to the
 * specification limits.
 */
export function scenarioLimitDefaults(
  tag: TagInfo | undefined,
): { upperLimit?: number; lowerLimit?: number } {
  if (!tag) return {};
  return {
    upperLimit: tag.upperOperatingLimit ?? tag.usl,
    lowerLimit: tag.lowerOperatingLimit ?? tag.lsl,
  };
}

/**
 * Alert-rule prefill for a threshold-type alert: the level to alert on and the
 * direction of breach, plus an optional rate-of-change limit and default
 * confidence sourced from the tag's monitoring metadata.
 */
export function alertThresholdDefaults(
  tag: TagInfo | undefined,
): {
  threshold?: number;
  direction?: ThresholdDirection;
  ratePerMinute?: number;
  confidence?: number;
} {
  if (!tag) return {};
  const t = forecastThresholdDefault(tag);
  return {
    threshold: tag.recommendedAlertThreshold ?? t?.threshold,
    direction: t?.direction,
    ratePerMinute: tag.maxRateOfChange,
    confidence: tag.recommendedConfidence,
  };
}

/**
 * Plausible physical range for the Signal Validation page (residual / plausibility
 * bounds), widened by the sensor uncertainty when provided.
 */
export function validationRangeDefaults(
  tag: TagInfo | undefined,
): { min?: number; max?: number } {
  if (!tag) return {};
  const u = tag.sensorUncertainty ?? 0;
  return {
    min: tag.physicalMin != null ? tag.physicalMin - u : undefined,
    max: tag.physicalMax != null ? tag.physicalMax + u : undefined,
  };
}

/** Deviation-band confidence default for the Deviations (Monitor) page. */
export function monitorConfidenceDefault(tag: TagInfo | undefined): number | undefined {
  return tag?.recommendedConfidence;
}

/** Format a number for a text input, or '' when undefined. */
export function toInputValue(n: number | undefined): string {
  return n == null ? '' : String(n);
}
