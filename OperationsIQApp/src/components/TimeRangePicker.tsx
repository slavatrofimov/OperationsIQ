import { Field, type InfoLabelProps } from '@fluentui/react-components';
import { withInfo } from './fieldInfo';
import { DateTimeField } from './DateTimeField';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { toPreferredWallClock, fromPreferredWallClock } from '../lib/timezone';

export interface TimeRange {
  start: Date;
  end: Date;
}

export interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  disabled?: boolean;
  /** Optional explanatory popover shown via an info button next to "Start". */
  info?: InfoLabelProps['info'];
}

/**
 * Two `datetime-local` inputs bound to a start/end range. The inputs show and
 * accept wall-clock time in the app's preferred analysis timezone, so the range
 * a user types lines up with the (timezone-shifted) chart axes and query bins.
 */
export function TimeRangePicker({ value, onChange, disabled, info }: TimeRangePickerProps) {
  const offset = useTimezoneOffset();
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Field label={info ? withInfo('Start', info) : 'Start'}>
        <DateTimeField
          disabled={disabled}
          value={toPreferredWallClock(value.start, offset)}
          onChange={(v) => {
            const start = fromPreferredWallClock(v, offset);
            if (start) onChange({ ...value, start });
          }}
        />
      </Field>
      <Field label="End">
        <DateTimeField
          disabled={disabled}
          value={toPreferredWallClock(value.end, offset)}
          onChange={(v) => {
            const end = fromPreferredWallClock(v, offset);
            if (end) onChange({ ...value, end });
          }}
        />
      </Field>
    </div>
  );
}
