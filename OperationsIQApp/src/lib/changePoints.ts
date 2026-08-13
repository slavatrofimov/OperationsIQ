/**
 * Change-point detection backed by KQL `series_fit_2lines`.
 *
 * `series_fit_2lines` fits two straight-line segments to a series and returns
 * the single split index that maximizes the combined R-square. That one break
 * is the signal's most significant *change point* — either a level shift (the
 * two segments have similar slopes but a jump between them) or a slope break
 * (the trend rate changes). We parse the single-row KQL result and derive:
 *
 *  - the break timestamp (from the split index into the shared time axis),
 *  - the slope change (rightSlope − leftSlope, per bin),
 *  - the level shift (gap between the two fitted lines at the break), and
 *  - a coarse classification of which kind of change dominates,
 *
 * so the page can annotate the chart and badge the split strength.
 */
import { rowsToObjects, type KustoTable } from './eventhouse';

/** How much of the change is a discrete jump vs a change in trend rate. */
export type ChangeKind = 'level-shift' | 'slope-break' | 'mixed' | 'none';

export interface ChangePoint {
  tagId: string;
  /** Unix ms timestamps (shared axis for value + fit). */
  t: number[];
  value: (number | null)[];
  /** The combined two-line fitted series, same length as `t` (for charting). */
  lineFit: (number | null)[];
  /** Fit quality of the two-line model, 0..1 (higher = a cleaner break). */
  rSquare: number;
  /** Zero-based index of the break into `t`. */
  splitIdx: number;
  /** Break timestamp (unix ms), or null if the split index is out of range. */
  splitTime: number | null;
  variance: number;
  rVariance: number;
  /** Per-bin slope of the fitted line left/right of the break. */
  leftSlope: number;
  rightSlope: number;
  leftInterception: number;
  rightInterception: number;
  /** rightSlope − leftSlope (change in trend rate, per bin). */
  slopeDelta: number;
  /** Gap between the right and left fitted lines evaluated at the break. */
  levelShift: number;
  kind: ChangeKind;
}

interface ChangePointRow {
  SignalId: string;
  Timestamp: string[];
  Value: (number | null)[];
  LineFit: (number | null)[];
  RSquare: number;
  SplitIdx: number;
  Variance: number;
  RVariance: number;
  LeftSlope: number;
  RightSlope: number;
  LeftInterception: number;
  RightInterception: number;
}

function toNums(a: unknown): (number | null)[] {
  return ((a as (number | null)[]) ?? []).map((x) => (x == null ? null : Number(x)));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify the change from its level shift and slope change, each expressed as
 * a fraction of the signal's spread so the thresholds are scale-free. A change
 * is "none" when neither component is material; otherwise the larger component
 * wins, or "mixed" when they are comparable.
 */
function classify(levelFrac: number, slopeFrac: number): ChangeKind {
  const MIN = 0.05;
  if (levelFrac < MIN && slopeFrac < MIN) return 'none';
  if (levelFrac >= 2 * slopeFrac) return 'level-shift';
  if (slopeFrac >= 2 * levelFrac) return 'slope-break';
  return 'mixed';
}

/** Parse the single-row {@link buildChangePointsQuery} result. */
export function parseChangePoint(table: KustoTable): ChangePoint | null {
  const r = rowsToObjects<ChangePointRow>(table)[0];
  if (!r) return null;
  const t = (r.Timestamp ?? []).map((x) => new Date(x).getTime());
  if (t.length === 0) return null;
  const value = toNums(r.Value);
  const lineFit = toNums(r.LineFit);
  const splitIdx = Number.isInteger(r.SplitIdx) ? r.SplitIdx : -1;
  const splitTime = splitIdx >= 0 && splitIdx < t.length ? t[splitIdx] : null;

  const leftSlope = num(r.LeftSlope);
  const rightSlope = num(r.RightSlope);
  const leftInterception = num(r.LeftInterception);
  const rightInterception = num(r.RightInterception);
  const slopeDelta = rightSlope - leftSlope;

  // The fitted lines are y = slope·index + interception. Their gap at the break
  // index is the discrete level shift between the two segments.
  const idx = splitIdx >= 0 ? splitIdx : 0;
  const leftAtBreak = leftSlope * idx + leftInterception;
  const rightAtBreak = rightSlope * idx + rightInterception;
  const levelShift = rightAtBreak - leftAtBreak;

  // Scale the two components by the signal's spread so classification is
  // scale-free. Slope change is multiplied by the series length to express it
  // as the total divergence the differing slopes would accumulate.
  const finite = value.filter((x): x is number => x != null && Number.isFinite(x));
  const spread = finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
  const levelFrac = spread > 0 ? Math.abs(levelShift) / spread : 0;
  const slopeFrac = spread > 0 ? (Math.abs(slopeDelta) * t.length) / spread : 0;

  return {
    tagId: r.SignalId,
    t,
    value,
    lineFit,
    rSquare: num(r.RSquare),
    splitIdx,
    splitTime,
    variance: num(r.Variance),
    rVariance: num(r.RVariance),
    leftSlope,
    rightSlope,
    leftInterception,
    rightInterception,
    slopeDelta,
    levelShift,
    kind: classify(levelFrac, slopeFrac),
  };
}
