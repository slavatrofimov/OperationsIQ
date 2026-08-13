/**
 * Capture-context registry.
 *
 * The "Add to investigation" button (in the app header) captures a Markdown
 * snapshot of the active page, but the page's interactive controls — selected
 * tags, the time range, brushes, and configuration toggles — are stripped from
 * that snapshot because they carry no readable text in the DOM (a slider or a
 * Fluent combobox exposes no value as text). Without them the evidence loses
 * the parameters that produced the results.
 *
 * Rather than scrape those controls out of the DOM (fragile and lossy), the
 * active page publishes a small, structured summary of its *real* state (tag
 * IDs resolved to names, ISO timestamps rendered as a readable window, key
 * settings, etc.). The capture flow reads the latest published summary and
 * renders it as a clean "Analysis parameters" section at the top of the
 * evidence Markdown. This keeps capture accurate and deterministic.
 *
 * A page publishes its summary with {@link useRegisterCaptureContext}; the
 * capture button reads it with {@link useCaptureContextReader}.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** One labelled parameter shown in the captured context summary. */
export interface CaptureField {
  label: string;
  /** Rendered value. Empty/whitespace-only values are dropped at render time. */
  value: string;
}

/** A group of related parameters, optionally under a sub-heading. */
export interface CaptureSection {
  title?: string;
  fields: CaptureField[];
}

/** The full set of contextual parameters a page contributes to a capture. */
export interface CaptureContextSummary {
  sections: CaptureSection[];
}

/** Returns the currently published summary, or null when none is registered. */
export type CaptureContextReader = () => CaptureContextSummary | null;

/** True when the summary actually contains at least one non-empty section. */
function summaryHasContent(summary: CaptureContextSummary | null): boolean {
  return (
    !!summary &&
    summary.sections.some((s) => s.fields.some((f) => String(f.value ?? '').trim() !== ''))
  );
}

interface CaptureRegistry {
  register: (summary: CaptureContextSummary | null) => void;
  read: CaptureContextReader;
  /** Reactive flag: whether the active page currently publishes context. */
  hasContext: boolean;
}

const CaptureRegistryContext = createContext<CaptureRegistry | null>(null);

/**
 * Holds the latest page-published capture summary in a ref so the header
 * capture button can read it on demand without re-rendering on every state
 * change of the active page. A separate `hasContext` flag is exposed reactively
 * so header controls can show/hide themselves; it only changes when context
 * presence toggles, not on every parameter edit.
 */
export function CaptureContextProvider({ children }: { children: ReactNode }) {
  const ref = useRef<CaptureContextSummary | null>(null);
  const [hasContext, setHasContext] = useState(false);
  const value = useMemo<CaptureRegistry>(
    () => ({
      register: (summary) => {
        ref.current = summary;
        // setState bails out when the boolean is unchanged, so this only
        // re-renders consumers when context appears or disappears.
        setHasContext(summaryHasContent(summary));
      },
      read: () => ref.current,
      hasContext,
    }),
    [hasContext],
  );
  return (
    <CaptureRegistryContext.Provider value={value}>
      {children}
    </CaptureRegistryContext.Provider>
  );
}

/**
 * Publish the active page's capture-context summary. Pass a memoized summary
 * (e.g. built with `useMemo` from the page's state) so it stays current; pass
 * `null` when there is nothing meaningful to capture. The summary is cleared
 * automatically when the page unmounts.
 */
export function useRegisterCaptureContext(summary: CaptureContextSummary | null): void {
  const registry = useContext(CaptureRegistryContext);
  useEffect(() => {
    if (!registry) return;
    registry.register(summary);
    return () => registry.register(null);
  }, [registry, summary]);
}

/** Read the currently published capture summary (for the capture flow). */
export function useCaptureContextReader(): CaptureContextReader {
  const registry = useContext(CaptureRegistryContext);
  return useCallback(() => registry?.read() ?? null, [registry]);
}

/** Reactively report whether the active page currently publishes context. */
export function useHasCaptureContext(): boolean {
  const registry = useContext(CaptureRegistryContext);
  return registry?.hasContext ?? false;
}
