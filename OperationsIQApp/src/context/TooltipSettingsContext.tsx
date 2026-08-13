import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Global, app-wide formatting preferences for chart tooltips. Centralizing this
 * in a context (rather than threading it through every page's local state) lets
 * one control in the app header drive the decimal precision of numeric values
 * shown in every chart tooltip across the app.
 */

/** Default decimal places shown for numeric values in chart tooltips. */
export const DEFAULT_TOOLTIP_DECIMALS = 4;

/** Bounds for the tooltip-decimals control. */
export const MIN_TOOLTIP_DECIMALS = 0;
export const MAX_TOOLTIP_DECIMALS = 10;

const STORAGE_KEY = 'operationsIq.tooltipDecimals';

interface TooltipSettings {
  /** Number of decimal places shown for values in chart tooltips. */
  decimals: number;
  /** Update the tooltip decimal places (clamped and persisted). */
  setDecimals: (n: number) => void;
}

const TooltipSettingsContext = createContext<TooltipSettings | null>(null);

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TOOLTIP_DECIMALS;
  return Math.min(MAX_TOOLTIP_DECIMALS, Math.max(MIN_TOOLTIP_DECIMALS, Math.round(n)));
}

function readInitial(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_TOOLTIP_DECIMALS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw == null) return DEFAULT_TOOLTIP_DECIMALS;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n) : DEFAULT_TOOLTIP_DECIMALS;
}

/** Provides global tooltip formatting settings, persisted to localStorage. */
export function TooltipSettingsProvider({ children }: { children: ReactNode }) {
  const [decimals, setDecimalsState] = useState<number>(readInitial);

  const setDecimals = useCallback((n: number) => {
    const clamped = clamp(n);
    setDecimalsState(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value still applies.
    }
  }, []);

  const value = useMemo(() => ({ decimals, setDecimals }), [decimals, setDecimals]);

  return (
    <TooltipSettingsContext.Provider value={value}>{children}</TooltipSettingsContext.Provider>
  );
}

/** Access the full tooltip settings (value + setter). */
export function useTooltipSettings(): TooltipSettings {
  const ctx = useContext(TooltipSettingsContext);
  if (!ctx) {
    // Fall back to the default so charts render sensibly even outside a provider
    // (e.g. isolated tests). The setter is a no-op in that case.
    return { decimals: DEFAULT_TOOLTIP_DECIMALS, setDecimals: () => undefined };
  }
  return ctx;
}

/** Convenience hook returning just the tooltip decimal places. */
export function useTooltipDecimals(): number {
  return useTooltipSettings().decimals;
}
