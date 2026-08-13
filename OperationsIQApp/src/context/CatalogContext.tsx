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
import type { TagInfo } from '../lib/tags';
import { approxCountTags, getTagsByIds } from '../lib/catalog';
import { catalogModeForCount, type CatalogMode } from '../lib/catalogMode';
import { profileToKqlOpts } from '../lib/connectionProfile';
import {
  getEffectiveSignalMetadata,
  type SignalMetadataView,
} from '../lib/signalMetadata';
import { metadataOverlayWarning } from '../lib/signalMetadataMerge';
import { useProfile } from './ProfileContext';
import { useSharedTags } from './SelectionContext';
import { useTagDisplaySettings } from './TagDisplayContext';
import {
  mergeResolvedWithMetadata,
  reoverlayCache,
  resolveTagLabel,
  selectMissing,
} from './catalogCache';

/**
 * App-wide cache of resolved tag metadata for the *selected* (and recently
 * browsed) ids. It is the scalable replacement for reading labels / selected-tag
 * details out of the full in-memory `TagInfo[]`: as the shared primary selection
 * changes, this provider resolves the picked ids on demand via
 * `catalog.getTagsByIds` and keeps only that bounded set in memory. Labels,
 * "selected tags" summaries and per-tag lookups read from here.
 *
 * The cache is additive and non-breaking: pages that still receive a full `tags`
 * array keep working, and `labelFor` accepts a caller-supplied fallback name so
 * callers that already hold a name (e.g. a chart's local map) never regress while
 * an id is still resolving.
 */
interface CatalogContextValue {
  /** Resolved metadata for requested ids, keyed by `tagId`. */
  resolvedTags: ReadonlyMap<string, TagInfo>;
  /** One resolved tag, or `undefined` if it has not been fetched yet. */
  getTag: (id: string) => TagInfo | undefined;
  /** Ensure metadata for these ids is fetched and cached (deduped, coalesced). */
  resolveIds: (ids: string[]) => void;
  /** Seed the cache with already-known tags (e.g. picker results, small mode). */
  seedTags: (tags: TagInfo[]) => void;
  /** Cache-aware display label honoring the tag-display mode, with a name fallback. */
  labelFor: (id: string, fallbackName?: string) => string;
  /** True while at least one resolution query is in flight. */
  isResolving: boolean;
  /**
   * Data-access mode for the active connection, chosen from a one-time size
   * probe: `'small'` (in-memory catalog) or `'large'` (server-backed). Defaults
   * to `'small'` while the probe is in flight or if it failed, so the app never
   * regresses to a worse path than today. See {@link catalogModeForCount}.
   */
  mode: CatalogMode;
  /**
   * Approximate signal count from the size probe, or `null` while unknown (probe
   * in flight, no active profile, or probe failed). Drives {@link mode}.
   */
  approxCount: number | null;
  /**
   * True once the one-time size probe has resolved (successfully or not) for the
   * active connection. Consumers that must choose between the full in-memory load
   * and the server-backed path should wait for this before deciding, so they do
   * not eagerly full-load during the brief window where {@link mode} still reads
   * its `'small'` default while the probe is in flight.
   */
  probeSettled: boolean;
  /**
   * Non-blocking warning shown when governed signal metadata could not be
   * overlaid onto the *large-mode* resolved cache (the small-mode full-load path
   * surfaces its own warning in `App`). `null` when metadata loaded cleanly or is
   * not applicable (small mode). The app keeps working on raw catalog limits.
   */
  metadataWarning: string | null;
  /** Dismiss the current {@link metadataWarning}. */
  clearMetadataWarning: () => void;
}

const CatalogContext = createContext<CatalogContextValue | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { activeProfile } = useProfile();
  const { tagDisplayMode } = useTagDisplaySettings();
  const [selectedIds] = useSharedTags();

  const [resolvedTags, setResolvedTags] = useState<ReadonlyMap<string, TagInfo>>(
    () => new Map(),
  );
  const [inFlightCount, setInFlightCount] = useState(0);
  const [approxCount, setApproxCount] = useState<number | null>(null);
  const [probeSettled, setProbeSettled] = useState(false);
  const [metaBySignal, setMetaBySignal] = useState<ReadonlyMap<string, SignalMetadataView>>(
    () => new Map(),
  );
  const [metadataWarning, setMetadataWarning] = useState<string | null>(null);

  // Latest values read inside async callbacks without widening effect deps.
  const resolvedRef = useRef(resolvedTags);
  resolvedRef.current = resolvedTags;
  const inFlightIdsRef = useRef<Set<string>>(new Set());
  const profileRef = useRef(activeProfile);
  profileRef.current = activeProfile;
  // Governed metadata read inside the seed/resolve callbacks: overlaying at merge
  // time is what gives the large-mode resolved cache its governed limits.
  const metaRef = useRef(metaBySignal);
  metaRef.current = metaBySignal;

  const profileId = activeProfile?.id;
  const mode = catalogModeForCount(approxCount);

  // Metadata is profile-scoped: dropping the cache when the active profile
  // changes prevents labels from one connection leaking into another.
  useEffect(() => {
    setResolvedTags(new Map());
    inFlightIdsRef.current = new Set();
    setInFlightCount(0);
    setApproxCount(null);
    setProbeSettled(false);
    setMetaBySignal(new Map());
    setMetadataWarning(null);
  }, [profileId]);

  // One-time catalog size probe per connection. Best-effort: on error we leave
  // `approxCount` null so the app stays in the zero-risk small (in-memory) mode.
  // The active profile is read from a ref so switching profiles re-runs this via
  // the profileId dep without widening it to object identity.
  useEffect(() => {
    if (!profileId) return;
    const profile = profileRef.current;
    if (!profile) return;
    let cancelled = false;
    const controller = new AbortController();
    approxCountTags(profile, profileToKqlOpts(profile), { signal: controller.signal })
      .then((count) => {
        if (cancelled || profileRef.current?.id !== profile.id) return;
        setApproxCount(count);
      })
      .catch(() => {
        // Probe is best-effort; absence of a count keeps mode = 'small'.
      })
      .finally(() => {
        // Mark settled either way so consumers waiting to choose a data-access
        // path stop waiting; on failure `mode` stays 'small' (zero-risk default).
        if (cancelled || profileRef.current?.id !== profile.id) return;
        setProbeSettled(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [profileId]);

  // Governed signal-metadata overlay for the *large-mode* path. In small mode the
  // full catalog load overlays limits up front (in App); large mode never loads
  // the full catalog, so instead we load the (bounded, human-curated) governed map
  // once per connection and overlay it onto the resolved-selection cache — both as
  // ids resolve (via the seed/resolve merge) and, here, by backfilling any ids that
  // resolved before the map arrived. Best-effort: on failure we keep raw catalog
  // limits and surface a non-blocking warning, exactly like the small-mode path.
  useEffect(() => {
    if (!profileId) return;
    // Wait for the size probe to pick the mode; only large mode needs this overlay.
    if (!probeSettled || mode !== 'large') return;
    let cancelled = false;
    getEffectiveSignalMetadata(profileId)
      .then((meta) => {
        if (cancelled || profileRef.current?.id !== profileId) return;
        setMetaBySignal(meta);
        setMetadataWarning(null);
        // Backfill limits onto ids already resolved before the map landed.
        if (meta.size > 0) setResolvedTags((prev) => reoverlayCache(prev, meta));
      })
      .catch((e) => {
        if (cancelled || profileRef.current?.id !== profileId) return;
        setMetadataWarning(metadataOverlayWarning(e));
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, probeSettled, mode]);

  const seedTags = useCallback((tags: TagInfo[]) => {
    if (!tags || tags.length === 0) return;
    setResolvedTags((prev) => mergeResolvedWithMetadata(prev, tags, metaRef.current));
  }, []);

  const resolveIds = useCallback(
    (ids: string[]) => {
      const profile = profileRef.current;
      if (!profile) return;
      const missing = selectMissing(
        ids,
        (id) => resolvedRef.current.has(id) || inFlightIdsRef.current.has(id),
      );
      if (missing.length === 0) return;

      for (const id of missing) inFlightIdsRef.current.add(id);
      setInFlightCount((n) => n + 1);

      const opts = profileToKqlOpts(profile);
      getTagsByIds(profile, missing, opts)
        .then((rows) => {
          // Ignore stale results from a since-switched profile.
          if (profileRef.current?.id !== profile.id) return;
          if (rows.length > 0) {
            setResolvedTags((prev) => mergeResolvedWithMetadata(prev, rows, metaRef.current));
          }
        })
        .catch(() => {
          // Resolution is best-effort; labels fall back to the id on failure.
        })
        .finally(() => {
          for (const id of missing) inFlightIdsRef.current.delete(id);
          setInFlightCount((n) => Math.max(0, n - 1));
        });
    },
    [],
  );

  // Keep the shared primary selection resolved as it changes.
  useEffect(() => {
    if (!profileId || selectedIds.length === 0) return;
    resolveIds(selectedIds);
  }, [profileId, selectedIds, resolveIds]);

  const getTag = useCallback((id: string) => resolvedTags.get(id), [resolvedTags]);

  const labelFor = useCallback(
    (id: string, fallbackName?: string) =>
      resolveTagLabel(resolvedTags, id, tagDisplayMode, fallbackName),
    [resolvedTags, tagDisplayMode],
  );

  const clearMetadataWarning = useCallback(() => setMetadataWarning(null), []);

  const value = useMemo<CatalogContextValue>(
    () => ({
      resolvedTags,
      getTag,
      resolveIds,
      seedTags,
      labelFor,
      isResolving: inFlightCount > 0,
      mode,
      approxCount,
      probeSettled,
      metadataWarning,
      clearMetadataWarning,
    }),
    [
      resolvedTags,
      getTag,
      resolveIds,
      seedTags,
      labelFor,
      inFlightCount,
      mode,
      approxCount,
      probeSettled,
      metadataWarning,
      clearMetadataWarning,
    ],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

/** Access the catalog selection-resolution cache. */
export function useCatalog(): CatalogContextValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalog must be used within a CatalogProvider');
  return ctx;
}

/**
 * The active connection's catalog data-access mode (`'small'` | `'large'`),
 * derived from the one-time size probe. Convenience wrapper over
 * {@link useCatalog} for the many callers that only care about the mode.
 */
export function useCatalogMode(): CatalogMode {
  return useCatalog().mode;
}
