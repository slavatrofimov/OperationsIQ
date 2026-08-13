import { useRef, useState, type ReactNode, type Ref } from 'react';
import type * as echarts from 'echarts';
import {
  Button,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  Subtitle2,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload24Regular,
  Table24Regular,
  DataArea24Regular,
  FullScreenMaximize24Regular,
  Dismiss24Regular,
} from '@fluentui/react-icons';
import { EChart, type EChartHandle } from './EChart';
import { DataTable } from './DataTable';
import { chartDataToCsv, downloadText, downloadDataUrl, fileStamp, type ChartData } from '../lib/export';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  title: { marginRight: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  dialogSurface: { maxWidth: '96vw', width: '96vw' },
  dialogBody: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  dialogHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  dialogSpacer: { flex: 1 },
  dialogContent: { minWidth: 0 },
});


export interface ChartFrameProps {
  /** ECharts option object (passed through to EChart). */
  option: echarts.EChartsCoreOption;
  /** Chart height in CSS pixels. */
  height?: number | string;
  group?: string;
  notMerge?: boolean;
  onEvents?: Record<string, (params: unknown) => void>;
  className?: string;
  /** Optional external ref, merged with the internal one used for PNG export. */
  chartRef?: Ref<EChartHandle | null>;
  /**
   * Underlying plotted data. When provided, enables the "View as table" toggle
   * and CSV export. May be a function for lazy/expensive extraction. When
   * omitted, only PNG export is offered.
   */
  data?: ChartData | (() => ChartData);
  /** Base name for downloaded files (a timestamp + extension is appended). */
  fileName: string;
  /** Optional heading rendered at the left of the toolbar. */
  title?: ReactNode;
  /** Extra toolbar controls, rendered left of the export buttons. */
  actions?: ReactNode;
  /** Rows per page in table view. */
  tablePageSize?: number;
  /**
   * Show the "Open in full screen" control (default true). The expanded view
   * renders the same chart in a large dialog.
   */
  allowExpand?: boolean;
  /**
   * Show the linear/logarithmic Y-axis scale toggle (default true). Only affects
   * value-type Y axes; charts with no value Y axis hide the control automatically.
   */
  allowScaleToggle?: boolean;
}

function assignRef<T>(ref: Ref<T | null> | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as { current: T | null }).current = value;
}

type AxisLike = Record<string, unknown> | null | undefined;

/** True when the option has at least one linear (value/default) Y axis eligible for a log scale. */
function hasLinearYAxis(option: echarts.EChartsCoreOption): boolean {
  const y = (option as Record<string, unknown>).yAxis as AxisLike | AxisLike[];
  const isLinear = (axis: AxisLike): boolean => {
    if (!axis || typeof axis !== 'object') return false;
    const t = (axis as Record<string, unknown>).type;
    return t === undefined || t === 'value';
  };
  return Array.isArray(y) ? y.some(isLinear) : isLinear(y);
}

/** Returns a shallow copy of the option with value-type Y axes switched to a log scale. */
function withLogYAxis(option: echarts.EChartsCoreOption): echarts.EChartsCoreOption {
  const opt = option as Record<string, unknown>;
  const convert = (axis: AxisLike): AxisLike => {
    if (!axis || typeof axis !== 'object') return axis;
    const a = axis as Record<string, unknown>;
    if (a.type !== undefined && a.type !== 'value') return axis;
    const next: Record<string, unknown> = { ...a, type: 'log' };
    // A log axis cannot include zero or negative bounds; drop invalid explicit ones.
    if (typeof next.min === 'number' && next.min <= 0) delete next.min;
    if (typeof next.max === 'number' && next.max <= 0) delete next.max;
    return next;
  };
  const y = opt.yAxis as AxisLike | AxisLike[];
  return { ...opt, yAxis: Array.isArray(y) ? y.map(convert) : convert(y) };
}

/**
 * Reusable frame around an ECharts chart that hosts a consistent toolbar:
 * "View as table" (toggle), "CSV", and "PNG". The table view and the CSV export
 * share the SAME ChartData, so both always match what the chart plots. PNG is
 * captured from the live ECharts instance.
 */
export function ChartFrame({
  option,
  height = 360,
  group,
  notMerge,
  onEvents,
  className,
  chartRef,
  data,
  fileName,
  title,
  actions,
  tablePageSize,
  allowExpand = true,
  allowScaleToggle = true,
}: ChartFrameProps) {
  const styles = useStyles();
  const innerRef = useRef<EChartHandle | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const hasData = data != null;
  const resolveData = (): ChartData => (typeof data === 'function' ? data() : (data as ChartData));

  const canToggleScale = allowScaleToggle && hasLinearYAxis(option);
  const displayOption = logScale && canToggleScale ? withLogYAxis(option) : option;

  const exportPng = () => {
    const url = innerRef.current?.getDataURL();
    if (url) downloadDataUrl(`${fileName}_${fileStamp()}.png`, url);
  };

  const exportCsv = () => {
    if (!hasData) return;
    const csv = chartDataToCsv(resolveData());
    if (csv) downloadText(`${fileName}_${fileStamp()}.csv`, csv);
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        {title != null && <Subtitle2 className={styles.title}>{title}</Subtitle2>}
        <div className={styles.spacer} />
        {actions}
        {!asTable && canToggleScale && (
          <Tooltip
            content={logScale ? 'Switch to linear scale' : 'Switch to logarithmic scale'}
            relationship="label"
          >
            <ToggleButton
              appearance="subtle"
              size="small"
              checked={logScale}
              onClick={() => setLogScale((v) => !v)}
            >
              {logScale ? 'Log' : 'Linear'}
            </ToggleButton>
          </Tooltip>
        )}
        {hasData && (
          <Tooltip content={asTable ? 'Show chart' : 'View data as table'} relationship="label">
            <ToggleButton
              appearance="subtle"
              size="small"
              checked={asTable}
              icon={asTable ? <DataArea24Regular /> : <Table24Regular />}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? 'Chart' : 'Table'}
            </ToggleButton>
          </Tooltip>
        )}
        {hasData && (
          <Button appearance="subtle" size="small" icon={<ArrowDownload24Regular />} onClick={exportCsv}>
            CSV
          </Button>
        )}
        {!asTable && (
          <Button appearance="subtle" size="small" icon={<ArrowDownload24Regular />} onClick={exportPng}>
            PNG
          </Button>
        )}
        {!asTable && allowExpand && (
          <Tooltip content="Open in full screen" relationship="label">
            <Button
              appearance="subtle"
              size="small"
              icon={<FullScreenMaximize24Regular />}
              aria-label="Open chart in full screen"
              onClick={() => setExpanded(true)}
            />
          </Tooltip>
        )}
      </div>
      {asTable && hasData ? (
        <DataTable data={resolveData()} pageSize={tablePageSize} />
      ) : (
        <EChart
          ref={(h) => {
            innerRef.current = h;
            assignRef(chartRef, h);
          }}
          option={displayOption}
          height={height}
          group={group}
          notMerge={notMerge}
          onEvents={onEvents}
          className={className}
        />
      )}
      {allowExpand && (
        <Dialog open={expanded} onOpenChange={(_, d) => setExpanded(d.open)}>
          <DialogSurface className={styles.dialogSurface}>
            <DialogBody className={styles.dialogBody}>
              <DialogTitle action={null}>
                <div className={styles.dialogHeader}>
                  {title != null ? <span>{title}</span> : <span>Chart</span>}
                  <div className={styles.dialogSpacer} />
                  {canToggleScale && (
                    <ToggleButton
                      appearance="subtle"
                      size="small"
                      checked={logScale}
                      onClick={() => setLogScale((v) => !v)}
                    >
                      {logScale ? 'Log' : 'Linear'}
                    </ToggleButton>
                  )}
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Dismiss24Regular />}
                    aria-label="Close full screen"
                    onClick={() => setExpanded(false)}
                  />
                </div>
              </DialogTitle>
              <DialogContent className={styles.dialogContent}>
                {expanded && (
                  <EChart option={displayOption} height="78vh" notMerge={notMerge} onEvents={onEvents} />
                )}
              </DialogContent>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}
