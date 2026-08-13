import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Global, app-wide cap on how many tags a multi-select tag picker allows. Some
 * environments expose thousands of tags, so an unbounded multi-select can lead
 * to selections that overwhelm downstream charts and queries. Centralizing the
 * limit in a context lets one control in the app settings drive the cap applied
 * by every multi-select tag picker across the app.
 */

/** Default maximum number of tags selectable in a multi-select picker. */
export const DEFAULT_TAG_SELECTION_LIMIT = 25;

/** Bounds for the tag-selection-limit control. */
export const MIN_TAG_SELECTION_LIMIT = 1;
export const MAX_TAG_SELECTION_LIMIT = 500;

const STORAGE_KEY = 'operationsIq.tagSelectionLimit';

interface TagSelectionLimitSettings {
  /** Maximum number of tags selectable in a multi-select picker. */
  limit: number;
  /** Update the limit (clamped and persisted). */
  setLimit: (n: number) => void;
}

const TagSelectionLimitContext = createContext<TagSelectionLimitSettings | null>(null);

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TAG_SELECTION_LIMIT;
  return Math.min(MAX_TAG_SELECTION_LIMIT, Math.max(MIN_TAG_SELECTION_LIMIT, Math.round(n)));
}

function readInitial(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_TAG_SELECTION_LIMIT;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw == null) return DEFAULT_TAG_SELECTION_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n) : DEFAULT_TAG_SELECTION_LIMIT;
}

/** Provides the global tag-selection limit, persisted to localStorage. */
export function TagSelectionLimitProvider({ children }: { children: ReactNode }) {
  const [limit, setLimitState] = useState<number>(readInitial);

  const setLimit = useCallback((n: number) => {
    const clamped = clamp(n);
    setLimitState(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value still applies.
    }
  }, []);

  const value = useMemo(() => ({ limit, setLimit }), [limit, setLimit]);

  return (
    <TagSelectionLimitContext.Provider value={value}>
      {children}
    </TagSelectionLimitContext.Provider>
  );
}

/** Access the full tag-selection-limit settings (value + setter). */
export function useTagSelectionLimitSettings(): TagSelectionLimitSettings {
  const ctx = useContext(TagSelectionLimitContext);
  if (!ctx) {
    // Fall back to the default so pickers behave sensibly even outside a provider
    // (e.g. isolated tests). The setter is a no-op in that case.
    return { limit: DEFAULT_TAG_SELECTION_LIMIT, setLimit: () => undefined };
  }
  return ctx;
}

/** Convenience hook returning just the current tag-selection limit. */
export function useTagSelectionLimit(): number {
  return useTagSelectionLimitSettings().limit;
}
