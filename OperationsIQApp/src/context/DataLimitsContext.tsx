import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { BIN_COUNT_MAX, BIN_COUNT_MAX_MP } from '../lib/binningSettings';

/**
 * Global, app-wide caps on how many data points (bins) analyses may request or
 * render. Historically these were hard-coded constants scattered across the app
 * (BIN_COUNT_MAX for charting pages, BIN_COUNT_MAX_MP for the Matrix Profile
 * wizard). Centralizing them in a persisted context lets one place in Settings
 * drive the ceilings applied everywhere, so power users can raise or lower them
 * to suit their environment.
 *
 * Two independent families:
 *  - visualizationMaxPoints — ceiling for the "Max points" control on every
 *    charting/analysis page (and the clamp ceiling used when hydrating binning
 *    settings). Kept bounded so the browser never tries to render millions.
 *  - patternSearchMaxPoints — the far larger ceiling used only by the Matrix
 *    Profile / pattern-search wizard, whose Spark jobs can legitimately need
 *    up to ~1M points.
 */

/** Visualization (charting) max-points bounds. Default mirrors {@link BIN_COUNT_MAX}. */
export const DEFAULT_VISUALIZATION_MAX_POINTS = BIN_COUNT_MAX;
export const MIN_VISUALIZATION_MAX_POINTS = 1_000;
export const MAX_VISUALIZATION_MAX_POINTS = 1_000_000;

/** Pattern-search (Matrix Profile) max-points bounds. Default mirrors {@link BIN_COUNT_MAX_MP}. */
export const DEFAULT_PATTERN_SEARCH_MAX_POINTS = BIN_COUNT_MAX_MP;
export const MIN_PATTERN_SEARCH_MAX_POINTS = 10_000;
export const MAX_PATTERN_SEARCH_MAX_POINTS = BIN_COUNT_MAX_MP;

const STORAGE_KEY = 'operationsIq.dataLimits';

interface DataLimitsSettings {
  /** Max points/bins any charting or analysis page may render. */
  visualizationMaxPoints: number;
  /** Max points the Matrix Profile / pattern-search wizard may request. */
  patternSearchMaxPoints: number;
  /** Update the visualization cap (clamped and persisted). */
  setVisualizationMaxPoints: (n: number) => void;
  /** Update the pattern-search cap (clamped and persisted). */
  setPatternSearchMaxPoints: (n: number) => void;
}

const DataLimitsContext = createContext<DataLimitsSettings | null>(null);

/** Clamp the visualization cap into its bounds and floor it to an integer. */
export function clampVisualizationMaxPoints(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_VISUALIZATION_MAX_POINTS;
  return Math.min(
    MAX_VISUALIZATION_MAX_POINTS,
    Math.max(MIN_VISUALIZATION_MAX_POINTS, Math.floor(n)),
  );
}

/** Clamp the pattern-search cap into its bounds and floor it to an integer. */
export function clampPatternSearchMaxPoints(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PATTERN_SEARCH_MAX_POINTS;
  return Math.min(
    MAX_PATTERN_SEARCH_MAX_POINTS,
    Math.max(MIN_PATTERN_SEARCH_MAX_POINTS, Math.floor(n)),
  );
}

interface StoredLimits {
  visualizationMaxPoints: number;
  patternSearchMaxPoints: number;
}

function readInitial(): StoredLimits {
  const fallback: StoredLimits = {
    visualizationMaxPoints: DEFAULT_VISUALIZATION_MAX_POINTS,
    patternSearchMaxPoints: DEFAULT_PATTERN_SEARCH_MAX_POINTS,
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredLimits>;
    return {
      visualizationMaxPoints: clampVisualizationMaxPoints(
        typeof parsed.visualizationMaxPoints === 'number'
          ? parsed.visualizationMaxPoints
          : DEFAULT_VISUALIZATION_MAX_POINTS,
      ),
      patternSearchMaxPoints: clampPatternSearchMaxPoints(
        typeof parsed.patternSearchMaxPoints === 'number'
          ? parsed.patternSearchMaxPoints
          : DEFAULT_PATTERN_SEARCH_MAX_POINTS,
      ),
    };
  } catch {
    return fallback;
  }
}

/** Provides the global data-point limits, persisted to localStorage. */
export function DataLimitsProvider({ children }: { children: ReactNode }) {
  const [limits, setLimits] = useState<StoredLimits>(readInitial);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(limits));
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value still applies.
    }
  }, [limits]);

  const setVisualizationMaxPoints = useCallback((n: number) => {
    setLimits((prev) => ({ ...prev, visualizationMaxPoints: clampVisualizationMaxPoints(n) }));
  }, []);

  const setPatternSearchMaxPoints = useCallback((n: number) => {
    setLimits((prev) => ({ ...prev, patternSearchMaxPoints: clampPatternSearchMaxPoints(n) }));
  }, []);

  const value = useMemo(
    () => ({
      visualizationMaxPoints: limits.visualizationMaxPoints,
      patternSearchMaxPoints: limits.patternSearchMaxPoints,
      setVisualizationMaxPoints,
      setPatternSearchMaxPoints,
    }),
    [limits, setVisualizationMaxPoints, setPatternSearchMaxPoints],
  );

  return <DataLimitsContext.Provider value={value}>{children}</DataLimitsContext.Provider>;
}

/** Access the full data-limits settings (values + setters). */
export function useDataLimits(): DataLimitsSettings {
  const ctx = useContext(DataLimitsContext);
  if (!ctx) {
    // Fall back to defaults so components behave sensibly even outside a provider
    // (e.g. isolated tests). The setters are no-ops in that case.
    return {
      visualizationMaxPoints: DEFAULT_VISUALIZATION_MAX_POINTS,
      patternSearchMaxPoints: DEFAULT_PATTERN_SEARCH_MAX_POINTS,
      setVisualizationMaxPoints: () => undefined,
      setPatternSearchMaxPoints: () => undefined,
    };
  }
  return ctx;
}
