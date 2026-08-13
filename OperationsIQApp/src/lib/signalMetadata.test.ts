import { describe, it, expect } from 'vitest';
import type { TagInfo } from './tags';
import { applySignalMetadataToTags } from './signalMetadataMerge';
import type { SignalMetadataView } from './signalMetadata';

function tag(p: Partial<TagInfo>): TagInfo {
  return { tagId: 't', tagName: '', metric: '', engUnits: '', ...p } as TagInfo;
}

function view(signalId: string, p: Partial<SignalMetadataView>): SignalMetadataView {
  return {
    id: `${signalId}-v1`,
    signalId,
    status: 'approved',
    version: 1,
    audit: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...p,
  } as SignalMetadataView;
}

describe('applySignalMetadataToTags', () => {
  it('returns the same array reference when the map is empty', () => {
    const tags = [tag({ tagId: 't1' })];
    expect(applySignalMetadataToTags(tags, new Map())).toBe(tags);
  });

  it('overlays governed values onto the matching tag', () => {
    const tags = [tag({ tagId: 't1' }), tag({ tagId: 't2' })];
    const map = new Map<string, SignalMetadataView>([
      ['t1', view('t1', { usl: 100, lsl: 10, ruleProfile: 'nelson' })],
    ]);
    const out = applySignalMetadataToTags(tags, map);
    expect(out[0]).toMatchObject({ tagId: 't1', usl: 100, lsl: 10, ruleProfile: 'nelson' });
    // Untouched tag is returned unchanged.
    expect(out[1]).toBe(tags[1]);
  });

  it('lets governed values win over pre-existing catalog values', () => {
    const tags = [tag({ tagId: 't1', usl: 50 })];
    const map = new Map<string, SignalMetadataView>([['t1', view('t1', { usl: 100 })]]);
    expect(applySignalMetadataToTags(tags, map)[0].usl).toBe(100);
  });

  it('keeps the catalog value when the governed field is undefined', () => {
    const tags = [tag({ tagId: 't1', usl: 50 })];
    const map = new Map<string, SignalMetadataView>([['t1', view('t1', { lsl: 5 })]]);
    const out = applySignalMetadataToTags(tags, map)[0];
    expect(out.usl).toBe(50);
    expect(out.lsl).toBe(5);
  });
});
