/**
 * Pure merge helper for governed signal metadata. Kept separate from
 * {@link module:signalMetadata} (which instantiates the RayFin client on import) so
 * the overlay logic can be unit-tested without any client/service configuration.
 */
import type { TagInfo } from './tags';
import type { SignalMetadataView } from './signalMetadata';

/**
 * Overlay governed metadata values onto a tag catalog so consumer pages see limits
 * immediately, regardless of OneLake-mirror latency in the KQL path. RayFin-sourced
 * values win over any catalog-sourced ones. Pass the map from
 * {@link getEffectiveSignalMetadata}. Tags without a governed record are returned
 * unchanged.
 */
export function applySignalMetadataToTags(
  tags: TagInfo[],
  metaBySignal: Map<string, SignalMetadataView>,
): TagInfo[] {
  if (metaBySignal.size === 0) return tags;
  return tags.map((t) => {
    const m = metaBySignal.get(t.tagId);
    if (!m) return t;
    const pick = <T>(governed: T | undefined, current: T | undefined): T | undefined =>
      governed !== undefined ? governed : current;
    return {
      ...t,
      operatingSetpoint: pick(m.operatingSetpoint, t.operatingSetpoint),
      upperOperatingLimit: pick(m.upperOperatingLimit, t.upperOperatingLimit),
      lowerOperatingLimit: pick(m.lowerOperatingLimit, t.lowerOperatingLimit),
      maxRateOfChange: pick(m.maxRateOfChange, t.maxRateOfChange),
      usl: pick(m.usl, t.usl),
      lsl: pick(m.lsl, t.lsl),
      target: pick(m.target, t.target),
      physicalMin: pick(m.physicalMin, t.physicalMin),
      physicalMax: pick(m.physicalMax, t.physicalMax),
      sensorUncertainty: pick(m.sensorUncertainty, t.sensorUncertainty),
      activeBaselineId: pick(m.activeBaselineId, t.activeBaselineId),
      preferredChartType: pick(m.preferredChartType, t.preferredChartType),
      ruleProfile: pick(m.ruleProfile, t.ruleProfile),
      recommendedAlertThreshold: pick(m.recommendedAlertThreshold, t.recommendedAlertThreshold),
      recommendedConfidence: pick(m.recommendedConfidence, t.recommendedConfidence),
    };
  });
}

/**
 * Human-readable, non-blocking warning shown when governed signal metadata
 * cannot be overlaid onto the tag catalog. The app keeps working on the raw
 * catalog values, but operators must know the displayed limits may be
 * incomplete or stale rather than silently trusting them.
 */
export function metadataOverlayWarning(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return (
    'Governed signal metadata could not be loaded, so displayed limits may be ' +
    'incomplete or stale. Showing raw catalog values. ' +
    `(${detail})`
  );
}
