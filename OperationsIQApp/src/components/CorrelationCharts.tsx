import { useMemo, useState } from 'react';
import * as echarts from 'echarts';
import {
  Caption1,
  Field,
  Input,
  Select,
  Subtitle2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ExploreSeries } from '../lib/series';
import { PALETTE } from '../lib/series';
import { scatterPairs, crossCorrelation, bestLag } from '../lib/stats';
import { ChartFrame } from './ChartFrame';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import type { ChartData } from '../lib/export';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  controls: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  num: { width: '120px' },
  pick: { minWidth: '200px' },
});

/** Max series to render in a scatter matrix (keeps the SPLOM legible/fast). */
const MAX_SPLOM = 6;

export interface CorrelationChartsProps {
  series: ExploreSeries[];
  nameById: Map<string, string>;
}

/**
 * Pairwise scatter-plot matrix (SPLOM) plus a cross-correlation-by-lag explorer,
 * both computed client-side from the index-aligned detail series.
 */
export function CorrelationCharts({ series, nameById }: CorrelationChartsProps) {
  const labeler = useTagLabeler();
  const names = series.map((s) => labeler(s.tagId, nameById.get(s.tagId)));

  if (series.length < 2) return null;

  return (
    <>
      <ScatterMatrix series={series} names={names} />
      <LagCorrelation series={series} names={names} />
    </>
  );
}

function ScatterMatrix({ series, names }: { series: ExploreSeries[]; names: string[] }) {
  const styles = useStyles();
  const shown = series.slice(0, MAX_SPLOM);
  const shownNames = names.slice(0, MAX_SPLOM);
  const n = shown.length;

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    const marginL = 7;
    const marginR = 3;
    const marginT = 4;
    const marginB = 7;
    const cellW = (100 - marginL - marginR) / n;
    const cellH = (100 - marginT - marginB) / n;
    const cellFill = 0.82;

    const grids: object[] = [];
    const xAxes: object[] = [];
    const yAxes: object[] = [];
    const seriesDefs: object[] = [];
    const titles: object[] = [];

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const idx = i * n + j;
        const left = marginL + j * cellW;
        const top = marginT + i * cellH;
        grids.push({
          left: `${left}%`,
          width: `${cellW * cellFill}%`,
          top: `${top}%`,
          height: `${cellH * cellFill}%`,
        });
        xAxes.push({
          gridIndex: idx,
          type: 'value',
          scale: true,
          axisLabel: { show: i === n - 1, fontSize: 9, hideOverlap: true },
          axisTick: { show: i === n - 1 },
          splitLine: { show: false },
          name: i === n - 1 ? shownNames[j] : undefined,
          nameLocation: 'middle',
          nameGap: 22,
          nameTextStyle: { fontSize: 10 },
        });
        yAxes.push({
          gridIndex: idx,
          type: 'value',
          scale: true,
          axisLabel: { show: j === 0, fontSize: 9, hideOverlap: true },
          axisTick: { show: j === 0 },
          splitLine: { show: false },
          name: j === 0 ? shownNames[i] : undefined,
          nameLocation: 'middle',
          nameGap: 40,
          nameTextStyle: { fontSize: 10 },
        });
        if (i === j) {
          titles.push({
            text: shownNames[i],
            left: `${left + (cellW * cellFill) / 2}%`,
            top: `${top + (cellH * cellFill) / 2}%`,
            textAlign: 'center',
            textVerticalAlign: 'middle',
            textStyle: { fontSize: 11, fontWeight: 'bold', color: tokens.colorNeutralForeground1 },
          });
        } else {
          seriesDefs.push({
            type: 'scatter',
            xAxisIndex: idx,
            yAxisIndex: idx,
            symbolSize: 3,
            itemStyle: { color: PALETTE[j % PALETTE.length], opacity: 0.4 },
            large: true,
            data: scatterPairs(shown[j].values, shown[i].values),
          });
        }
      }
    }

    return {
      animation: false,
      title: titles,
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      series: seriesDefs,
    };
  }, [shown, shownNames, n]);

  const scatterData = (): ChartData => {
    if (shown.length === 0) return { columns: [], rows: [] };
    const base = shown.reduce((a, b) => (b.x.length > a.x.length ? b : a), shown[0]);
    return {
      columns: ['Timestamp', ...shownNames],
      rows: base.x.map((t, i) => [
        new Date(t * 1000).toISOString(),
        ...shown.map((s) => s.values[i] ?? null),
      ]),
    };
  };

  return (
    <div className={styles.section}>
      <Subtitle2>Scatter matrix</Subtitle2>
      <Caption1>
        {series.length > MAX_SPLOM
          ? `Pairwise scatter of the first ${MAX_SPLOM} of ${series.length} series (bins where both have a value).`
          : 'Pairwise scatter over bins where both series have a value.'}
      </Caption1>
      <ChartFrame
        option={option}
        height={Math.max(360, n * 150)}
        data={scatterData}
        fileName="scatter_matrix"
        allowScaleToggle={false}
      />
    </div>
  );
}

function LagCorrelation({ series, names }: { series: ExploreSeries[]; names: string[] }) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const [aIdx, setAIdx] = useState(0);
  const [bIdx, setBIdx] = useState(1);
  const maxLen = Math.min(series[aIdx]?.values.length ?? 0, series[bIdx]?.values.length ?? 0);
  const [maxLag, setMaxLag] = useState(Math.min(50, Math.max(1, maxLen - 1)));

  const cc = useMemo(
    () => crossCorrelation(series[aIdx]?.values ?? [], series[bIdx]?.values ?? [], maxLag),
    [series, aIdx, bIdx, maxLag],
  );
  const peak = useMemo(() => bestLag(cc), [cc]);

  const option = useMemo<echarts.EChartsCoreOption>(() => {
    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(tooltipDecimals) : ''),
      },
      xAxis: {
        type: 'category',
        name: 'Lag (bins)',
        nameLocation: 'middle',
        nameGap: 28,
        data: cc.map((c) => c.lag),
      },
      yAxis: { type: 'value', min: -1, max: 1, name: 'r' },
      series: [
        {
          type: 'bar',
          data: cc.map((c) => ({
            value: Number.isFinite(c.r) ? c.r : 0,
            itemStyle: {
              color: peak && c.lag === peak.lag ? '#a4262c' : PALETTE[0],
            },
          })),
        },
      ],
    };
  }, [cc, peak, tooltipDecimals]);

  return (
    <div className={styles.section}>
      <Subtitle2>Lag correlation</Subtitle2>
      <div className={styles.controls}>
        <Field label="Series A" className={styles.pick}>
          <Select value={String(aIdx)} onChange={(_, d) => setAIdx(Number(d.value))}>
            {names.map((nm, i) => (
              <option key={series[i].tagId} value={i}>
                {nm}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Series B" className={styles.pick}>
          <Select value={String(bIdx)} onChange={(_, d) => setBIdx(Number(d.value))}>
            {names.map((nm, i) => (
              <option key={series[i].tagId} value={i}>
                {nm}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Max lag (bins)" className={styles.num}>
          <Input
            type="number"
            min={1}
            max={Math.max(1, maxLen - 1)}
            value={String(maxLag)}
            onChange={(_, d) => {
              const v = Number(d.value);
              if (Number.isFinite(v) && v >= 1) setMaxLag(Math.min(Math.floor(v), maxLen - 1));
            }}
          />
        </Field>
      </div>
      <Caption1>
        {peak
          ? `Peak |r| = ${Math.abs(peak.r).toFixed(3)} at lag ${peak.lag} bin(s)` +
            (peak.lag === 0
              ? ' (in phase).'
              : peak.lag > 0
                ? ` — "${names[aIdx]}" leads "${names[bIdx]}".`
                : ` — "${names[bIdx]}" leads "${names[aIdx]}".`)
          : 'Not enough overlapping data to compute a cross-correlation.'}
      </Caption1>
      <ChartFrame
        option={option}
        height={300}
        data={{ columns: ['Lag (bins)', 'r'], rows: cc.map((c) => [c.lag, Number.isFinite(c.r) ? c.r : null]) }}
        fileName="lag_correlation"
        allowScaleToggle={false}
      />
    </div>
  );
}
