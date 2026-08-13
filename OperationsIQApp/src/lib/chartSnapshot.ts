/**
 * Shared PNG snapshot logic for ECharts instances.
 *
 * Series rendered with `large: true` use ECharts' optimized progressive draw
 * path (e.g. the scatter matrix and control-chart violation points). That path
 * is not captured correctly by getDataURL: the snapshot comes back with
 * axes/grids but no points, and the live canvas is left garbled with
 * mis-painted points. This helper temporarily switches `large` off for the
 * snapshot so points render on the normal (synchronous) path, then restores the
 * original per-series flags.
 *
 * Both the EChart wrapper's export handle and the Operations Agent page-capture
 * path go through here so the fix cannot be bypassed by taking a snapshot
 * directly off the raw ECharts instance.
 */

import * as echarts from 'echarts';

/** Return a PNG data URL of `chart`, correcting for `large`-mode series. */
export function getChartPngDataUrl(
  chart: echarts.ECharts,
  opts?: { pixelRatio?: number; backgroundColor?: string },
): string {
  const opt = chart.getOption() as { series?: Array<{ large?: boolean }> };
  const seriesArr = Array.isArray(opt.series) ? opt.series : [];
  const largeFlags = seriesArr.map((s) => !!(s && s.large));
  const hadLarge = largeFlags.some(Boolean);
  if (hadLarge) {
    chart.setOption({ series: largeFlags.map((v) => (v ? { large: false } : {})) });
  }
  const url = chart.getDataURL({
    type: 'png',
    pixelRatio: opts?.pixelRatio ?? 2,
    backgroundColor: opts?.backgroundColor ?? '#ffffff',
  });
  if (hadLarge) {
    chart.setOption({ series: largeFlags.map((v) => (v ? { large: true } : {})) });
  }
  return url;
}
