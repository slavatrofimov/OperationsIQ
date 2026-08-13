import { Field, Select, SpinButton, makeStyles, tokens } from '@fluentui/react-components';
import {
  DURATION_UNIT_OPTIONS,
  durationToSeconds,
  secondsToDuration,
  type DurationUnit,
} from '../../../lib/mp/units';

const useStyles = makeStyles({
  row: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'flex-end' },
  num: { maxWidth: '110px' },
  unit: { minWidth: '80px' },
});

/**
 * A duration input expressed as a value + unit (sec / min / hour / day), mirroring the
 * adaptive-binning "preferred resolution" control but spanning a much wider range so a
 * single field can express a few seconds up to a year or more. Emits whole seconds.
 */
export function DurationField({
  label,
  seconds,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  seconds: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const styles = useStyles();
  const { value, unit } = secondsToDuration(seconds);
  const emit = (v: number, u: DurationUnit) => onChange(durationToSeconds(v, u));

  return (
    <Field label={label} hint={hint}>
      <div className={styles.row}>
        <SpinButton
          className={styles.num}
          value={value}
          min={0}
          step={1}
          disabled={disabled}
          onChange={(_, d) => {
            const n = d.value ?? (d.displayValue != null ? Number(d.displayValue) : NaN);
            if (Number.isFinite(n)) emit(Math.max(0, Math.floor(n)), unit);
          }}
        />
        <Select
          className={styles.unit}
          value={unit}
          disabled={disabled}
          onChange={(_, d) => emit(value, d.value as DurationUnit)}
        >
          {DURATION_UNIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}
