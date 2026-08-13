import { describe, expect, it } from 'vitest';
import {
  catalogModeForCount,
  LARGE_CATALOG_THRESHOLD,
  type CatalogMode,
} from './catalogMode';

describe('catalogModeForCount', () => {
  it('defaults to small when the count is unknown', () => {
    expect(catalogModeForCount(null)).toBe('small');
    expect(catalogModeForCount(undefined)).toBe('small');
  });

  it('treats non-finite counts as small (no false upgrade)', () => {
    expect(catalogModeForCount(Number.NaN)).toBe('small');
    expect(catalogModeForCount(Number.POSITIVE_INFINITY)).toBe('small');
  });

  it('stays small at and below the threshold', () => {
    expect(catalogModeForCount(0)).toBe('small');
    expect(catalogModeForCount(1)).toBe('small');
    expect(catalogModeForCount(LARGE_CATALOG_THRESHOLD - 1)).toBe('small');
    expect(catalogModeForCount(LARGE_CATALOG_THRESHOLD)).toBe('small');
  });

  it('switches to large strictly above the threshold', () => {
    expect(catalogModeForCount(LARGE_CATALOG_THRESHOLD + 1)).toBe('large');
    expect(catalogModeForCount(500_000)).toBe('large');
  });

  it('honors a custom threshold', () => {
    expect(catalogModeForCount(100, 50)).toBe('large');
    expect(catalogModeForCount(50, 50)).toBe('small');
    expect(catalogModeForCount(49, 50)).toBe('small');
  });

  it('returns a value assignable to CatalogMode', () => {
    const mode: CatalogMode = catalogModeForCount(10);
    expect(mode).toBe('small');
  });
});
