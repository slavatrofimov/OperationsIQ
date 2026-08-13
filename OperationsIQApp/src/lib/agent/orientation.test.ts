import { describe, it, expect } from 'vitest';
import { buildOrientationBriefingText } from './orientation';
import type { ToolContext } from './types';
import type { TagInfo } from '../tags';

function tag(p: Partial<TagInfo>): TagInfo {
  return {
    tagId: 't?',
    tagName: '',
    metric: '',
    description: '',
    engUnits: '',
    ...p,
  } as TagInfo;
}

describe('buildOrientationBriefingText', () => {
  it('returns null with no catalog and no profile', () => {
    expect(buildOrientationBriefingText({ tags: [] })).toBeNull();
  });

  it('summarizes profile, terminology, and hierarchy from the catalog', () => {
    const ctx: ToolContext = {
      tags: [
        tag({ tagId: 't1', metric: 'Temperature', level1: 'Plant A' }),
        tag({ tagId: 't2', metric: 'Pressure', level1: 'Plant A' }),
        tag({ tagId: 't3', metric: 'Flow', level1: 'Plant B' }),
      ],
      profile: { name: 'North Plant', description: 'Boiler house', scopeDescription: 'db@uri' },
      terminology: {
        entityLabel: 'Asset',
        metricIdLabel: 'Signal',
        unitOfMeasureLabel: 'Units',
        samplingFrequencyLabel: 'Cadence',
        levelLabels: ['Plant', 'Line'],
      },
    };
    const text = buildOrientationBriefingText(ctx)!;
    expect(text).toContain('Environment orientation');
    expect(text).toContain('North Plant');
    expect(text).toContain('Boiler house');
    expect(text).toContain('an asset is called a "Asset"');
    expect(text).toContain('level1="Plant"');
    // 3 signals across 3 distinct metrics.
    expect(text).toContain('3 signal(s) across 3 distinct metric(s)');
    // Top Plant nodes, largest first.
    expect(text).toContain('Plant A (2)');
    expect(text).toContain('Plant B (1)');
    // Deep Discovery pointer.
    expect(text).toContain('Deep Discovery');
  });

  it('caps the enumerated level-1 nodes and notes the remainder', () => {
    // 25 distinct level1 nodes, one tag each → only 20 enumerated, 5 summarized.
    const tags = Array.from({ length: 25 }, (_, i) =>
      tag({ tagId: `t${i}`, metric: 'M', level1: `Node${String(i).padStart(2, '0')}` }),
    );
    const text = buildOrientationBriefingText({ tags })!;
    expect(text).toContain('and 5 more');
    expect(text).toContain('browse_asset_hierarchy');
  });

  it('works from profile alone when the catalog is empty', () => {
    const text = buildOrientationBriefingText({ tags: [], profile: { name: 'Solo' } });
    expect(text).toContain('Solo');
    expect(text).not.toContain('Catalog');
  });
});
