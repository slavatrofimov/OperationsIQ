import { describe, it, expect } from 'vitest';
import {
  buildTagTree,
  decodePathSegment,
  encodePathSegment,
  joinScopePath,
  splitScopePath,
  type HierarchyLevel,
} from './tagTree';
import type { TagInfo } from './tags';

const tag = (overrides: Partial<TagInfo> = {}): TagInfo => ({
  tagId: 't1',
  tagName: 'Tag 1',
  metric: '',
  description: '',
  engUnits: '',
  ...overrides,
});

const levels: HierarchyLevel[] = [
  { key: 'level1', label: 'Plant', get: (t) => t.level1 },
  { key: 'level2', label: 'Factory', get: (t) => t.level2 },
];

describe('path segment encoding round-trip', () => {
  it('round-trips plain values unchanged', () => {
    expect(decodePathSegment(encodePathSegment('Contoso Plant 1'))).toBe('Contoso Plant 1');
  });

  it('round-trips a value containing a slash', () => {
    const raw = 'Assembly/Line A';
    const encoded = encodePathSegment(raw);
    expect(encoded).toBe('Assembly%2FLine A');
    expect(decodePathSegment(encoded)).toBe(raw);
  });

  it('round-trips a value containing a percent sign', () => {
    const raw = '50% Line';
    const encoded = encodePathSegment(raw);
    expect(encoded).toBe('50%25 Line');
    expect(decodePathSegment(encoded)).toBe(raw);
  });

  it('round-trips a value containing both % and /, unambiguously', () => {
    const raw = 'A/B%C';
    const encoded = encodePathSegment(raw);
    expect(decodePathSegment(encoded)).toBe(raw);
  });

  it('joinScopePath/splitScopePath round-trip multiple segments', () => {
    const segments = ['Contoso Plant 1', 'Assembly/Line A', '50%'];
    const joined = joinScopePath(segments);
    // The joined path should have exactly as many '/'-separated parts as segments,
    // even though one segment itself contains a raw '/'.
    expect(joined.split('/')).toHaveLength(segments.length);
    expect(splitScopePath(joined)).toEqual(segments);
  });
});

describe('buildTagTree node ids', () => {
  it('encodes the cumulative path so an embedded slash does not create an extra level', () => {
    const tags = [tag({ level1: 'Plant A', level2: 'Line/1' })];
    const tree = buildTagTree(tags, levels);
    expect(tree).toHaveLength(1);
    const plantNode = tree[0];
    expect(plantNode.label).toBe('Plant A');
    expect(plantNode.id).toBe('Plant A');
    expect(plantNode.children).toHaveLength(1);
    const lineNode = plantNode.children[0];
    expect(lineNode.label).toBe('Line/1');
    expect(lineNode.id).toBe('Plant A/Line%2F1');
    // Decoding the full path back gives the original raw segments.
    expect(splitScopePath(lineNode.id)).toEqual(['Plant A', 'Line/1']);
  });
});
