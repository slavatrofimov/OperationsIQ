/**
 * Shared field factories for `useControlledPage`. These build the common
 * controllable inputs that nearly every analysis page exposes — a tag/signal
 * selector, a time range, and the adaptive-binning (temporal resolution)
 * controls — so each page's agent wiring stays a few lines and behaves
 * identically everywhere.
 *
 * A page composes these with its own page-specific fields, e.g.:
 *
 *   useControlledPage({
 *     pageKey: 'forecast', title: 'Forecast',
 *     fields: [
 *       tagField({ tags, current: tag, set: setTag }),
 *       rangeField({ current: range, set: setRange }),
 *       ...binningFields(binning),
 *       pfInteger(...),
 *     ],
 *     canRun, run, loading, error, hasResult,
 *   });
 */
import { pf, coerce, type ControlledField } from './usePageController';
import type { TagInfo } from '../lib/tags';
import type { TimeRange } from '../components/TimeRangePicker';
import type { PageBinning } from '../context/BinningContext';
import {
  AGGREGATION_OPTIONS,
  labelForMillis,
  PREFERRED_MILLIS_MAX,
} from '../lib/binningSettings';

/**
 * Resolve loosely-typed agent tokens (tag names OR tag ids, in any case) to
 * canonical tag ids using the page's known tags. Throws a clear message listing
 * any token that cannot be matched.
 */
function resolveTagIds(tokens: string[], tags: TagInfo[]): string[] {
  const byId = new Map(tags.map((t) => [t.tagId, t.tagId]));
  const byName = new Map(tags.map((t) => [t.tagName.toLowerCase(), t.tagId]));
  const out: string[] = [];
  const unknown: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const id = byId.get(token) ?? byName.get(token.toLowerCase());
    if (id) out.push(id);
    else unknown.push(raw);
  }
  if (unknown.length) {
    throw new Error(
      `unknown tag(s): ${unknown.join(', ')}. Use describe_current_page to see valid tag names.`,
    );
  }
  return out;
}

export interface TagFieldOptions {
  tags: TagInfo[];
  current: string[];
  set: (ids: string[]) => void;
  /** Allow multiple tags (default: false — single-select). */
  multi?: boolean;
  name?: string;
  label?: string;
  required?: boolean;
  description?: string;
}

/** A tag/signal selector field. Accepts tag names or ids from the agent. */
export function tagField(opts: TagFieldOptions): ControlledField {
  const {
    tags,
    current,
    set,
    multi = false,
    name = 'tags',
    label = multi ? 'Tags' : 'Tag',
    required = true,
    description = multi
      ? 'One or more signal names to analyze.'
      : 'The signal name to analyze.',
  } = opts;
  return {
    field: pf.tags(name, label, current, { description, required }),
    apply: (value) => {
      const ids = resolveTagIds(coerce.stringArray(value), tags);
      set(multi ? ids : ids.slice(0, 1));
    },
  };
}

export interface RangeFieldOptions {
  current: TimeRange;
  set: (range: TimeRange) => void;
  name?: string;
  label?: string;
  description?: string;
}

/** A time-range (start/end) field. Accepts ISO-8601 start/end strings. */
export function rangeField(opts: RangeFieldOptions): ControlledField {
  const {
    current,
    set,
    name = 'range',
    label = 'Time range',
    description = 'Analysis window as ISO-8601 start/end timestamps.',
  } = opts;
  return {
    field: pf.daterange(
      name,
      label,
      { start: current.start.toISOString(), end: current.end.toISOString() },
      { description },
    ),
    apply: (value) => {
      const v = value as { start?: unknown; end?: unknown } | null;
      if (!v || typeof v !== 'object') return 'expected { start, end } ISO timestamps';
      const start = new Date(String(v.start));
      const end = new Date(String(v.end));
      if (Number.isNaN(start.getTime())) return 'invalid start timestamp';
      if (Number.isNaN(end.getTime())) return 'invalid end timestamp';
      if (start.getTime() >= end.getTime()) return 'start must be before end';
      set({ start, end });
    },
  };
}

/**
 * The adaptive-binning (temporal resolution) fields — aggregation and preferred
 * resolution in seconds. This is what lets the agent refine a "too coarse"
 * analysis to a finer resolution and re-run it. `resolution` of 0 means "auto".
 */
export function binningFields(binning: PageBinning): ControlledField[] {
  const aggValues = AGGREGATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
  return [
    {
      field: pf.enumOf('aggregation', 'Aggregation', binning.settings.aggregation, aggValues, {
        description: 'How raw points are combined within each time bin.',
      }),
      apply: (value) => {
        const v = coerce.enumValue(
          value,
          aggValues.map((a) => a.value),
        );
        binning.patch({ aggregation: v as (typeof aggValues)[number]['value'] });
      },
    },
    {
      field: pf.integer(
        'resolution',
        'Temporal resolution (milliseconds)',
        binning.settings.preferredMillis ?? 0,
        {
          min: 0,
          max: PREFERRED_MILLIS_MAX,
          description:
            'Preferred bin width in milliseconds; 0 = auto. Lower it for a finer resolution ' +
            `(e.g. ${labelForMillis(3600000)} = 3600000), raise it for coarser.`,
        },
      ),
      apply: (value) => {
        const ms = coerce.integer(value, { min: 0, max: PREFERRED_MILLIS_MAX });
        binning.patch({ preferredMillis: ms > 0 ? ms : null });
      },
    },
  ];
}
