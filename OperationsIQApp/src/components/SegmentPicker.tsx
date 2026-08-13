import { useMemo, useState, type ReactNode } from 'react';
import { Button, Tooltip, makeStyles, tokens, type InfoLabelProps } from '@fluentui/react-components';
import { DataArea20Regular } from '@fluentui/react-icons';
import { TimeRangePicker, type TimeRange } from './TimeRangePicker';
import { TimeRangeOverlay, type PreviewSignal } from './TimeRangeOverlay';
import type { Aggregation } from '../lib/kql';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  header: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalL, flexWrap: 'wrap' },
});

export interface SegmentPickerProps {
  /** The selected segment (start/end) — the source of truth. */
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  /** Signal previewed in the overlay. Convenience for the single-signal case. */
  tagId?: string;
  tagName?: string;
  /**
   * Candidate signals to preview graphically. When more than one is supplied the
   * overlay shows a "Preview signal" dropdown. Takes precedence over `tagId`.
   */
  signals?: PreviewSignal[];
  /** Broader window the preview chart spans. Defaults to the current value (padded). */
  contextRange?: TimeRange;
  aggregation?: Aggregation;
  disabled?: boolean;
  /** Explanatory popover shown next to the numeric "Start" field. */
  info?: InfoLabelProps['info'];
  chartHeight?: number;
  /** Extra control rendered at the end of the Start / End / Select visually row. */
  trailing?: ReactNode;
}

/**
 * Numeric start/end inputs (the primary, always-available control) plus a
 * "Select visually" button that opens a {@link TimeRangeOverlay}. The overlay
 * hosts a graphical brush over the signal and commits the picked `{start, end}`
 * back through `onChange`. The numeric inputs remain the source of truth; the
 * overlay is an additive assist and is disabled when no signal is available.
 */
export function SegmentPicker({
  value,
  onChange,
  tagId,
  tagName,
  signals,
  contextRange,
  aggregation,
  disabled,
  info,
  chartHeight,
  trailing,
}: SegmentPickerProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);

  // Normalize single-signal callers into the `signals` list.
  const previewSignals = useMemo<PreviewSignal[]>(() => {
    if (signals && signals.length > 0) return signals;
    return tagId ? [{ tagId, name: tagName }] : [];
  }, [signals, tagId, tagName]);

  const canSelectVisually = !disabled && previewSignals.length > 0;

  const button = (
    <Button icon={<DataArea20Regular />} disabled={!canSelectVisually} onClick={() => setOpen(true)}>
      Select visually
    </Button>
  );

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <TimeRangePicker value={value} onChange={onChange} disabled={disabled} info={info} />
        {canSelectVisually ? (
          button
        ) : (
          <Tooltip content="Select a signal to enable visual selection." relationship="label">
            {button}
          </Tooltip>
        )}
        {trailing}
      </div>
      <TimeRangeOverlay
        open={open}
        onOpenChange={setOpen}
        value={value}
        onConfirm={onChange}
        signals={previewSignals}
        contextRange={contextRange}
        aggregation={aggregation}
        chartHeight={chartHeight}
      />
    </div>
  );
}
