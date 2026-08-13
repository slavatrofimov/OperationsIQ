import { useMemo, useState } from 'react';
import * as echarts from 'echarts';
import {
  Body1,
  Caption1,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  Switch,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChartFrame } from './ChartFrame';
import { PALETTE } from '../lib/series';
import { histogram } from '../lib/stats';
import { tooltipValueFormatter } from '../lib/exploreSettings';
import { useTooltipDecimals } from '../context/TooltipSettingsContext';
import { computeCapability, normalCdf, type CapabilityResult } from '../lib/spc/capability';
import type { ChartData } from '../lib/export';

const SPEC_COLOR = '#5c2e91';
const TARGET_COLOR = '#008272';
const CURVE_COLOR = '#605e5c';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  cards: { display: 'flex', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    minWidth: '120px',
  },
  cardValue: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold },
  toggleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  warnList: { margin: 0, paddingLeft: tokens.spacingHorizontalL },
});

export interface CapabilityPanelProps {
  /** Individual observations to assess against the spec. */
  values: number[];
  /** Short-term (within-subgroup) σ from the control chart, for Cp/Cpk. */
  withinSigma?: number;
  lsl?: number;
  usl?: number;
  target?: number;
  /** Whether the control chart shows the process to be in statistical control. */
  inControl: boolean;
  /** Number of histogram bins. */
  bins?: number;
}

/** A single capability index card; renders an em dash when the index is absent. */
function IndexCard({ label, value, styles }: { label: string; value?: number; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.card}>
      <Caption1>{label}</Caption1>
      <span className={styles.cardValue}>
        {value != null && Number.isFinite(value) ? value.toFixed(2) : '\u2014'}
      </span>
    </div>
  );
}

function fmtPpm(v?: number): string {
  if (v == null || !Number.isFinite(v)) return '\u2014';
  if (v >= 1000) return Math.round(v).toLocaleString();
  return v.toFixed(v < 1 ? 3 : 1);
}

/**
 * Process-capability panel. Renders a histogram of the observations with the
 * specification limits and target overlaid (drawn distinctly from any control
 * limits — those live on the control chart), a fitted normal curve, the standard
 * capability indices, and an explicit reminder that being *in control* is not
 * the same as being *capable*. Capability is gated on statistical control:
 * indices are suppressed for an out-of-control process unless the user opts into
 * an explicit exploratory view.
 */
export function CapabilityPanel({
  values,
  withinSigma,
  lsl,
  usl,
  target,
  inControl,
  bins = 30,
}: CapabilityPanelProps) {
  const styles = useStyles();
  const tooltipDecimals = useTooltipDecimals();
  const fmtVal = tooltipValueFormatter(tooltipDecimals);
  const [exploratory, setExploratory] = useState(false);

  const result = useMemo<CapabilityResult | null>(
    () => computeCapability({ values, lsl, usl, target, withinSigma }, { inControl, exploratory }),
    [values, lsl, usl, target, withinSigma, inControl, exploratory],
  );

  const histOption = useMemo<echarts.EChartsCoreOption>(() => {
    if (!result) return {};
    const hist = histogram(values, bins);
    const barData = hist.map((b) => [(b.lo + b.hi) / 2, b.count] as [number, number]);
    const binWidth = hist.length > 1 ? hist[0].hi - hist[0].lo : 1;

    // Fitted normal curve (overall σ), scaled from density to expected counts.
    const curve: [number, number][] = [];
    if (result.overallSigma > 0 && hist.length > 0) {
      const lo = hist[0].lo;
      const hi = hist[hist.length - 1].hi;
      const steps = 80;
      const s = result.overallSigma;
      const m = result.mean;
      for (let i = 0; i <= steps; i++) {
        const x = lo + ((hi - lo) * i) / steps;
        const density = Math.exp(-((x - m) ** 2) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
        curve.push([x, density * result.n * binWidth]);
      }
    }

    const markLines: Record<string, unknown>[] = [];
    const specLine = (x: number, name: string, color: string) => ({
      xAxis: x,
      lineStyle: { color, type: 'dashed' as const, width: 1.5 },
      label: { formatter: name, color },
    });
    if (lsl != null) markLines.push(specLine(lsl, 'LSL', SPEC_COLOR));
    if (usl != null) markLines.push(specLine(usl, 'USL', SPEC_COLOR));
    if (target != null)
      markLines.push({
        xAxis: target,
        lineStyle: { color: TARGET_COLOR, type: 'solid' as const, width: 1.5 },
        label: { formatter: 'Target', color: TARGET_COLOR },
      });

    return {
      animation: false,
      grid: { left: 56, right: 24, top: 24, bottom: 44 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? fmtVal(v) : ''),
      },
      xAxis: { type: 'value', scale: true, name: 'Value', nameLocation: 'middle', nameGap: 26 },
      yAxis: { type: 'value', name: 'Count' },
      series: [
        {
          name: 'Count',
          type: 'bar',
          barCategoryGap: '0%',
          itemStyle: {
            color: 'rgba(0, 120, 212, 0.45)',
            borderColor: PALETTE[0],
            borderWidth: 0.5,
          },
          data: barData,
          markLine: markLines.length > 0 ? { silent: true, symbol: 'none', data: markLines } : undefined,
        },
        {
          name: 'Normal fit',
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { color: CURVE_COLOR, width: 1.5, type: 'dashed' },
          data: curve,
        },
      ],
    };
  }, [result, values, bins, lsl, usl, target, fmtVal]);

  if (!result) {
    return <Body1>Not enough data to assess capability.</Body1>;
  }

  const histData: ChartData = {
    columns: ['Bin center', 'Count'],
    rows: histogram(values, bins).map((b) => [(b.lo + b.hi) / 2, b.count]),
  };

  const hasSpec = lsl != null || usl != null;
  const gatedOff = !result.gate.allowed;

  return (
    <div className={styles.root}>
      <MessageBar intent="warning">
        <MessageBarBody>
          <b>In control is not the same as capable.</b> Control limits describe how the process
          actually behaves; specification limits (LSL/USL) describe what the product requires. A
          perfectly stable process can still produce out-of-spec output — capability compares the
          process spread to the spec, it does not check stability.
        </MessageBarBody>
      </MessageBar>

      {!inControl && (
        <div className={styles.toggleRow}>
          <MessageBar intent={exploratory ? 'warning' : 'error'} style={{ flex: 1, minWidth: 260 }}>
            <MessageBarBody>{result.gate.reason}</MessageBarBody>
          </MessageBar>
          <Switch
            label="Show exploratory capability"
            checked={exploratory && hasSpec}
            disabled={!hasSpec}
            onChange={(_, d) => setExploratory(!!d.checked)}
          />
          {!hasSpec && (
            <Caption1>Enter a spec limit (LSL/USL) on the control chart to enable capability.</Caption1>
          )}
        </div>
      )}

      {!hasSpec && (
        <MessageBar intent="info">
          <MessageBarBody>
            Enter a specification limit (LSL and/or USL) on the control chart to compute capability
            indices.
          </MessageBarBody>
        </MessageBar>
      )}

      {hasSpec && !gatedOff && (
        <>
          <div className={styles.section}>
            <Subtitle2>Capability indices</Subtitle2>
            <Caption1>
              {exploratory
                ? 'Exploratory: the process is not in control, so these indices may not predict future output.'
                : 'Cp/Cpk use the within-subgroup (short-term) spread; Pp/Ppk use the overall (long-term) spread.'}
            </Caption1>
            <div className={styles.cards}>
              <IndexCard label="Cp" value={result.indices.cp} styles={styles} />
              <IndexCard label="Cpk" value={result.indices.cpk} styles={styles} />
              <IndexCard label="Pp" value={result.indices.pp} styles={styles} />
              <IndexCard label="Ppk" value={result.indices.ppk} styles={styles} />
              {target != null && <IndexCard label="Cpm" value={result.indices.cpm} styles={styles} />}
            </div>
          </div>

          <div className={styles.section}>
            <Subtitle2>Expected nonconformance</Subtitle2>
            <Caption1>
              Parts-per-million outside the spec under a normal model (overall spread), plus the
              rate directly observed in the sample.
            </Caption1>
            <div className={styles.cards}>
              <div className={styles.card}>
                <Caption1>Expected PPM</Caption1>
                <span className={styles.cardValue}>{fmtPpm(result.expectedPpm.total)}</span>
              </div>
              <div className={styles.card}>
                <Caption1>Observed PPM</Caption1>
                <span className={styles.cardValue}>{fmtPpm(result.expectedPpm.observed)}</span>
              </div>
              {result.expectedPpm.below != null && (
                <div className={styles.card}>
                  <Caption1>Below LSL</Caption1>
                  <span className={styles.cardValue}>{fmtPpm(result.expectedPpm.below)}</span>
                </div>
              )}
              {result.expectedPpm.above != null && (
                <div className={styles.card}>
                  <Caption1>Above USL</Caption1>
                  <span className={styles.cardValue}>{fmtPpm(result.expectedPpm.above)}</span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div className={styles.section}>
        <Subtitle2>Distribution vs specification</Subtitle2>
        <Caption1>
          Histogram of the observations with the specification limits (purple) and target (teal)
          overlaid, and a fitted normal curve. Mean {fmtVal(result.mean)}; overall σ{' '}
          {fmtVal(result.overallSigma)}
          {result.withinSigma != null ? `; within σ ${fmtVal(result.withinSigma)}` : ''}.
        </Caption1>
        <ChartFrame option={histOption} height={280} data={histData} fileName="capability_histogram" />
      </div>

      {result.warnings.length > 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            <ul className={styles.warnList}>
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

/** Re-exported for callers that want the normal CDF used by the panel. */
export { normalCdf };
