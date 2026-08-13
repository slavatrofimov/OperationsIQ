import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  BROWSER_PREFERENCE,
  resolveOffsetMinutes,
  type TimezonePreference,
} from '../lib/timezone';
import { setQueryOffsetMinutes } from '../lib/queryTimezone';

/**
 * Global, app-wide preferred-analysis-timezone setting. Centralizing this in a
 * context (rather than threading it through every page) lets one control in the
 * Settings pane drive both:
 *   - the KQL query offset (via the queryTimezone singleton, which kql.ts reads
 *     to shift every datetime literal and the canonical Timestamp column), and
 *   - client-side display (via {@link useTimezone}, whose `offsetMinutes` feeds
 *     the shared formatters and the time-range picker).
 *
 * The stored preference is `'browser'` (track the machine offset — the default)
 * or a signed integer-minute string (a pinned fixed offset). A fixed offset is
 * used throughout: DST is not auto-handled (see queryTimezone.ts).
 */

const STORAGE_KEY = 'operationsIq.timezonePreference';

function readInitial(): TimezonePreference {
  if (typeof localStorage === 'undefined') return BROWSER_PREFERENCE;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw == null || raw === '' ? BROWSER_PREFERENCE : raw;
}

interface TimezoneSettings {
  /** Stored preference: `'browser'` or a signed integer-minute string. */
  preference: TimezonePreference;
  /** Resolved offset in minutes east of UTC (0 = UTC). */
  offsetMinutes: number;
  /** Update the preferred timezone (persisted; also updates the query offset). */
  setPreference: (pref: TimezonePreference) => void;
}

const TimezoneContext = createContext<TimezoneSettings | null>(null);

/** Provides the global preferred timezone, persisted to localStorage. */
export function TimezoneProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<TimezonePreference>(readInitial);

  const offsetMinutes = useMemo(() => resolveOffsetMinutes(preference), [preference]);

  // Keep the query-layer singleton in sync so kql.ts localizes queries. Runs on
  // mount (to seed the browser default) and on every change.
  useEffect(() => {
    setQueryOffsetMinutes(offsetMinutes);
  }, [offsetMinutes]);

  const setPreference = useCallback((pref: TimezonePreference) => {
    setPreferenceState(pref);
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value still applies.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, offsetMinutes, setPreference }),
    [preference, offsetMinutes, setPreference],
  );

  return <TimezoneContext.Provider value={value}>{children}</TimezoneContext.Provider>;
}

/** Access the full timezone settings (preference + resolved offset + setter). */
export function useTimezone(): TimezoneSettings {
  const ctx = useContext(TimezoneContext);
  if (!ctx) {
    // Fall back to the browser offset so components render sensibly even outside
    // a provider (e.g. isolated tests). The setter is a no-op in that case.
    return {
      preference: BROWSER_PREFERENCE,
      offsetMinutes: resolveOffsetMinutes(BROWSER_PREFERENCE),
      setPreference: () => undefined,
    };
  }
  return ctx;
}

/** Convenience hook returning just the resolved offset in minutes east of UTC. */
export function useTimezoneOffset(): number {
  return useTimezone().offsetMinutes;
}
