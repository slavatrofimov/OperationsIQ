import { describe, it, expect } from 'vitest';
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
} from './lazyTreeState';
import type { TagInfo } from './tags';
import type { CatalogValue } from './catalog';

const levels: LazyLevel[] = [
  { key: 'level1', label: 'Site' },
  { key: 'level2', label: 'Area' },
];

const val = (value: string, count = 0): CatalogValue => ({ value, count });
const tag = (id: string): TagInfo =>
  ({ tagId: id, tagName: id, metric: 'm' } as unknown as TagInfo);

describe('createLazyTree', () => {
  it('starts empty with the given levels', () => {
    const s = createLazyTree(levels);
    expect(s.rootIds).toEqual([]);
    expect(s.rootLoaded).toBe(false);
    expect(s.levels.map((l) => l.key)).toEqual(['level1', 'level2']);
  });
});

describe('root loading', () => {
  it('marks and clears loading', () => {
    const s = setRootLoading(createLazyTree(levels));
    expect(s.rootLoading).toBe(true);
    const done = setRootChildren(s, [val('A'), val('B')]);
    expect(done.rootLoading).toBe(false);
    expect(done.rootLoaded).toBe(true);
  });

  it('builds top-level group nodes at depth 0 with childKey = next level', () => {
    const s = setRootChildren(setRootLoading(createLazyTree(levels)), [val('Site A', 5)]);
    expect(s.rootIds).toHaveLength(1);
    const node = s.nodes[s.rootIds[0]];
    expect(node.label).toBe('Site A');
    expect(node.depth).toBe(0);
    expect(node.count).toBe(5);
    expect(node.childKey).toBe('level2');
    expect(node.isTagContainer).toBe(false);
    expect(node.scope).toEqual({ level1: 'Site A' });
  });

  it('records a root error', () => {
    const s = setRootError(setRootLoading(createLazyTree(levels)), 'boom');
    expect(s.rootError).toBe('boom');
    expect(s.rootLoaded).toBe(false);
  });

  it('handles a hierarchy with no levels', () => {
    const s = setRootChildren(createLazyTree([]), []);
    expect(s.rootLoaded).toBe(true);
    expect(s.rootIds).toEqual([]);
  });
});

describe('expansion and children', () => {
  it('toggles a node expanded/collapsed', () => {
    let s = setRootChildren(createLazyTree(levels), [val('A')]);
    const id = s.rootIds[0];
    s = toggleNode(s, id);
    expect(s.nodes[id].expanded).toBe(true);
    s = toggleNode(s, id);
    expect(s.nodes[id].expanded).toBe(false);
  });

  it('attaches last-level children as tag containers', () => {
    let s = setRootChildren(createLazyTree(levels), [val('Site A')]);
    const id = s.rootIds[0];
    s = setNodeChildren(setNodeLoading(s, id), id, [val('Area 1', 3), val('Area 2', 4)]);
    const parent = s.nodes[id];
    expect(parent.loaded).toBe(true);
    expect(parent.childIds).toHaveLength(2);
    const child = s.nodes[parent.childIds[0]];
    expect(child.depth).toBe(1);
    expect(child.isTagContainer).toBe(true); // last level
    expect(child.childKey).toBeUndefined();
    expect(child.scope).toEqual({ level1: 'Site A', level2: 'Area 1' });
    expect(child.id).toBe(`${id}/Area 1`);
  });

  it('converts a ragged dead-end (no children) into a tag container, left unloaded', () => {
    let s = setRootChildren(createLazyTree(levels), [val('Site A')]);
    const id = s.rootIds[0];
    s = setNodeChildren(setNodeLoading(s, id), id, []);
    const node = s.nodes[id];
    expect(node.isTagContainer).toBe(true);
    expect(node.childKey).toBeUndefined();
    expect(node.loaded).toBe(false); // hook will fetch its tags next
    expect(node.loading).toBe(false);
  });

  it('percent-encodes ids so slashes in values do not corrupt the path', () => {
    let s = setRootChildren(createLazyTree(levels), [val('A/B')]);
    const id = s.rootIds[0];
    expect(id).toBe('A%2FB');
    s = setNodeChildren(s, id, [val('C')]);
    expect(s.nodes[id].childIds[0]).toBe('A%2FB/C');
  });
});

describe('tag containers', () => {
  it('sets tags (replace) with hasMore', () => {
    let s = setRootChildren(createLazyTree([{ key: 'level1', label: 'Site' }]), [val('A')]);
    const id = s.rootIds[0];
    expect(s.nodes[id].isTagContainer).toBe(true); // single-level → leaf
    s = setNodeTags(s, id, [tag('t1'), tag('t2')], true, false);
    expect(s.nodes[id].tags.map((t) => t.tagId)).toEqual(['t1', 't2']);
    expect(s.nodes[id].hasMore).toBe(true);
    expect(s.nodes[id].loaded).toBe(true);
  });

  it('appends tags and de-dupes by id', () => {
    let s = setRootChildren(createLazyTree([{ key: 'level1', label: 'Site' }]), [val('A')]);
    const id = s.rootIds[0];
    s = setNodeTags(s, id, [tag('t1'), tag('t2')], true, false);
    s = setNodeTags(s, id, [tag('t2'), tag('t3')], false, true);
    expect(s.nodes[id].tags.map((t) => t.tagId)).toEqual(['t1', 't2', 't3']);
    expect(s.nodes[id].hasMore).toBe(false);
  });

  it('records a node error', () => {
    let s = setRootChildren(createLazyTree(levels), [val('A')]);
    const id = s.rootIds[0];
    s = setNodeError(setNodeLoading(s, id), id, 'nope');
    expect(s.nodes[id].error).toBe('nope');
    expect(s.nodes[id].loading).toBe(false);
  });
});

describe('immutability', () => {
  it('does not mutate the previous state on patch', () => {
    const s0 = setRootChildren(createLazyTree(levels), [val('A')]);
    const id = s0.rootIds[0];
    const s1 = setNodeLoading(s0, id);
    expect(s0.nodes[id].loading).toBe(false);
    expect(s1.nodes[id].loading).toBe(true);
    expect(s1.nodes).not.toBe(s0.nodes);
  });

  it('is a no-op for an unknown node id', () => {
    const s0 = setRootChildren(createLazyTree(levels), [val('A')]);
    expect(toggleNode(s0, 'missing')).toBe(s0);
    expect(setNodeLoading(s0, 'missing')).toBe(s0);
  });
});
