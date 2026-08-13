import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Button,
  Field,
  Dropdown,
  Option,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import { TimeRangePicker, type TimeRange } from './TimeRangePicker';
import { SegmentSelectChart } from './SegmentSelectChart';
import type { Aggregation } from '../lib/kql';

export interface PreviewSignal {
  tagId: string;
  name?: string;
}

const useStyles = makeStyles({
  surface: { maxWidth: '920px', width: '90vw' },
  content: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  signalRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  signalField: { minWidth: '260px' },
});

export interface TimeRangeOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The committed range; used to seed the draft each time the overlay opens. */
  value: TimeRange;
  /** Called with the drafted range when the user confirms. */
  onConfirm: (range: TimeRange) => void;
  /** Candidate signals to preview. When >1, a "Preview signal" dropdown is shown. */
  signals?: PreviewSignal[];
  /** Broader window the preview chart spans. Defaults to the value padded by its span. */
  contextRange?: TimeRange;
  aggregation?: Aggregation;
  chartHeight?: number;
  title?: string;
}

/** Widen a range by its own span on each side (min 1 minute) so the user can extend it. */
function padRange(r: TimeRange): TimeRange {
  const span = Math.max(r.end.getTime() - r.start.getTime(), 60_000);
  return { start: new Date(r.start.getTime() - span), end: new Date(r.end.getTime() + span) };
}

/**
 * Modal overlay for picking a time range graphically without cluttering the page.
 * Hosts a {@link SegmentSelectChart} brush plus synced numeric inputs, working on a
 * local *draft* so Cancel discards and Confirm commits `{start, end}` via `onConfirm`.
 * When several candidate `signals` are supplied, a dropdown selects which one to preview.
 */
export function TimeRangeOverlay({
  open,
  onOpenChange,
  value,
  onConfirm,
  signals = [],
  contextRange,
  aggregation,
  chartHeight = 300,
  title = 'Select time range visually',
}: TimeRangeOverlayProps) {
  const styles = useStyles();
  const [draft, setDraft] = useState<TimeRange>(value);
  const [signalId, setSignalId] = useState<string | undefined>(signals[0]?.tagId);
  const [context, setContext] = useState<TimeRange>(() => contextRange ?? padRange(value));

  // Reseed the draft, previewed signal and pan window each time the overlay opens.
  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setSignalId((prev) => (prev && signals.some((s) => s.tagId === prev) ? prev : signals[0]?.tagId));
    setContext(contextRange ?? padRange(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When the drafted range extends beyond the current preview window (e.g. the
  // user typed/picked a date outside the chart's bounds), widen the context by
  // re-applying the proportional margins around the draft so SegmentSelectChart
  // requeries the wider window and the selection stays visible. padRange always
  // strictly contains the draft, so this converges in one step (no update loop),
  // and it only ever expands — a narrower later pick keeps the wider view.
  useEffect(() => {
    if (!open) return;
    const outOfBounds =
      draft.start.getTime() < context.start.getTime() ||
      draft.end.getTime() > context.end.getTime();
    if (outOfBounds) setContext(padRange(draft));
  }, [open, draft, context]);

  const activeSignal = signals.find((s) => s.tagId === signalId) ?? signals[0];
  const valid = draft.end.getTime() > draft.start.getTime();

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<Dismiss24Regular />}
                onClick={() => onOpenChange(false)}
              />
            }
          >
            {title}
          </DialogTitle>
          <DialogContent className={styles.content}>
            <div className={styles.signalRow}>
              <TimeRangePicker value={draft} onChange={setDraft} />
              {signals.length > 1 ? (
                <Field label="Preview signal" className={styles.signalField}>
                  <Dropdown
                    value={activeSignal?.name ?? activeSignal?.tagId ?? ''}
                    selectedOptions={signalId ? [signalId] : []}
                    onOptionSelect={(_, d) => setSignalId(d.optionValue)}
                  >
                    {signals.map((s) => (
                      <Option key={s.tagId} value={s.tagId} text={s.name ?? s.tagId}>
                        {s.name ?? s.tagId}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              ) : activeSignal ? (
                <Caption1>Previewing: {activeSignal.name ?? activeSignal.tagId}</Caption1>
              ) : null}
            </div>
            <SegmentSelectChart
              tagId={activeSignal?.tagId}
              tagName={activeSignal?.name}
              value={draft}
              onChange={setDraft}
              contextRange={context}
              aggregation={aggregation}
              height={chartHeight}
            />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!valid}
              onClick={() => {
                onConfirm(draft);
                onOpenChange(false);
              }}
            >
              Confirm
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
