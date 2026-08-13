/**
 * BinningOutputs: a compact, read-only readout of the transparent adaptive
 * binning results for a range + settings — the effective resolution the engine
 * will actually use, the duration of the window, and the projected number of
 * points. Shown alongside the binning inputs on every analysis area so users
 * can see the consequence of their choices.
 */

import { Caption1, InfoLabel, makeStyles, tokens } from '@fluentui/react-components';
import { computeBinningOutputs, formatResolution, type BinningSettings } from '../lib/binningSettings';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalL,
    alignItems: 'flex-start',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  item: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '110px' },
  label: { color: tokens.colorNeutralForeground3 },
  value: { fontWeight: tokens.fontWeightSemibold },
});

const EFFECTIVE_INFO =
  'The bin width the engine will actually use, per bin. It is chosen to honor your preferred resolution when it fits within the max-points limit; otherwise the finest standard step that stays under the limit.';
const DURATION_INFO = 'The length of the selected window, from start to end.';
const POINTS_INFO =
  'How many points/bins the range produces at the effective resolution (duration ÷ effective resolution).';

export interface BinningOutputsProps {
  range: { start: Date; end: Date };
  settings: Pick<BinningSettings, 'maxBins' | 'preferredMillis'>;
  /**
   * Force the effective resolution to a specific bin width (milliseconds),
   * overriding what `range` + `settings` would otherwise produce. Used when the
   * resolution is dictated by a different, wider range (e.g. a similarity query
   * pattern that inherits the search-space resolution).
   */
  effectiveMillisOverride?: number | null;
}

/** Format an integer with thousands separators. */
function fmtInt(n: number): string {
  return n.toLocaleString();
}

export function BinningOutputs({ range, settings, effectiveMillisOverride }: BinningOutputsProps) {
  const styles = useStyles();
  const out = computeBinningOutputs(range, settings, effectiveMillisOverride);

  return (
    <div className={styles.root} role="group" aria-label="Binning outputs">
      <div className={styles.item}>
        <InfoLabel size="small" className={styles.label} info={EFFECTIVE_INFO}>
          Effective resolution
        </InfoLabel>
        <Caption1 className={styles.value}>
          {formatResolution(out.effectiveMillis)}/bin{out.label ? ` (${out.label})` : ''}
        </Caption1>
      </div>
      <div className={styles.item}>
        <InfoLabel size="small" className={styles.label} info={DURATION_INFO}>
          Duration
        </InfoLabel>
        <Caption1 className={styles.value}>
          {out.durationText} ({fmtInt(Math.round(out.durationMs / 1000))} s)
        </Caption1>
      </div>
      <div className={styles.item}>
        <InfoLabel size="small" className={styles.label} info={POINTS_INFO}>
          Points
        </InfoLabel>
        <Caption1 className={styles.value}>{fmtInt(out.points)}</Caption1>
      </div>
    </div>
  );
}
