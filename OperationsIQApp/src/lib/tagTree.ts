/**
 * Build an N-level hierarchy tree from the flat tag catalog so the TagBrowser
 * can render an asset tree with search. The hierarchy is defined by an ordered
 * list of level accessors (up to ten levels when a Connection Profile is active,
 * defaulting to the four-level Plant > Factory > Line > Station Contoso schema)
 * and is generic — add another accessor here and the tree renders it with no
 * other changes.
 */

import type { TagInfo } from './tags';
import type { ProfileLabels } from './connectionProfile';

/** One level of the asset hierarchy: a label and how to read it off a tag. */
export interface HierarchyLevel {
  key: string;
  label: string;
  get: (t: TagInfo) => string | undefined;
}

/** Ordered hierarchy definition. Extend up to five levels by appending here. */
export const HIERARCHY_LEVELS: readonly HierarchyLevel[] = [
  { key: 'plant', label: 'Plant', get: (t) => t.plant },
  { key: 'factory', label: 'Factory', get: (t) => t.factory },
  { key: 'line', label: 'Line', get: (t) => t.line },
  { key: 'station', label: 'Station', get: (t) => t.station },
];

type LevelKey = keyof Pick<
  Required<TagInfo>,
  'level1' | 'level2' | 'level3' | 'level4' | 'level5' | 'level6' | 'level7' | 'level8' | 'level9' | 'level10'
>;
const LEVEL_KEYS: LevelKey[] = [
  'level1', 'level2', 'level3', 'level4',
  'level5', 'level6', 'level7', 'level8', 'level9', 'level10',
];

/**
 * Build a HierarchyLevel array driven by ProfileLabels. Levels with no label
 * defined fall back to "Level N". The returned array has at most 10 entries
 * (one per label present in `labels`). When `labels` is undefined, returns
 * HIERARCHY_LEVELS (the default 4-level Contoso schema).
 */
export function getHierarchyLevels(labels?: ProfileLabels): readonly HierarchyLevel[] {
  if (!labels) return HIERARCHY_LEVELS;
  const labelValues: (string | undefined)[] = [
    labels.level1Label, labels.level2Label, labels.level3Label, labels.level4Label,
    labels.level5Label, labels.level6Label, labels.level7Label, labels.level8Label,
    labels.level9Label, labels.level10Label,
  ];
  return LEVEL_KEYS.map((key, i) => ({
    key,
    label: labelValues[i] || `Level ${i + 1}`,
    get: (t: TagInfo) => t[key],
  }));
}

export interface TreeNode {
  /** Stable id built from the percent-encoded path (e.g. "Plant A/Factory 1"). */
  id: string;
  /** This node's label (the level value). */
  label: string;
  /** Level index in HIERARCHY_LEVELS; -1 for tag leaves. */
  level: number;
  /** Child group nodes, present on non-leaf nodes. */
  children: TreeNode[];
  /** Tags that are leaves directly under this node. */
  tags: TagInfo[];
  /** All tag ids anywhere beneath this node (for select-all / counts). */
  tagIds: string[];
}

/** Percent-escape a single hierarchy segment so it can be safely joined with '/'.
 *  Escape '%' first (so the escape char round-trips), then '/'. */
export function encodePathSegment(s: string): string {
  return s.replace(/%/g, '%25').replace(/\//g, '%2F');
}

export function decodePathSegment(s: string): string {
  return s.replace(/%2F/g, '/').replace(/%25/g, '%');
}

/** Join raw segments into a canonical scope path. */
export function joinScopePath(segments: string[]): string {
  return segments.map(encodePathSegment).join('/');
}

/** Split a canonical scope path back into raw (decoded) segments. */
export function splitScopePath(path: string): string[] {
  return path.split('/').map(decodePathSegment);
}

/** Build a tag's full '/'-joined hierarchy path, stopping at the first blank level. */
export function buildTagPath(tag: TagInfo, levels: readonly HierarchyLevel[] = HIERARCHY_LEVELS): string {
  const parts: string[] = [];
  for (const level of levels) {
    const value = level.get(tag)?.trim();
    if (!value) break;
    parts.push(value);
  }
  return parts.join('/');
}

/**
 * Group tags into a nested tree following HIERARCHY_LEVELS. Nesting stops at a
 * tag's last assigned level: the first level without a value ends descent and
 * the tag becomes a leaf on the deepest node it does have a value for. Tags with
 * no assigned levels become top-level leaves. This suppresses empty
 * "(unassigned)" placeholder groups so users reach the tag list sooner.
 */
export function buildTagTree(
  tags: TagInfo[],
  levels: readonly HierarchyLevel[] = HIERARCHY_LEVELS,
): TreeNode[] {
  const root: TreeNode = { id: '', label: '', level: -1, children: [], tags: [], tagIds: [] };

  for (const tag of tags) {
    let node = root;
    let path = '';
    for (let i = 0; i < levels.length; i++) {
      const value = levels[i].get(tag)?.trim();
      // Stop at the first unassigned level; the tag attaches to the current node.
      if (!value) break;
      const enc = encodePathSegment(value);
      path = path ? `${path}/${enc}` : enc;
      let child = node.children.find((c) => c.label === value);
      if (!child) {
        child = { id: path, label: value, level: i, children: [], tags: [], tagIds: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.tags.push(tag);
  }

  // Sort every level and accumulate tagIds bottom-up.
  const finalize = (node: TreeNode): string[] => {
    node.children.sort((a, b) => a.label.localeCompare(b.label));
    node.tags.sort((a, b) => a.tagName.localeCompare(b.tagName));
    const ids: string[] = node.tags.map((t) => t.tagId);
    for (const child of node.children) ids.push(...finalize(child));
    node.tagIds = ids;
    return ids;
  };
  finalize(root);
  return root.children;
}

/** Case-insensitive match of a tag against a free-text query (name/id/metric/desc). */
export function tagMatches(tag: TagInfo, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    tag.tagName.toLowerCase().includes(needle) ||
    tag.tagId.toLowerCase().includes(needle) ||
    (tag.metric ?? '').toLowerCase().includes(needle) ||
    (tag.description ?? '').toLowerCase().includes(needle)
  );
}
