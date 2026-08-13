/**
 * All user-controllable settings for the Explore tab, plus their defaults.
 * Centralized here so the SettingsPanel, the query builders, and saved views
 * all agree on one shape.
 */

import type { Aggregation } from './kql';
import { AGGREGATION_OPTIONS } from './binningSettings';

export { AGGREGATION_OPTIONS };

/** How detail charts lay out multiple selected series. */
export type LayoutMode = 'combined' | 'separate' | 'smallMultiples';

/** Named quick ranges relative to the data's anchor date. */
export type RangePreset =
  | 'custom'
  | 'last24h'
  | 'last7d'
  | 'last14d'
  | 'last30d'
  | 'all';

export interface ExploreSettings {
  /** Aggregate applied per bin in make-series (overview). */
  aggregation: Aggregation;
  /** Maximum bins (points) to render per view; drives adaptive bin width (detail). */
  maxBins: number;
  /** Maximum bins for the coarse global overview chart. */
  globalMaxBins: number;
  /** Optional preferred bin width in milliseconds (overview); used when it fits within globalMaxBins. */
  preferredMillis: number | null;
  /** Aggregate applied per bin for the detail view (independent of the overview). */
  detailAggregation: Aggregation;
  /** Optional preferred bin width in milliseconds for the detail view; used when it fits within maxBins. */
  detailPreferredMillis: number | null;
  /** Anomaly detection sensitivity (lower = more sensitive). */
  sensitivity: number;
  /** Whether to compute and overlay anomalies. */
  showAnomalies: boolean;
  /** Whether to overlay the decomposition baseline on detail charts. */
  showBaseline: boolean;
  /** How to arrange multiple series in the detail view. */
  layout: LayoutMode;
  /** Share a single Y axis across separate/small-multiple charts. */
  sharedYAxis: boolean;
  /** Show event flags on the global overview. */
  showEvents: boolean;
  /** Show the descriptive-statistics + correlation panel. */
  showStatistics: boolean;
  /** Show the value-distribution panel (histogram, box plot, duration curve). */
  showDistributions: boolean;
  /** Smooth line rendering. */
  smoothLines: boolean;
  /** Currently selected quick-range preset (drives the time range). */
  rangePreset: RangePreset;
}

export const DEFAULT_SETTINGS: ExploreSettings = {
  aggregation: 'avg',
  maxBins: 5000,
  globalMaxBins: 600,
  preferredMillis: null,
  detailAggregation: 'avg',
  detailPreferredMillis: null,
  sensitivity: 1.5,
  showAnomalies: true,
  showBaseline: false,
  layout: 'combined',
  sharedYAxis: false,
  showEvents: true,
  showStatistics: true,
  showDistributions: true,
  smoothLines: false,
  rangePreset: 'custom',
};

export const LAYOUT_OPTIONS: { value: LayoutMode; label: string }[] = [
  { value: 'combined', label: 'Combined (one chart)' },
  { value: 'separate', label: 'Separate charts' },
  { value: 'smallMultiples', label: 'Small multiples' },
];

export const RANGE_PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: 'custom', label: 'Custom' },
  { value: 'last24h', label: 'Last 24 hours' },
  { value: 'last7d', label: 'Last 7 days' },
  { value: 'last14d', label: 'Last 14 days' },
  { value: 'last30d', label: 'Last 30 days' },
  { value: 'all', label: 'All data' },
];

/**
 * Builds an ECharts tooltip `valueFormatter` that rounds numeric values to a
 * fixed number of decimal places; non-numeric values pass through unchanged.
 */
export function tooltipValueFormatter(decimals: number) {
  return (value: unknown): string => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value.toFixed(decimals);
    }
    return value == null ? '' : String(value);
  };
}

/**
 * Shared ECharts time-axis label config. The level-aware formatter keeps date
 * context visible: day ticks read like "Jan 3" (month + day, not a bare number),
 * month/year boundaries stack the higher unit, and intraday ticks show the time.
 */
export const TIME_AXIS_LABEL = {
  hideOverlap: true,
  formatter: {
    year: '{yyyy}',
    month: '{MMM} {yyyy}',
    day: '{MMM} {d}',
    hour: '{HH}:{mm}',
    minute: '{HH}:{mm}',
    second: '{HH}:{mm}:{ss}',
    millisecond: '{HH}:{mm}:{ss}.{SSS}',
  },
} as const;

/**
 * Builds a cross axis-pointer label config for time-series charts. The time (x)
 * axis shows a formatted date/time; the value (y) axis rounds to the same number
 * of decimal places used by tooltips (via {@link useTooltipDecimals}), so the
 * crosshair readout matches the tooltip precision instead of showing raw floats.
 */
export function timeAxisPointerLabel(decimals: number) {
  return {
    formatter: (params: { value: number | string; axisDimension?: string }) => {
      // The cross pointer labels both axes; reformat each by dimension.
      if (params.axisDimension && params.axisDimension !== 'x') {
        return typeof params.value === 'number' && Number.isFinite(params.value)
          ? params.value.toFixed(decimals)
          : String(params.value);
      }
      const d = new Date(params.value);
      return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        // Query timestamps are pre-shifted into the preferred timezone by the KQL
        // layer, so render them verbatim as UTC (matches the chart's useUTC axis).
        timeZone: 'UTC',
      });
    },
  };
}
