/**
 * BinningContext: an app-wide default for adaptive-binning settings
 * (aggregation, max points, preferred bin width), persisted to localStorage so
 * a user's preference carries across pages and sessions.
 *
 * Pages don't usually consume the global default directly; they use
 * {@link usePageBinning}, which seeds page-local state from the global default
 * (or a page-specific seed for pages with special needs) and lets the user
 * override per page, optionally promoting the local values to the global
 * default.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_BINNING_SETTINGS,
  parseBinningSettings,
  type BinningSettings,
} from '../lib/binningSettings';
import { useDataLimits } from './DataLimitsContext';

const STORAGE_KEY = 'tsi:binningDefaults';

function loadDefaults(maxBinsLimit: number): BinningSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_BINNING_SETTINGS };
    return parseBinningSettings(JSON.parse(raw), maxBinsLimit);
  } catch {
    return { ...DEFAULT_BINNING_SETTINGS };
  }
}

interface BinningContextValue {
  defaults: BinningSettings;
  setDefaults: (patch: Partial<BinningSettings>) => void;
  resetDefaults: () => void;
}

const BinningContext = createContext<BinningContextValue | null>(null);

export function BinningProvider({ children }: { children: ReactNode }) {
  const { visualizationMaxPoints } = useDataLimits();
  const [defaults, setDefaultsState] = useState<BinningSettings>(() =>
    loadDefaults(visualizationMaxPoints),
  );

  const persist = useCallback((next: BinningSettings) => {
    setDefaultsState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, []);

  const setDefaults = useCallback(
    (patch: Partial<BinningSettings>) => {
      persist(parseBinningSettings({ ...defaults, ...patch }, visualizationMaxPoints));
    },
    [defaults, persist, visualizationMaxPoints],
  );

  const resetDefaults = useCallback(() => {
    persist({ ...DEFAULT_BINNING_SETTINGS });
  }, [persist]);

  const value = useMemo(
    () => ({ defaults, setDefaults, resetDefaults }),
    [defaults, setDefaults, resetDefaults],
  );

  return <BinningContext.Provider value={value}>{children}</BinningContext.Provider>;
}

/** Access (and mutate) the global binning defaults. */
export function useBinningDefaults(): BinningContextValue {
  const ctx = useContext(BinningContext);
  if (!ctx) throw new Error('useBinningDefaults must be used within a BinningProvider');
  return ctx;
}

export interface PageBinning {
  /** Effective binning settings for this page. */
  settings: BinningSettings;
  /** Patch the page-local settings. */
  patch: (patch: Partial<BinningSettings>) => void;
  /** Promote the current page-local settings to the global default. */
  saveAsDefault: () => void;
  /** Reset the page-local settings back to the global default. */
  resetToDefault: () => void;
  /** True when page-local settings differ from the global default. */
  isCustom: boolean;
}

function sameSettings(a: BinningSettings, b: BinningSettings): boolean {
  return (
    a.aggregation === b.aggregation &&
    a.maxBins === b.maxBins &&
    a.preferredMillis === b.preferredMillis
  );
}

/**
 * Page-local binning state seeded from the global default.
 *
 * @param seed Optional starting overrides for pages with special needs (e.g.
 *   Segmentation clustering wants far fewer bins). When provided, these override
 *   the corresponding global-default fields for this page's initial state; the
 *   user can still change them.
 */
export function usePageBinning(seed?: Partial<BinningSettings>): PageBinning {
  const { defaults, setDefaults } = useBinningDefaults();
  const { visualizationMaxPoints } = useDataLimits();
  // Seed once from the global default (+ page seed). Later changes to the global
  // default do not clobber a page the user is actively working on.
  const [settings, setSettings] = useState<BinningSettings>(() =>
    parseBinningSettings({ ...defaults, ...seed }, visualizationMaxPoints),
  );

  const patch = useCallback(
    (p: Partial<BinningSettings>) => {
      setSettings((s) => parseBinningSettings({ ...s, ...p }, visualizationMaxPoints));
    },
    [visualizationMaxPoints],
  );

  const saveAsDefault = useCallback(() => {
    setDefaults(settings);
  }, [setDefaults, settings]);

  const resetToDefault = useCallback(() => {
    setSettings({ ...defaults });
  }, [defaults]);

  const isCustom = !sameSettings(settings, defaults);

  return { settings, patch, saveAsDefault, resetToDefault, isCustom };
}
