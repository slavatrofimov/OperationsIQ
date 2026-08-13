import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Button,
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { ScopeSelect } from './ScopeSelect';
import {
  createAnnotation,
  updateAnnotation,
  type AnnotationScope,
} from '../lib/annotations';
import { ANNOTATION_TYPES, DEFAULT_ANNOTATION_TYPE } from '../lib/annotationTypes';
import { DateTimeField } from './DateTimeField';
import { useTimezoneOffset } from '../context/TimezoneContext';
import { toPreferredWallClock, fromPreferredWallClock } from '../lib/timezone';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end' },
  timeField: { flex: 1 },
  clearBtn: { flexShrink: 0 },
});

/** Seed values for the dialog, from a chart brush and/or an existing annotation. */
export interface AnnotationDialogInitial {
  /** Annotation id — present in edit mode. */
  id?: string;
  start: Date;
  end?: Date | null;
  scope?: AnnotationScope | null;
  annotationType?: string;
  title?: string;
  detail?: string;
}

export interface AnnotationDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Tag catalog for the scope selector. */
  tags: TagInfo[];
  initial: AnnotationDialogInitial;
  onClose: () => void;
  /** Called after a successful save so the caller can reload annotations. */
  onSaved: () => void;
}

/**
 * Create / edit overlay for a time-series annotation. Start and End are editable
 * (End can be cleared to mark a point event), Type is a configured drop-down,
 * and Scope targets any tag or hierarchy node via {@link ScopeSelect}. Author and
 * timestamps are captured behind the scenes by the annotations lib.
 */
export function AnnotationDialog({
  open,
  mode,
  tags,
  initial,
  onClose,
  onSaved,
}: AnnotationDialogProps) {
  const styles = useStyles();
  const tzOffset = useTimezoneOffset();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [annotationType, setAnnotationType] = useState(DEFAULT_ANNOTATION_TYPE);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [scope, setScope] = useState<AnnotationScope | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStart(toPreferredWallClock(initial.start, tzOffset));
    setEnd(initial.end ? toPreferredWallClock(initial.end, tzOffset) : '');
    setAnnotationType(initial.annotationType ?? DEFAULT_ANNOTATION_TYPE);
    setTitle(initial.title ?? '');
    setDetail(initial.detail ?? '');
    setScope(initial.scope ?? null);
    setError(null);
    // Only reset when the dialog opens, the seed identity changes, or the active
    // timezone offset changes (so the wall-clock fields re-render in the new zone).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial.id, initial.start.getTime(), tzOffset]);

  const handleSave = async () => {
    const startDate = fromPreferredWallClock(start, tzOffset);
    const endDate = fromPreferredWallClock(end, tzOffset);
    if (!startDate) {
      setError('A valid start time is required.');
      return;
    }
    if (!title.trim()) {
      setError('A title is required.');
      return;
    }
    if (!scope) {
      setError('A scope is required.');
      return;
    }
    if (endDate && endDate.getTime() < startDate.getTime()) {
      setError('End time must be on or after the start time.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (mode === 'edit' && initial.id) {
        await updateAnnotation(initial.id, {
          annotationType,
          title: title.trim(),
          detail: detail.trim() || undefined,
          timestamp: startDate,
          endTimestamp: endDate ?? null,
          scope,
        });
      } else {
        await createAnnotation({
          annotationType,
          title: title.trim(),
          detail: detail.trim() || undefined,
          timestamp: startDate,
          endTimestamp: endDate ?? undefined,
          scope,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save annotation.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle
            action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} />}
          >
            {mode === 'edit' ? 'Edit annotation' : 'Add annotation'}
          </DialogTitle>
          <DialogContent className={styles.content}>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.row}>
              <Field label="Start" required className={styles.timeField}>
                <DateTimeField
                  value={start}
                  onChange={setStart}
                />
              </Field>
            </div>

            <div className={styles.row}>
              <Field
                label="End (leave blank for a point event)"
                className={styles.timeField}
              >
                <DateTimeField value={end} onChange={setEnd} />
              </Field>
              <Button
                className={styles.clearBtn}
                appearance="secondary"
                disabled={!end}
                onClick={() => setEnd('')}
              >
                Clear end
              </Button>
            </div>

            <Field label="Type" required>
              <Dropdown
                selectedOptions={[annotationType]}
                value={annotationType}
                onOptionSelect={(_, d) => setAnnotationType(d.optionValue ?? DEFAULT_ANNOTATION_TYPE)}
              >
                {ANNOTATION_TYPES.map((t) => (
                  <Option key={t.value} value={t.value} text={t.label}>
                    {t.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>

            <Field label="Title" required>
              <Input
                value={title}
                onChange={(_, d) => setTitle(d.value)}
                placeholder="Short headline for this annotation"
              />
            </Field>

            <Field label="Detail">
              <Textarea
                value={detail}
                onChange={(_, d) => setDetail(d.value)}
                placeholder="Optional longer description…"
                rows={3}
              />
            </Field>

            <ScopeSelect label="Scope" tags={tags} value={scope} onChange={setScope} />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={handleSave}
              disabled={saving || !title.trim() || !scope}
            >
              {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add annotation'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
