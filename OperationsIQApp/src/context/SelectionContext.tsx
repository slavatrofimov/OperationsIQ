import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TimeRange } from '../components/TimeRangePicker';
import { defaultRange } from '../lib/appTypes';

/**
 * App-session selection carried across pages: the current time window and the
 * "primary" tag selection. Pages hydrate their local range/tag state from here
 * on mount and write changes back, so a tag pick and time window follow the user
 * as they navigate — without every page reaching for the Contoso-only fixed
 * defaults.
 *
 * The tag list is a single shared "primary" selection:
 *   - Multi-tag pages read/write the whole list.
 *   - Single-tag pages read the first entry and write back just that one entry,
 *     which prunes unused extras once the user passes through such a page.
 *   - Role-specific pages (target + features/candidates/refs) prefill only their
 *     primary role from this list; secondary roles stay page-local.
 *
 * State is in-memory for the app session: `range` is seeded once (at provider
 * mount = app load) to the last 24 hours, and `tags` starts empty. A full reload
 * resets both, matching the "new session" defaults.
 */
interface SelectionState {
  /** Shared time window (defaults to the last 24 hours at app load). */
  range: TimeRange;
  setRange: (r: TimeRange) => void;
  /** Shared primary tag selection (defaults to empty). */
  tags: string[];
  setTags: (t: string[]) => void;
}

const SelectionContext = createContext<SelectionState | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  // Seed the window once, at mount, so it reflects the app-load time and is then
  // carried until the user changes it.
  const [range, setRange] = useState<TimeRange>(() => defaultRange());
  const [tags, setTags] = useState<string[]>([]);

  const value = useMemo<SelectionState>(
    () => ({ range, setRange, tags, setTags }),
    [range, tags],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

function useSelection(): SelectionState {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used within a SelectionProvider');
  return ctx;
}

/** Shared time window + setter. */
export function useSharedRange(): [TimeRange, (r: TimeRange) => void] {
  const { range, setRange } = useSelection();
  return [range, setRange];
}

/** Shared primary tag selection + setter. */
export function useSharedTags(): [string[], (t: string[]) => void] {
  const { tags, setTags } = useSelection();
  return [tags, setTags];
}

/**
 * Single-tag view over the shared selection, for pages whose primary input is
 * one tag (and for the primary role of target/feature pages). It exposes the
 * shared list collapsed to at most its first entry, and — once on mount —
 * prunes a carried multi-tag selection down to that primary tag so unused extras
 * don't keep propagating onward. Writing through replaces the shared selection,
 * reflecting the current page's primary pick.
 */
export function useSharedPrimaryTag(): [string[], (t: string[]) => void] {
  const { tags, setTags } = useSelection();
  useEffect(() => {
    if (tags.length > 1) setTags(tags.slice(0, 1));
    // Collapse once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep the single-tag array referentially stable while the primary tag id is
  // unchanged, so callers' `[tag]`-keyed effects/memos don't re-run every render.
  const primary = tags[0];
  const value = useMemo(() => (primary ? [primary] : []), [primary]);
  return [value, setTags];
}
