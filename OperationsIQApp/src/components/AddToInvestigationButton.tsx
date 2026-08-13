import { useCallback, useEffect, useState } from 'react';
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
  Spinner,
  Text,
  Tooltip,
  Toaster,
  useToastController,
  useId,
  Toast,
  ToastTitle,
  ToastBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, BookmarkAdd24Regular } from '@fluentui/react-icons';
import type { PageKey } from '../lib/pages';
import {
  createInvestigation,
  listInvestigations,
  type Investigation,
} from '../lib/evidence';
import { capturePageCharts } from '../lib/pageCapture';
import { captureCurrentPageEvidence } from '../lib/evidenceCapture';
import { useCaptureContextReader } from '../context/CaptureContext';
import { useActiveInvestigation } from '../context/ActiveInvestigationContext';

const NEW_INVESTIGATION = '__new__';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface AddToInvestigationButtonProps {
  /** The current page key (used to stamp the evidence). */
  pageKey: PageKey;
  /** Human-friendly page name. */
  pageName: string;
  /** Returns the DOM element whose content should be captured. */
  getCaptureRoot: () => HTMLElement | null;
}

/**
 * Header button (shown on every page) that captures the current page's analysis
 * — Markdown of the main content, every ECharts graph as PNG + CSV, and a
 * state-restoring deep link — into an Investigation as a piece of Evidence.
 */
export function AddToInvestigationButton({
  pageKey,
  pageName,
  getCaptureRoot,
}: AddToInvestigationButtonProps) {
  const styles = useStyles();
  const toasterId = useId('evidence-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const readCaptureContext = useCaptureContextReader();
  const { active: activeInvestigation, setActive: setActiveInvestigation } =
    useActiveInvestigation();

  const [open, setOpen] = useState(false);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [selectedId, setSelectedId] = useState<string>(NEW_INVESTIGATION);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [annotation, setAnnotation] = useState('');
  const [chartCount, setChartCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = useCallback(() => {
    setError(null);
    setAnnotation('');
    setNewName('');
    setNewDescription('');
    const root = getCaptureRoot();
    setChartCount(root ? capturePageCharts(root).length : 0);
    setOpen(true);
    listInvestigations()
      .then((list) => {
        setInvestigations(list);
        // Prefer the active investigation when it still exists; otherwise fall
        // back to the most-recent one, or "new" when there are none.
        const activeExists =
          activeInvestigation && list.some((i) => i.id === activeInvestigation.id);
        setSelectedId(
          activeExists
            ? activeInvestigation!.id
            : list.length > 0
              ? list[0].id
              : NEW_INVESTIGATION,
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [getCaptureRoot, activeInvestigation]);

  useEffect(() => {
    if (open && investigations.length === 0) setSelectedId(NEW_INVESTIGATION);
  }, [open, investigations.length]);

  const creatingNew = selectedId === NEW_INVESTIGATION;
  const canSave =
    !saving && (creatingNew ? newName.trim().length > 0 : selectedId.length > 0);

  const notify = (
    intent: 'success' | 'warning' | 'error',
    title: string,
    body?: string,
  ) => {
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
        {body && <ToastBody>{body}</ToastBody>}
      </Toast>,
      { intent, timeout: intent === 'success' ? 3000 : 6000 },
    );
  };

  const handleSave = async () => {
    const root = getCaptureRoot();
    if (!root) {
      setError('Could not find the page content to capture.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const investigationId = creatingNew
        ? (await createInvestigation(newName.trim(), newDescription.trim() || undefined)).id
        : selectedId;

      // A freshly created investigation becomes the active capture target.
      if (creatingNew) {
        setActiveInvestigation({ id: investigationId, name: newName.trim() });
      }

      await captureCurrentPageEvidence({
        root,
        pageKey,
        pageName,
        captureContext: readCaptureContext(),
        investigationId,
        annotation,
      });

      setOpen(false);
      notify('success', 'Saved to investigation', 'Evidence saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Toaster toasterId={toasterId} position="top-end" />
      <Tooltip
        content={
          activeInvestigation
            ? `Active investigation: ${activeInvestigation.name}. Capture evidence here.`
            : 'Capture evidence for investigation'
        }
        relationship="label"
        withArrow
      >
        <Button
          appearance={activeInvestigation ? 'primary' : 'subtle'}
          icon={<BookmarkAdd24Regular />}
          aria-label={
            activeInvestigation
              ? `Capture evidence for investigation: ${activeInvestigation.name}`
              : 'Capture evidence for investigation'
          }
          onClick={openDialog}
        />
      </Tooltip>

      <Dialog open={open} onOpenChange={(_, data) => !data.open && setOpen(false)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle
              action={
                <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={() => setOpen(false)} />
              }
            >
              Add “{pageName}” to an investigation
            </DialogTitle>
            <DialogContent className={styles.content}>
              <Text className={styles.hint}>
                Captures this page's analysis parameters and a Markdown snapshot,
                plus {chartCount}{' '}
                {chartCount === 1 ? 'chart' : 'charts'} (PNG + CSV) and a link that restores this
                view.
              </Text>

              <Field label="Investigation" required>
                <Dropdown
                  value={
                    creatingNew
                      ? 'New investigation…'
                      : investigations.find((i) => i.id === selectedId)?.name ?? ''
                  }
                  selectedOptions={[selectedId]}
                  onOptionSelect={(_, d) => setSelectedId(d.optionValue ?? NEW_INVESTIGATION)}
                >
                  <Option value={NEW_INVESTIGATION}>New investigation…</Option>
                  {investigations.map((inv) => (
                    <Option key={inv.id} value={inv.id}>
                      {inv.id === activeInvestigation?.id ? `${inv.name} (active)` : inv.name}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              {creatingNew && (
                <>
                  <Field label="Name" required>
                    <Input
                      value={newName}
                      onChange={(_, d) => setNewName(d.value)}
                      placeholder="e.g. Line 3 vibration investigation"
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      value={newDescription}
                      onChange={(_, d) => setNewDescription(d.value)}
                      rows={2}
                      placeholder="What are you investigating?"
                    />
                  </Field>
                </>
              )}

              <Field label="Annotation / comments">
                <Textarea
                  value={annotation}
                  onChange={(_, d) => setAnnotation(d.value)}
                  rows={3}
                  placeholder="Your notes about what this page shows…"
                />
              </Field>

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={handleSave} disabled={!canSave}>
                {saving ? <Spinner size="tiny" /> : 'Save evidence'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
