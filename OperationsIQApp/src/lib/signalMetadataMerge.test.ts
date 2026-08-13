import { describe, it, expect } from 'vitest';
import { metadataOverlayWarning, applySignalMetadataToTags } from './signalMetadataMerge';
import type { TagInfo } from './tags';
import type { SignalMetadataView } from './signalMetadata';

describe('metadataOverlayWarning', () => {
  it('explains the degradation and includes the Error message', () => {
    const msg = metadataOverlayWarning(new Error('RayFin 503'));
    expect(msg).toContain('Governed signal metadata could not be loaded');
    expect(msg).toContain('raw catalog values');
    expect(msg).toContain('RayFin 503');
  });

  it('handles non-Error throwables', () => {
    expect(metadataOverlayWarning('boom')).toContain('(boom)');
  });
});

describe('applySignalMetadataToTags (overlay guardrails)', () => {
  const tag = { tagId: 'sig.1', usl: 10 } as unknown as TagInfo;

  it('returns tags unchanged when no governed metadata is available', () => {
    expect(applySignalMetadataToTags([tag], new Map())).toEqual([tag]);
  });

  it('overlays governed values over catalog values', () => {
    const meta = new Map<string, SignalMetadataView>([
      ['sig.1', { usl: 42 } as unknown as SignalMetadataView],
    ]);
    const [out] = applySignalMetadataToTags([tag], meta);
    expect(out.usl).toBe(42);
  });
});
