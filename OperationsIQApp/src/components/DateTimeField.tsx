import { useEffect, useRef, useState } from 'react';
import { Input, type InputProps } from '@fluentui/react-components';

const pad = (n: number) => String(n).padStart(2, '0');

/** Format a Date as a `datetime-local` value ("YYYY-MM-DDTHH:mm") in local time. */
export function toDateTimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Parse a `datetime-local` string (local time) back to a Date, or null if empty/invalid. */
export function parseDateTimeLocal(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface DateTimeFieldProps
  extends Omit<InputProps, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  /** Controlled `datetime-local` string ("YYYY-MM-DDTHH:mm"), or '' for empty. */
  value: string;
  /** Emits the raw string the user typed — including '' while a value is incomplete. */
  onChange: (value: string) => void;
}

/**
 * A reliable wrapper around `<input type="datetime-local">`.
 *
 * Native date/time inputs are segmented (month / day / year / hour / minute). When such
 * an input is *fully controlled* in React, any re-render that pushes a value differing
 * from the DOM's in-progress edit causes the browser to reset every segment — so typing
 * the year can wipe the month and day the user already entered.
 *
 * To avoid that, this component renders from an internal text buffer that only the user's
 * own keystrokes mutate. The incoming `value` prop is adopted only when it represents a
 * genuine *external* change (e.g. a preset, a chart brush, or a form reset) rather than an
 * echo of what we just emitted. The result: edits are never clobbered mid-typing, while
 * programmatic updates still flow through.
 */
export function DateTimeField({ value, onChange, ...rest }: DateTimeFieldProps) {
  const [text, setText] = useState(value);
  // The last value we surfaced to the parent. Used to tell an external update apart
  // from the parent simply re-emitting (or rejecting and reverting) our own edit.
  const lastSeen = useRef(value);

  useEffect(() => {
    if (value !== lastSeen.current) {
      lastSeen.current = value;
      setText(value);
    }
  }, [value]);

  return (
    <Input
      {...rest}
      type="datetime-local"
      value={text}
      onChange={(_, data) => {
        lastSeen.current = data.value;
        setText(data.value);
        onChange(data.value);
      }}
    />
  );
}
