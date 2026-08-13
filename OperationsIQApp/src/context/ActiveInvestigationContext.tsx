import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * The "active investigation" is the app-wide target for newly captured evidence.
 *
 * When a user adds evidence from any analysis page, it flows into the active
 * investigation by default until they explicitly activate a different one (or
 * create a new investigation, which becomes active). Activation is deliberately
 * separate from *viewing*: browsing an investigation on the Investigations page
 * does not change the capture target — only "Set as active" (or creating one)
 * does.
 *
 * The choice is a lightweight client-side preference (id + display name),
 * persisted to localStorage so it survives reloads, following the same pattern
 * as {@link ExplanationsContext}.
 */

const STORAGE_KEY = 'tsi:activeInvestigation';

/** The persisted/active investigation reference, or null when none is set. */
export interface ActiveInvestigationRef {
  id: string;
  name: string;
}

interface ActiveInvestigationSettings {
  /** The currently active investigation, or null when none is set. */
  active: ActiveInvestigationRef | null;
  /** Mark an investigation as the active capture target (persisted). */
  setActive: (investigation: ActiveInvestigationRef) => void;
  /** Clear the active investigation (e.g. after it is deleted). */
  clearActive: () => void;
  /**
   * Reconcile the active reference against the latest known investigations:
   * clears it if the id no longer exists, and refreshes a stale display name.
   */
  reconcile: (investigations: ActiveInvestigationRef[]) => void;
}

const ActiveInvestigationContext = createContext<ActiveInvestigationSettings | null>(null);

/** Read a previously persisted active investigation, if any. */
function readStored(): ActiveInvestigationRef | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveInvestigationRef>;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') {
      return { id: parsed.id, name: parsed.name };
    }
  } catch {
    // Ignore malformed/inaccessible storage; treat as "no active investigation".
  }
  return null;
}

function persist(ref: ActiveInvestigationRef | null): void {
  try {
    if (ref) localStorage.setItem(STORAGE_KEY, JSON.stringify(ref));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures (e.g. private mode); the in-memory value applies.
  }
}

/** Provides the app-wide active-investigation preference. */
export function ActiveInvestigationProvider({ children }: { children: ReactNode }) {
  const [active, setActiveState] = useState<ActiveInvestigationRef | null>(readStored);

  const setActive = useCallback((investigation: ActiveInvestigationRef) => {
    const ref = { id: investigation.id, name: investigation.name };
    setActiveState(ref);
    persist(ref);
  }, []);

  const clearActive = useCallback(() => {
    setActiveState(null);
    persist(null);
  }, []);

  const reconcile = useCallback((investigations: ActiveInvestigationRef[]) => {
    setActiveState((prev) => {
      if (!prev) return prev;
      const match = investigations.find((i) => i.id === prev.id);
      if (!match) {
        persist(null);
        return null;
      }
      if (match.name !== prev.name) {
        const next = { id: prev.id, name: match.name };
        persist(next);
        return next;
      }
      return prev;
    });
  }, []);

  const value = useMemo<ActiveInvestigationSettings>(
    () => ({ active, setActive, clearActive, reconcile }),
    [active, setActive, clearActive, reconcile],
  );

  return (
    <ActiveInvestigationContext.Provider value={value}>
      {children}
    </ActiveInvestigationContext.Provider>
  );
}

/** Access the active-investigation preference (value + setters). */
export function useActiveInvestigation(): ActiveInvestigationSettings {
  const ctx = useContext(ActiveInvestigationContext);
  if (!ctx) {
    // Sensible no-op fallback so components render outside a provider (tests).
    return {
      active: null,
      setActive: () => undefined,
      clearActive: () => undefined,
      reconcile: () => undefined,
    };
  }
  return ctx;
}
