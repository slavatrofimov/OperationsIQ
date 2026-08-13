import { describe, it, expect, vi } from 'vitest';
import type * as echarts from 'echarts';
import { getChartPngDataUrl } from './chartSnapshot';

/**
 * Minimal fake ECharts instance that records the `series` option pushed through
 * setOption, so we can assert the `large` toggle-and-restore behaviour without a
 * real canvas.
 */
function makeFakeChart(series: Array<{ large?: boolean }>) {
  const setOptionCalls: Array<Array<{ large?: boolean }>> = [];
  const chart = {
    getOption: () => ({ series }),
    setOption: (opt: { series: Array<{ large?: boolean }> }) => {
      setOptionCalls.push(opt.series);
    },
    getDataURL: vi.fn(() => 'data:image/png;base64,STUB'),
  };
  return { chart: chart as unknown as echarts.ECharts, chart_: chart, setOptionCalls };
}

describe('getChartPngDataUrl', () => {
  it('returns the data URL and never toggles large for non-large charts', () => {
    const { chart, setOptionCalls } = makeFakeChart([{ large: false }, {}]);
    const url = getChartPngDataUrl(chart);
    expect(url).toBe('data:image/png;base64,STUB');
    expect(setOptionCalls).toHaveLength(0);
  });

  it('toggles large off before capture and restores it afterwards', () => {
    const { chart, chart_, setOptionCalls } = makeFakeChart([
      { large: true },
      { large: false },
      { large: true },
    ]);
    const url = getChartPngDataUrl(chart);
    expect(url).toBe('data:image/png;base64,STUB');
    // One call to disable, one to restore, per-series partials.
    expect(setOptionCalls).toEqual([
      [{ large: false }, {}, { large: false }],
      [{ large: true }, {}, { large: true }],
    ]);
    expect(chart_.getDataURL).toHaveBeenCalledWith({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#ffffff',
    });
  });

  it('passes through pixelRatio and backgroundColor overrides', () => {
    const { chart, chart_ } = makeFakeChart([{}]);
    getChartPngDataUrl(chart, { pixelRatio: 3, backgroundColor: '#000000' });
    expect(chart_.getDataURL).toHaveBeenCalledWith({
      type: 'png',
      pixelRatio: 3,
      backgroundColor: '#000000',
    });
  });
});
