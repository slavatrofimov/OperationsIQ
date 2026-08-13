import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Global, app-wide preference controlling whether plain-language explanatory
 * content (page introductions and per-output descriptions) is shown.
 *
 * Democratization goal (functional spec §Democratization): non-expert users
 * benefit from inline guidance about what inputs mean and how to read outputs,
 * while expert users often want a denser, distraction-free surface. Centralizing
 * this preference lets one header control toggle explanations everywhere.
 *
 * Explanations are shown by default until the user makes an explicit choice,
 * which is then persisted and always wins.
 */

const STORAGE_KEY = 'tsi:showExplanations';

interface ExplanationsSettings {
  /** Whether plain-language explanatory content is currently shown. */
  showExplanations: boolean;
  /** Explicitly set the preference (persisted; overrides the mode default). */
  setShowExplanations: (show: boolean) => void;
  /** Toggle the current value. */
  toggleExplanations: () => void;
}

const ExplanationsContext = createContext<ExplanationsSettings | null>(null);

/** Read a previously persisted explicit choice, if any. */
function readStored(): boolean | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/**
 * Provides the global "show explanations" preference. When the user has not
 * made an explicit choice, the value tracks the persona mode (simple → on,
 * advanced → off). Once set explicitly it is persisted to localStorage.
 */
export function ExplanationsProvider({ children }: { children: ReactNode }) {
  // `null` means "no explicit user choice yet" — default to showing explanations.
  const [explicit, setExplicit] = useState<boolean | null>(readStored);

  const showExplanations = explicit ?? true;

  const setShowExplanations = useCallback((show: boolean) => {
    setExplicit(show);
    try {
      localStorage.setItem(STORAGE_KEY, String(show));
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value applies.
    }
  }, []);

  const toggleExplanations = useCallback(() => {
    setShowExplanations(!showExplanations);
  }, [showExplanations, setShowExplanations]);

  const value = useMemo(
    () => ({ showExplanations, setShowExplanations, toggleExplanations }),
    [showExplanations, setShowExplanations, toggleExplanations],
  );

  return (
    <ExplanationsContext.Provider value={value}>{children}</ExplanationsContext.Provider>
  );
}

/** Access the full explanations settings (value + setters). */
export function useExplanationsSettings(): ExplanationsSettings {
  const ctx = useContext(ExplanationsContext);
  if (!ctx) {
    // Fall back to a sensible default so components render outside a provider
    // (e.g. isolated tests). Setters are no-ops in that case.
    return {
      showExplanations: true,
      setShowExplanations: () => undefined,
      toggleExplanations: () => undefined,
    };
  }
  return ctx;
}

/** Convenience hook returning just the boolean preference. */
export function useShowExplanations(): boolean {
  return useExplanationsSettings().showExplanations;
}
