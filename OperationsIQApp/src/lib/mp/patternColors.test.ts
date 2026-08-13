import { describe, it, expect } from 'vitest';
import {
  PATTERN_COLORS,
  REGIME_BANDS,
  SERIES_PALETTE,
  patternColor,
  patternOverlayColor,
  regimeBand,
  seriesColor,
  withAlpha,
  spanMarkArea,
  boundaryMarkLine,
  standardDataZoom,
  type HighlightSpan,
} from './patternColors';

describe('patternColors palette', () => {
  it('maps each pattern kind to a color', () => {
    expect(patternColor('motif')).toBe(PATTERN_COLORS.motif);
    expect(patternColor('discord')).toBe(PATTERN_COLORS.discord);
    expect(patternColor('chain')).toBe(PATTERN_COLORS.chain);
    expect(patternColor('consensus')).toBe(PATTERN_COLORS.consensus);
    expect(patternColor('selection')).toBe(PATTERN_COLORS.selection);
    // regime is drawn from the categorical band set, not PATTERN_COLORS.
    expect(patternColor('regime')).toBe(REGIME_BANDS[0]);
  });

  it('cycles regime and series palettes and handles negatives', () => {
    expect(regimeBand(0)).toBe(REGIME_BANDS[0]);
    expect(regimeBand(REGIME_BANDS.length)).toBe(REGIME_BANDS[0]);
    expect(regimeBand(-1)).toBe(REGIME_BANDS[REGIME_BANDS.length - 1]);
    expect(seriesColor(SERIES_PALETTE.length + 1)).toBe(SERIES_PALETTE[1]);
  });

  it('assigns distinct, cycling per-pattern overlay colors', () => {
    expect(patternOverlayColor(0)).toBe(SERIES_PALETTE[0]);
    expect(patternOverlayColor(1)).toBe(SERIES_PALETTE[1]);
    expect(patternOverlayColor(0)).not.toBe(patternOverlayColor(1));
    // Wraps around the palette and handles negatives without throwing.
    expect(patternOverlayColor(SERIES_PALETTE.length)).toBe(SERIES_PALETTE[0]);
    expect(patternOverlayColor(-1)).toBe(SERIES_PALETTE[SERIES_PALETTE.length - 1]);
  });

  it('converts hex to rgba', () => {
    expect(withAlpha('#2c7bb6', 0.25)).toBe('rgba(44, 123, 182, 0.25)');
    expect(withAlpha('#ffffff', 2)).toBe('rgba(255, 255, 255, 1)');
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)');
  });
});

describe('shared highlight primitives', () => {
  it('returns undefined markArea for no spans', () => {
    expect(spanMarkArea([])).toBeUndefined();
  });

  it('builds consistent markArea data with kind color and selection emphasis', () => {
    const spans: HighlightSpan[] = [
      { from: 1, to: 3, kind: 'motif' },
      { from: 5, to: 7, kind: 'discord', selected: true, label: 'P-1' },
    ];
    const ma = spanMarkArea(spans);
    expect(ma).toBeDefined();
    const data = ma!.data as unknown as Array<Array<{ xAxis: number; itemStyle: { color: string; borderWidth: number } }>>;
    expect(data).toHaveLength(2);
    expect(data[0][0].xAxis).toBe(1);
    expect(data[0][1].xAxis).toBe(3);
    expect(data[0][0].itemStyle.color).toBe(PATTERN_COLORS.motif);
    expect(data[0][0].itemStyle.borderWidth).toBe(1);
    // Selected span uses the discord color and a thicker border.
    expect(data[1][0].itemStyle.color).toBe(PATTERN_COLORS.discord);
    expect(data[1][0].itemStyle.borderWidth).toBe(2);
  });

  it('builds a boundary markLine at each x', () => {
    expect(boundaryMarkLine([])).toBeUndefined();
    const ml = boundaryMarkLine([10, 20]);
    const data = ml!.data as unknown as Array<{ xAxis: number }>;
    expect(data.map((d) => d.xAxis)).toEqual([10, 20]);
  });

  it('includes inside zoom and an optional slider', () => {
    const withSlider = standardDataZoom() as Array<{ type: string }>;
    expect(withSlider).toHaveLength(2);
    const noSlider = standardDataZoom({ showSlider: false }) as Array<{ type: string }>;
    expect(noSlider).toHaveLength(1);
    expect(noSlider[0].type).toBe('inside');
  });
});
