import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectionProfile } from '../lib/connectionProfile';
import { profileToKqlOpts } from '../lib/connectionProfile';
import { getHierarchyChildren, searchTags, DEFAULT_SEARCH_TAKE } from '../lib/catalog';
import {
  createLazyTree,
  setRootLoading,
  setRootChildren,
  setRootError,
  toggleNode,
  setNodeLoading,
  setNodeChildren,
  setNodeTags,
  setNodeError,
  type LazyLevel,
  type LazyTreeState,
} from '../lib/lazyTreeState';

export interface UseLazyHierarchyOptions {
  /** Active connection profile; when null the tree stays idle/empty. */
  profile: ConnectionProfile | null | undefined;
  /** Ordered hierarchy levels (key + label). */
  levels: readonly LazyLevel[];
  /** When false the hook is inert (tree hidden / a filter is active). */
  enabled?: boolean;
  /** Page size for a tag container's signals. Default {@link DEFAULT_SEARCH_TAKE}. */
  pageSize?: number;
}

export interface UseLazyHierarchyResult {
  state: LazyTreeState;
  /** Expand/collapse a node, lazily fetching its children or signals on first open. */
  toggle: (id: string) => void;
  /** Fetch the next page of signals for a tag-container node. */
  loadMore: (id: string) => void;
  /** Reload the root level from scratch. */
  reloadRoot: () => void;
}

/**
 * Drives a lazily-loaded, server-backed asset hierarchy. The root level loads
 * whenever the hook becomes enabled for a profile; expanding a group fetches the
 * next level's values (`getHierarchyChildren`) and expanding a leaf-level (or
 * ragged dead-end) node fetches its signals (`searchTags`, paged). All state
 * transitions go through the pure `lazyTreeState` helpers; this hook only owns
 * the async fetches, request cancellation, and a `stateRef` so handlers read the
 * latest tree without stale closures.
 */
export function useLazyHierarchy(opts: UseLazyHierarchyOptions): UseLazyHierarchyResult {
  const { profile, levels, enabled = true, pageSize = DEFAULT_SEARCH_TAKE } = opts;

  const levelDefs = useMemo(
    () => levels.map((l) => ({ key: l.key, label: l.label })),
    [levels],
  );
  const levelsKey = useMemo(() => JSON.stringify(levelDefs), [levelDefs]);

  const [state, setState] = useState<LazyTreeState>(() => createLazyTree(levelDefs));
  const stateRef = useRef(state);
  stateRef.current = state;

  const profileRef = useRef(profile);
  profileRef.current = profile;
  const pageSizeRef = useRef(pageSize);
  pageSizeRef.current = pageSize;

  // One AbortController per in-flight request, keyed by node id ('' = root).
  const abortsRef = useRef<Map<string, AbortController>>(new Map());
  const abortAll = useCallback(() => {
    for (const c of abortsRef.current.values()) c.abort();
    abortsRef.current.clear();
  }, []);

  const beginRequest = useCallback((key: string): AbortController => {
    abortsRef.current.get(key)?.abort();
    const controller = new AbortController();
    abortsRef.current.set(key, controller);
    return controller;
  }, []);

  const profileId = profile?.id;

  // (Re)load the root level whenever enabled/profile/levels change; reset otherwise.
  useEffect(() => {
    abortAll();
    const fresh = createLazyTree(levelDefs);
    setState(fresh);
    stateRef.current = fresh;

    if (!enabled || !profileId || levelDefs.length === 0) return;
    const p = profileRef.current;
    if (!p) return;

    const controller = beginRequest('');
    setState((s) => setRootLoading(s));
    getHierarchyChildren(
      p,
      { scope: {}, childKey: levelDefs[0].key },
      profileToKqlOpts(p),
      { signal: controller.signal },
    )
      .then((values) => {
        if (controller.signal.aborted) return;
        setState((s) => setRootChildren(s, values));
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => setRootError(s, e instanceof Error ? e.message : String(e)));
      });

    return () => abortAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, profileId, levelsKey]);

  const fetchTags = useCallback(
    (id: string, append: boolean) => {
      const p = profileRef.current;
      const node = stateRef.current.nodes[id];
      if (!p || !node) return;
      const controller = beginRequest(id);
      setState((s) => setNodeLoading(s, id));
      const skip = append ? node.tags.length : 0;
      searchTags(
        p,
        { scope: node.scope, skip, take: pageSizeRef.current },
        profileToKqlOpts(p),
        { signal: controller.signal },
      )
        .then((res) => {
          if (controller.signal.aborted) return;
          setState((s) => setNodeTags(s, id, res.rows, res.hasMore, append));
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setState((s) => setNodeError(s, id, e instanceof Error ? e.message : String(e)));
        });
    },
    [beginRequest],
  );

  const fetchChildren = useCallback(
    (id: string) => {
      const p = profileRef.current;
      const node = stateRef.current.nodes[id];
      if (!p || !node || !node.childKey) return;
      const controller = beginRequest(id);
      setState((s) => setNodeLoading(s, id));
      getHierarchyChildren(
        p,
        { scope: node.scope, childKey: node.childKey },
        profileToKqlOpts(p),
        { signal: controller.signal },
      )
        .then((values) => {
          if (controller.signal.aborted) return;
          setState((s) => setNodeChildren(s, id, values));
          // Ragged dead-end: setNodeChildren converted it to a tag container that
          // still needs its signals fetched.
          const updated = stateRef.current.nodes[id];
          if (updated && updated.isTagContainer && !updated.loaded) fetchTags(id, false);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setState((s) => setNodeError(s, id, e instanceof Error ? e.message : String(e)));
        });
    },
    [beginRequest, fetchTags],
  );

  const toggle = useCallback(
    (id: string) => {
      const node = stateRef.current.nodes[id];
      if (!node) return;
      const willExpand = !node.expanded;
      setState((s) => toggleNode(s, id));
      if (willExpand && !node.loaded && !node.loading) {
        if (node.isTagContainer) fetchTags(id, false);
        else fetchChildren(id);
      }
    },
    [fetchChildren, fetchTags],
  );

  const loadMore = useCallback(
    (id: string) => {
      const node = stateRef.current.nodes[id];
      if (!node || !node.isTagContainer || node.loading || !node.hasMore) return;
      fetchTags(id, true);
    },
    [fetchTags],
  );

  const reloadRoot = useCallback(() => {
    const p = profileRef.current;
    if (!enabled || !p || levelDefs.length === 0) return;
    const controller = beginRequest('');
    setState((s) => setRootLoading(s));
    getHierarchyChildren(
      p,
      { scope: {}, childKey: levelDefs[0].key },
      profileToKqlOpts(p),
      { signal: controller.signal },
    )
      .then((values) => {
        if (controller.signal.aborted) return;
        setState((s) => setRootChildren(s, values));
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => setRootError(s, e instanceof Error ? e.message : String(e)));
      });
  }, [enabled, levelDefs, beginRequest]);

  return { state, toggle, loadMore, reloadRoot };
}
