import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as echarts from 'echarts';
import { getChartPngDataUrl } from '../lib/chartSnapshot';

export interface EChartProps {
  /** ECharts option object. Replaced (not merged) on change unless `notMerge` is false. */
  option: echarts.EChartsCoreOption;
  /** Chart height in CSS pixels. */
  height?: number | string;
  /** Optional group id; charts sharing a group are connected via echarts.connect. */
  group?: string;
  /** Replace the whole option (default true) vs. merge. */
  notMerge?: boolean;
  /** Event name -> handler, wired via chart.on(). */
  onEvents?: Record<string, (params: unknown) => void>;
  className?: string;
}

/** Imperative handle exposed via ref for snapshot export. */
export interface EChartHandle {
  /** Return a PNG data URL of the current chart (undefined before mount). */
  getDataURL(opts?: { pixelRatio?: number; backgroundColor?: string }): string | undefined;
  /** The underlying ECharts instance, if mounted. */
  getInstance(): echarts.ECharts | null;
}

/**
 * Thin, resize-aware React wrapper around Apache ECharts. Creates one chart
 * instance per mount, updates its option when `option` changes, keeps it sized
 * to its container via ResizeObserver, and disposes on unmount. Charts given the
 * same `group` are registered for cursor/dataZoom syncing (call echarts.connect
 * once per group from the parent).
 */
export const EChart = forwardRef<EChartHandle, EChartProps>(function EChart(
  { option, height = 360, group, notMerge = true, onEvents, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const handlersRef = useRef<Record<string, (params: unknown) => void> | undefined>(onEvents);
  handlersRef.current = onEvents;

  useImperativeHandle(
    ref,
    (): EChartHandle => ({
      getDataURL: (opts) => {
        const chart = chartRef.current;
        if (!chart) return undefined;
        return getChartPngDataUrl(chart, opts);
      },
      getInstance: () => chartRef.current,
    }),
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = echarts.init(el);
    chartRef.current = chart;

    // Resize is throttled through requestAnimationFrame and only applied when the
    // observed box actually changes size. This prevents a ResizeObserver feedback
    // loop (resize -> layout -> observer fires -> resize ...) that manifests as
    // rapid layout jitter on the page.
    let raf = 0;
    let lastW = el.clientWidth;
    let lastH = el.clientHeight;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      const w = Math.round(box.width);
      const h = Math.round(box.height);
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        chart.resize();
      });
    });
    ro.observe(el);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.group = group ?? '';
  }, [group]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Render time axes in UTC. Query timestamps are pre-shifted into the preferred
    // analysis timezone by the KQL layer (see lib/queryTimezone.ts), so the client
    // must display them verbatim as UTC — otherwise the browser would re-apply its
    // own offset and double-shift. Harmless for non-time charts.
    chart.setOption({ useUTC: true, ...(option as object) }, notMerge);
  }, [option, notMerge]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvents) return;
    const names = Object.keys(onEvents);
    const bound: Record<string, (params: unknown) => void> = {};
    for (const name of names) {
      const handler = (params: unknown) => handlersRef.current?.[name]?.(params);
      bound[name] = handler;
      chart.on(name, handler);
    }
    return () => {
      for (const name of names) chart.off(name, bound[name]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEvents ? Object.keys(onEvents).sort().join(',') : '']);

  return <div ref={containerRef} className={className} style={{ width: '100%', height }} />;
});
