import * as echarts from 'echarts';
import type { ForecastResult } from '../forecast';
import type { ToolChart } from './types';

function csvValue(value: string | number | null): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(result: ForecastResult): string {
  const rows = ['Timestamp,History,Forecast,Lower,Upper'];
  for (let i = 0; i < result.x.length; i++) {
    rows.push(
      [
        new Date(result.x[i]).toISOString(),
        result.actual[i],
        result.forecast[i],
        result.lower[i],
        result.upper[i],
      ]
        .map(csvValue)
        .join(','),
    );
  }
  return rows.join('\n');
}

function seriesData(x: number[], values: (number | null)[]) {
  return values.map((v, i) => (v == null ? [x[i], null] : [x[i], v]));
}

export function renderForecastChart(
  result: ForecastResult,
  opts: { title: string; threshold?: number },
): ToolChart {
  const csv = buildCsv(result);
  if (typeof document === 'undefined') {
    return { title: opts.title, pngDataUrl: '', csv };
  }

  const interval = result.upper.map((u, i) =>
    u == null || result.lower[i] == null ? null : u - (result.lower[i] as number),
  );
  const div = document.createElement('div');
  div.style.width = '960px';
  div.style.height = '460px';
  div.style.position = 'fixed';
  div.style.left = '-10000px';
  div.style.top = '0';
  document.body.appendChild(div);

  const chart = echarts.init(div);
  const thresholdLine =
    opts.threshold != null
      ? {
          symbol: 'none',
          label: { formatter: `Threshold ${opts.threshold}` },
          data: [{ yAxis: opts.threshold, name: 'Threshold' }],
        }
      : undefined;

  chart.setOption({
    animation: false,
    title: { text: opts.title, left: 'center' },
    tooltip: { trigger: 'axis' },
    legend: { top: 30, data: ['History', 'Forecast', 'Prediction interval'] },
    grid: { left: 55, right: 25, top: 70, bottom: 45 },
    useUTC: true,
    xAxis: { type: 'time' },
    yAxis: { type: 'value', scale: true },
    series: [
      {
        name: 'History',
        type: 'line',
        showSymbol: false,
        data: seriesData(result.x, result.actual),
      },
      {
        name: 'Forecast',
        type: 'line',
        showSymbol: false,
        lineStyle: { type: 'dashed' },
        data: seriesData(result.x, result.forecast),
        markLine: thresholdLine,
      },
      {
        name: 'Lower',
        type: 'line',
        stack: 'interval',
        showSymbol: false,
        lineStyle: { opacity: 0 },
        emphasis: { disabled: true },
        data: seriesData(result.x, result.lower),
      },
      {
        name: 'Prediction interval',
        type: 'line',
        stack: 'interval',
        showSymbol: false,
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0.18 },
        emphasis: { disabled: true },
        data: seriesData(result.x, interval),
      },
    ],
  });

  const pngDataUrl = chart.getDataURL({
    type: 'png',
    pixelRatio: 2,
    backgroundColor: '#ffffff',
  });
  chart.dispose();
  div.remove();
  return { title: opts.title, pngDataUrl, csv };
}
