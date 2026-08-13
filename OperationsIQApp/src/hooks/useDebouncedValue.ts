import { useEffect, useState } from 'react';

/**
 * Return `value` delayed by `delayMs`, collapsing rapid changes into a single
 * trailing update. Used to keep per-keystroke catalog queries from firing on
 * every character; the query only runs once typing settles.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
