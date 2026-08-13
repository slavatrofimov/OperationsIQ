import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TagInfo } from '../lib/tags';

/**
 * Global, app-wide preference controlling how tags are labelled in selectors,
 * charts, and tables.
 *
 * Tag names are not guaranteed to be unique — several distinct tags can share a
 * `tagName`. `tagId` is the stable, unique identifier. The preference offers
 * three modes so users can pick whichever identifier suits their workflow:
 * - `name`   — show the tag name only (default).
 * - `id`     — show the tag id only.
 * - `nameId` — show `Name (Id)` so otherwise identically-named tags stay
 *              distinguishable.
 * Centralizing the choice here lets a single setting in the Settings pane drive
 * labelling everywhere.
 */

/** How a tag is rendered wherever a label is shown. */
export type TagDisplayMode = 'name' | 'id' | 'nameId';

const STORAGE_KEY = 'operationsIq.tagDisplayMode';
/** Legacy boolean key (`'1'` == show `Name (Id)`), migrated on first read. */
const LEGACY_STORAGE_KEY = 'operationsIq.showTagId';

const VALID_MODES: readonly TagDisplayMode[] = ['name', 'id', 'nameId'];

interface TagDisplaySettings {
  /** The active tag-labelling mode. */
  tagDisplayMode: TagDisplayMode;
  /** Update the preference (persisted). */
  setTagDisplayMode: (mode: TagDisplayMode) => void;
}

const TagDisplayContext = createContext<TagDisplaySettings | null>(null);

function readInitial(): TagDisplayMode {
  if (typeof localStorage === 'undefined') return 'name';
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && (VALID_MODES as readonly string[]).includes(stored)) {
    return stored as TagDisplayMode;
  }
  // Migrate the legacy boolean preference: `'1'` meant "show Name (Id)".
  if (localStorage.getItem(LEGACY_STORAGE_KEY) === '1') return 'nameId';
  return 'name';
}

/** Provides the global tag-display preference, persisted to localStorage. */
export function TagDisplayProvider({ children }: { children: ReactNode }) {
  const [tagDisplayMode, setTagDisplayModeState] = useState<TagDisplayMode>(readInitial);

  const setTagDisplayMode = useCallback((mode: TagDisplayMode) => {
    setTagDisplayModeState(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Ignore storage failures (e.g. private mode); the in-memory value still applies.
    }
  }, []);

  const value = useMemo(
    () => ({ tagDisplayMode, setTagDisplayMode }),
    [tagDisplayMode, setTagDisplayMode],
  );

  return <TagDisplayContext.Provider value={value}>{children}</TagDisplayContext.Provider>;
}

/** Access the full tag-display settings (value + setter). */
export function useTagDisplaySettings(): TagDisplaySettings {
  const ctx = useContext(TagDisplayContext);
  if (!ctx) {
    return { tagDisplayMode: 'name', setTagDisplayMode: () => undefined };
  }
  return ctx;
}

/**
 * Format a single tag's display label honoring the current preference.
 * - `id`     → the tag id.
 * - `name`   → the tag name (falling back to the id when no name is known).
 * - `nameId` → `Name (Id)` when the id differs from the name, else just the name.
 */
export function formatTagLabel(
  tagName: string | undefined,
  tagId: string,
  mode: TagDisplayMode,
): string {
  const name = tagName ?? tagId;
  if (mode === 'id') return tagId || name;
  if (mode === 'nameId' && tagId && tagId !== name) return `${name} (${tagId})`;
  return name;
}

/** Convenience: format a {@link TagInfo} honoring the current preference. */
export function formatTagInfoLabel(tag: TagInfo, mode: TagDisplayMode): string {
  return formatTagLabel(tag.tagName, tag.tagId, mode);
}

/**
 * Hook returning a stable formatter that maps a `tagId` (and optional name) to a
 * display label using the current preference. Useful in charts/tables that only
 * have ids and a `Map<tagId, tagName>` on hand.
 */
export function useTagLabeler(): (tagId: string, tagName?: string) => string {
  const { tagDisplayMode } = useTagDisplaySettings();
  return useCallback(
    (tagId: string, tagName?: string) => formatTagLabel(tagName, tagId, tagDisplayMode),
    [tagDisplayMode],
  );
}
