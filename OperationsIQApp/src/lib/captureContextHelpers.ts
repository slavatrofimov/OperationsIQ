/**
 * Shared helpers for building page capture-context summaries.
 *
 * Analysis pages publish their filters and settings for both evidence capture
 * and the "View context" panel via {@link useRegisterCaptureContext}. These
 * helpers centralize the formatting (readable time windows, tag-name
 * resolution, binning settings) so every page renders context consistently and
 * page-level wiring stays small.
 */

import type { CaptureField } from '../context/CaptureContext';
import type { BinningSettings } from './binningSettings';
import { AGGREGATION_OPTIONS, formatResolution } from './binningSettings';

/** Human-readable local date+time (e.g. "Jan 6, 2026, 07:00 PM"). */
export function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a [start, end] window plus a human-friendly duration. */
export function fmtWindow(start: Date, end: Date): string {
  const ms = Math.max(0, end.getTime() - start.getTime());
  const mins = Math.round(ms / 60000);
  const dur =
    mins < 60
      ? `${mins} min`
      : mins < 60 * 24
        ? `${(mins / 60).toFixed(1)} h`
        : `${(mins / (60 * 24)).toFixed(1)} d`;
  return `${fmtDateTime(start)} - ${fmtDateTime(end)} (${dur})`;
}

/** Boolean rendered as Yes/No. */
export const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');

/** Resolve tag IDs to a comma-separated list of names (falling back to the id). */
export function tagNames(ids: string[], nameById: Map<string, string>): string {
  return ids.map((id) => nameById.get(id) ?? id).join(', ');
}

/** Friendly label for an aggregation value (e.g. "avg" -> "Average"). */
export function aggregationLabel(agg: string): string {
  return AGGREGATION_OPTIONS.find((o) => o.value === agg)?.label ?? agg;
}

/**
 * Standard binning-settings fields (aggregation, max bins, preferred bin
 * width), suitable for appending to a "Configuration" section on any page that
 * uses the shared binning controls.
 */
export function binningFields(settings: BinningSettings): CaptureField[] {
  return [
    { label: 'Aggregation', value: aggregationLabel(settings.aggregation) },
    { label: 'Max bins', value: String(settings.maxBins) },
    {
      label: 'Preferred bin width',
      value: settings.preferredMillis != null ? formatResolution(settings.preferredMillis) : 'Auto',
    },
  ];
}
