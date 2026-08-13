/**
 * Framework-free state model for a lazily-loaded, server-backed asset hierarchy.
 *
 * The in-memory picker builds the whole tree up-front from every loaded tag
 * (`buildTagTree`), which cannot scale. This model instead loads the tree one
 * level at a time: the root shows the distinct values of the first hierarchy
 * level, expanding a group fetches the distinct values of the next level within
 * that scope (`catalog.getHierarchyChildren`), and the deepest ("leaf-level")
 * nodes list the actual signals under their scope (`catalog.searchTags`, paged).
 *
 * The tree is stored normalized (a flat id → node map plus ordered child-id
 * lists) so updates are localized and cheap. All transitions here are pure — the
 * React hook performs the async fetches and threads the results through these
 * functions — which keeps the fiddly parts (node construction, scope
 * accumulation, ragged-hierarchy fallback to a tag container, replace-vs-append
 * tag paging) unit-testable without a DOM or the Eventhouse stack.
 *
 * Known limitation: a node lists EITHER child groups OR signals, never both, so
 * signals that terminate above the deepest populated level of a *ragged* subtree
 * are reached by switching to search rather than by browsing. Group nodes are
 * navigation-only (no select-all), since their descendant ids aren't all loaded.
 */

import type { TagInfo } from './tags';
import type { CatalogValue } from './catalog';
import { joinScopePath, encodePathSegment } from './tagTree';

/** A minimal level descriptor (key + label); the accessor isn't needed here. */
export interface LazyLevel {
  key: string;
  label: string;
}

export interface LazyTreeNode {
  /** Stable id: the percent-encoded '/'-joined scope path (unique per node). */
  id: string;
  /** Parent node id, or '' when the node is a top-level (root) group. */
  parentId: string;
  /** This node's display value (the level value). */
  label: string;
  /** Signal count under this node, when known (from getHierarchyChildren). */
  count?: number;
  /** 0-based hierarchy level index of this node's value. */
  depth: number;
  /** Accumulated equality scope (level key → value) to reach this node. */
  scope: Record<string, string>;
  /** Hierarchy key of this node's children; undefined when it lists signals. */
  childKey?: string;
  /** True when the node lists signals (leaf level or a ragged dead-end). */
  isTagContainer: boolean;
  /** Ordered child group ids (populated once children load). */
  childIds: string[];
  /** Signals directly under this node (tag containers only). */
  tags: TagInfo[];
  /** True when more signals matched beyond the fetched page (tag containers). */
  hasMore: boolean;
  /** UI expansion state. */
  expanded: boolean;
  /** True once this node's children/tags have been fetched. */
  loaded: boolean;
  /** True while a fetch for this node is in flight. */
  loading: boolean;
  /** Last error message for this node's fetch, if any. */
  error?: string;
}

export interface LazyTreeState {
  /** Ordered hierarchy levels (key + label). */
  levels: LazyLevel[];
  /** Flat id → node map. */
  nodes: Record<string, LazyTreeNode>;
  /** Ordered ids of the top-level group nodes. */
  rootIds: string[];
  /** True once the root level has been fetched. */
  rootLoaded: boolean;
  /** True while the root level is being fetched. */
  rootLoading: boolean;
  /** Last error message for the root fetch, if any. */
  rootError?: string;
}

/** A fresh, empty tree for the given hierarchy levels. */
export function createLazyTree(levels: readonly LazyLevel[]): LazyTreeState {
  return {
    levels: levels.map((l) => ({ key: l.key, label: l.label })),
    nodes: {},
    rootIds: [],
    rootLoaded: false,
    rootLoading: false,
    rootError: undefined,
  };
}

const isLastLevel = (levels: readonly LazyLevel[], depth: number): boolean =>
  depth >= levels.length - 1;

/** Build a child node at `depth` under `parent` for one distinct level value. */
function makeNode(
  levels: readonly LazyLevel[],
  parentId: string,
  parentScope: Record<string, string>,
  depth: number,
  value: string,
  count: number | undefined,
): LazyTreeNode {
  const levelKey = levels[depth].key;
  const scope = { ...parentScope, [levelKey]: value };
  const id = parentId ? `${parentId}/${encodePathSegment(value)}` : encodePathSegment(value);
  const last = isLastLevel(levels, depth);
  return {
    id,
    parentId,
    label: value,
    count,
    depth,
    scope,
    childKey: last ? undefined : levels[depth + 1].key,
    isTagContainer: last,
    childIds: [],
    tags: [],
    hasMore: false,
    expanded: false,
    loaded: false,
    loading: false,
    error: undefined,
  };
}

export function setRootLoading(state: LazyTreeState): LazyTreeState {
  return { ...state, rootLoading: true, rootError: undefined };
}

export function setRootError(state: LazyTreeState, error: string): LazyTreeState {
  return { ...state, rootLoading: false, rootLoaded: false, rootError: error };
}

/** Replace the root with top-level group nodes built from level-0 values. */
export function setRootChildren(state: LazyTreeState, values: readonly CatalogValue[]): LazyTreeState {
  if (state.levels.length === 0) {
    return { ...state, rootLoading: false, rootLoaded: true, rootIds: [] };
  }
  const nodes: Record<string, LazyTreeNode> = {};
  const rootIds: string[] = [];
  for (const v of values) {
    const node = makeNode(state.levels, '', {}, 0, v.value, v.count);
    nodes[node.id] = node;
    rootIds.push(node.id);
  }
  return { ...state, nodes, rootIds, rootLoading: false, rootLoaded: true, rootError: undefined };
}

const patchNode = (
  state: LazyTreeState,
  id: string,
  patch: Partial<LazyTreeNode>,
): LazyTreeState => {
  const node = state.nodes[id];
  if (!node) return state;
  return { ...state, nodes: { ...state.nodes, [id]: { ...node, ...patch } } };
};

/** Flip a node's expansion flag. */
export function toggleNode(state: LazyTreeState, id: string): LazyTreeState {
  const node = state.nodes[id];
  if (!node) return state;
  return patchNode(state, id, { expanded: !node.expanded });
}

export function setNodeLoading(state: LazyTreeState, id: string): LazyTreeState {
  return patchNode(state, id, { loading: true, error: undefined });
}

export function setNodeError(state: LazyTreeState, id: string, error: string): LazyTreeState {
  return patchNode(state, id, { loading: false, error });
}

/**
 * Attach child group nodes to a node from the next level's distinct values. When
 * the next level has no values under this scope (a ragged subtree), the node is
 * converted into a tag container so its signals can be fetched instead — it is
 * left `loaded: false` so the hook performs that follow-up fetch.
 */
export function setNodeChildren(
  state: LazyTreeState,
  id: string,
  values: readonly CatalogValue[],
): LazyTreeState {
  const parent = state.nodes[id];
  if (!parent) return state;

  if (values.length === 0 && !parent.isTagContainer) {
    // Ragged dead-end: no deeper groups — surface this node's signals instead.
    return patchNode(state, id, {
      isTagContainer: true,
      childKey: undefined,
      loading: false,
      loaded: false,
    });
  }

  const childDepth = parent.depth + 1;
  const nodes = { ...state.nodes };
  const childIds: string[] = [];
  for (const v of values) {
    const child = makeNode(state.levels, parent.id, parent.scope, childDepth, v.value, v.count);
    nodes[child.id] = child;
    childIds.push(child.id);
  }
  nodes[id] = { ...parent, childIds, loading: false, loaded: true, error: undefined };
  return { ...state, nodes };
}

/** Set (or append) a tag container's signals. */
export function setNodeTags(
  state: LazyTreeState,
  id: string,
  tags: readonly TagInfo[],
  hasMore: boolean,
  append: boolean,
): LazyTreeState {
  const node = state.nodes[id];
  if (!node) return state;
  const nextTags = append ? dedupeTags(node.tags, tags) : tags.slice();
  return patchNode(state, id, {
    tags: nextTags,
    hasMore,
    loading: false,
    loaded: true,
    error: undefined,
  });
}

/** Append `next` after `prev`, skipping ids already present. */
function dedupeTags(prev: readonly TagInfo[], next: readonly TagInfo[]): TagInfo[] {
  const seen = new Set(prev.map((t) => t.tagId));
  const out = prev.slice();
  for (const t of next) {
    if (t && t.tagId && !seen.has(t.tagId)) {
      seen.add(t.tagId);
      out.push(t);
    }
  }
  return out;
}

/** The '/'-joined scope path for a node id (round-trips via joinScopePath). */
export function nodePath(scope: Record<string, string>, levels: readonly LazyLevel[]): string {
  const segments: string[] = [];
  for (const l of levels) {
    const v = scope[l.key];
    if (v === undefined) break;
    segments.push(v);
  }
  return joinScopePath(segments);
}
