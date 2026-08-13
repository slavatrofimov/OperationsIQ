import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { Label, LabelCategory } from '../../lib/mp/types';
import type { LabelUpdate } from '../../lib/mp/analysisClient';
import { LabelFields } from './LabelFields';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
  spacer: { flex: 1 },
});

/**
 * Edit an existing label — opened by clicking a label chip. Edits the label's
 * Name / Category / Confidence (its span, signal, and kind are immutable identity), and
 * offers a Delete for removing a label that no longer applies.
 */
export function LabelEditDialog({
  label,
  categories,
  onUpdate,
  onDelete,
  onClose,
}: {
  /** The label being edited, or null when the dialog is closed. */
  label: Label | null;
  categories: LabelCategory[];
  onUpdate: (id: string, patch: LabelUpdate) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [confidence, setConfidence] = useState(0.8);

  // Re-seed the form whenever a different label is opened for editing.
  useEffect(() => {
    if (label) {
      setText(label.text ?? '');
      setCategoryId(label.category ?? '');
      setConfidence(label.confidence ?? 0.8);
    }
  }, [label]);

  const open = label !== null;
  const category = categories.find((c) => c.id === categoryId);

  const save = () => {
    if (!label) return;
    onUpdate(label.id, {
      text: text.trim(),
      category: categoryId || undefined,
      color: category?.color,
      confidence,
    });
    onClose();
  };

  const remove = () => {
    if (!label) return;
    onDelete(label.id);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => (!d.open ? onClose() : undefined)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Edit label</DialogTitle>
          <DialogContent className={styles.form}>
            {label && (
              <Text size={200} className={styles.hint}>
                {label.kind === 'MOTIF' ? 'Pattern' : 'Anomaly'} at sample {label.startIndex} ·{' '}
                {label.length} samples
              </Text>
            )}
            <LabelFields
              text={text}
              onText={setText}
              categoryId={categoryId}
              onCategoryId={setCategoryId}
              confidence={confidence}
              onConfidence={setConfidence}
              categories={categories}
              kind={label?.kind ?? 'MOTIF'}
            />
          </DialogContent>
          <DialogActions>
            <Button
              appearance="subtle"
              icon={<DeleteRegular />}
              onClick={remove}
              aria-label="Delete label"
            >
              Delete
            </Button>
            <span className={styles.spacer} />
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={save} disabled={!text.trim()}>
              Update
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
