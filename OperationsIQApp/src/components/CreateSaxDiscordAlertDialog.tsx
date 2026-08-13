import { useCallback, useEffect, useMemo, useState } from 'react';
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
  SpinButton,
  Textarea,
  Dropdown,
  Option,
  Radio,
  RadioGroup,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  Link,
  Divider,
  Toaster,
  useToastController,
  useId,
  Toast,
  ToastTitle,
  ToastBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import {
  buildActivatorSaxDiscordKql,
  buildSaxDiscordThresholdQuery,
  SAX_THRESHOLD_COLUMNS,
  type ActivatorKql,
  type SaxDiscordParams,
} from '../lib/kql';
import {
  ACTIVATOR_FREQUENCIES,
  DEFAULT_ACTIVATOR_FREQUENCY_KEY,
  frequencyLabelFor,
  frequencySecondsFor,
} from '../lib/activator/frequency';
import { buildActivatorSaxNotes } from '../lib/activator/notes';
import {
  buildReflexDefinition,
  appendEntitiesToDefinition,
} from '../lib/activator/reflexDefinition';
import {
  listReflexes,
  createReflex,
  getReflexDefinition,
  updateReflexDefinition,
  reflexWebUrl,
  type FabricReflex,
} from '../lib/fabricDiscovery';
import { ensureFabricWriteConsent } from '../lib/msal';
import { getFabricAccountEmail } from '../lib/rayfinClient';
import { saveActivatorAlert } from '../lib/activatorAlerts';
import { executeKql } from '../lib/eventhouse';
import { formatDuration } from '../lib/binningSettings';

const NEW_REFLEX = '__new__';

const useStyles = makeStyles({
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxHeight: '70vh',
    overflowY: 'auto',
  },
  sectionTitle: { fontWeight: tokens.fontWeightSemibold, marginTop: tokens.spacingVerticalS },
  hint: { color: tokens.colorNeutralForeground3 },
  readonlyBox: {
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  thresholdRow: { display: 'flex', alignItems: 'end', gap: tokens.spacingHorizontalM },
  surface: { maxWidth: '640px' },
});

export interface CreateSaxDiscordAlertDialogProps {
  open: boolean;
  onClose: () => void;
  /** Signals scanned independently for discords (>=1). */
  tagIds: string[];
  /** Detection-window length in bins (>= windowSize) used by the completed run. */
  detectionBins: number;
  /** SAX discord parameters from the completed run. */
  sax: SaxDiscordParams;
  /** Active connection-profile timeseries query (bound as UTC Timeseries). */
  timeseriesRef: string;
  connectionProfileName: string;
  /** Active profile KQL database name — shown as a read-only label. */
  databaseName: string;
  /** Fabric workspace id from the active profile (captured during Discover from Fabric). */
  fabricWorkspaceId?: string;
  /** Fabric KQL database item id from the active profile; used as eventhouseItem.itemId. */
  kqlDatabaseId?: string;
  /** Search granularity as a KQL timespan literal (e.g. '15m'). */
  binKql: string;
  /** Search granularity in seconds. */
  binSeconds: number;
  /** Human-readable granularity (e.g. "15 minutes"). */
  binLabel: string;
  /** Called after an alert pointer is persisted so the caller can refresh lists. */
  onCreated?: () => void;
}

/**
 * Dialog that turns a completed SAX-discord detection-window run into a
 * self-contained, server-side Fabric Activator (Reflex) alert. It re-runs the
 * discord scan on a schedule entirely inside Fabric and emails the creator
 * whenever a recent window's nearest-neighbor distance meets a frozen threshold.
 * A "Suggest threshold" helper computes a baseline percentile at authoring time
 * to pre-fill that threshold; it is NOT run at alert time. Mirrors the MVAD
 * anomaly-alert flow (consent → build KQL/definition → create or append reflex →
 * persist pointer).
 */
export function CreateSaxDiscordAlertDialog(props: CreateSaxDiscordAlertDialogProps) {
  const {
    open,
    onClose,
    tagIds,
    detectionBins,
    sax,
    timeseriesRef,
    connectionProfileName,
    databaseName,
    fabricWorkspaceId,
    kqlDatabaseId,
    binKql,
    binSeconds,
    binLabel,
    onCreated,
  } = props;
  const styles = useStyles();
  const toasterId = useId('sax-activator-toaster');
  const { dispatchToast } = useToastController(toasterId);

  const creatorEmail = getFabricAccountEmail() ?? '';

  // --- Details -------------------------------------------------------------
  const [ruleName, setRuleName] = useState('');
  const [description, setDescription] = useState('');

  // --- Monitor -------------------------------------------------------------
  const [frequencyKey, setFrequencyKey] = useState<string>(DEFAULT_ACTIVATOR_FREQUENCY_KEY);

  // --- Condition (distance threshold) -------------------------------------
  const [threshold, setThreshold] = useState<number>(0);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);

  // --- Action (email) ------------------------------------------------------
  const [subject, setSubject] = useState('');
  const [headline, setHeadline] = useState('');
  const [notes, setNotes] = useState('');
  const [notesEdited, setNotesEdited] = useState(false);

  // --- Save location -------------------------------------------------------
  const workspaceId = fabricWorkspaceId ?? '';
  const dbItemId = kqlDatabaseId ?? '';
  const [reflexes, setReflexes] = useState<FabricReflex[]>([]);
  const [reflexTarget, setReflexTarget] = useState<string>(NEW_REFLEX);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const frequencySeconds = frequencySecondsFor(frequencyKey);

  // Build the KQL live so the Notes lookback stays in sync with the frequency
  // and the threshold field.
  const built: ActivatorKql = useMemo(
    () =>
      buildActivatorSaxDiscordKql({
        timeseriesRef,
        tagIds,
        binKql,
        binSeconds,
        detectionBins,
        frequencySeconds,
        distanceThreshold: threshold > 0 ? threshold : 0,
        ...sax,
      }),
    [timeseriesRef, tagIds, binKql, binSeconds, detectionBins, frequencySeconds, threshold, sax],
  );

  const detectionWindowLabel = `${formatDuration(detectionBins * binSeconds)} (${detectionBins} bins)`;

  const paramLines = useMemo(
    () => [
      `Window size: ${sax.windowSize}`,
      `Discords per signal: ${sax.numDiscords}`,
      `PAA size: ${sax.paaSize}`,
      `Alphabet size: ${sax.alphabetSize}`,
      `Z-norm threshold: ${sax.znormThreshold}`,
      `Candidate limit: ${sax.candidateLimit}`,
    ],
    [sax],
  );

  const defaultNotes = useMemo(
    () =>
      buildActivatorSaxNotes({
        connectionProfileName,
        tags: tagIds,
        binLabel,
        detectionWindowLabel,
        frequencyLabel: frequencyLabelFor(frequencyKey),
        lookbackSeconds: built.lookbackSeconds,
        distanceThreshold: threshold,
        appUrl: window.location.href,
        paramLines,
      }),
    [
      connectionProfileName,
      tagIds,
      binLabel,
      detectionWindowLabel,
      frequencyKey,
      built.lookbackSeconds,
      threshold,
      paramLines,
    ],
  );

  const defaultDescription = useMemo(
    () =>
      `SAX discord anomaly alert across ${tagIds.length} signal${tagIds.length === 1 ? '' : 's'}. Re-runs the shape-novelty scan on a schedule and emails the creator when a recent window's discord distance meets the threshold. Source connection: "${connectionProfileName}".`,
    [tagIds.length, connectionProfileName],
  );

  // Seed the editable fields when the dialog opens; keep user edits afterwards.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuggestNote(null);
    setRuleName((prev) => prev || 'SAX discord alert');
    setDescription((prev) => prev || defaultDescription);
    setSubject((prev) => prev || 'Anomaly detected');
    setHeadline(
      (prev) => prev || "A new anomaly was detected for '" + (ruleName || 'your signals') + "'",
    );
    if (!notesEdited) setNotes(defaultNotes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultNotes, defaultDescription]);

  // Load existing Activators for the profile's workspace so "add to an existing
  // Activator" can offer them. Guarded on the workspace id being present.
  useEffect(() => {
    if (!open || !workspaceId) {
      setReflexes([]);
      setReflexTarget(NEW_REFLEX);
      return;
    }
    let cancelled = false;
    setReflexTarget(NEW_REFLEX);
    listReflexes(workspaceId)
      .then((reflexList) => {
        if (!cancelled) setReflexes(reflexList);
      })
      .catch(() => {
        if (!cancelled) setReflexes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const missingFabricIds = !fabricWorkspaceId || !kqlDatabaseId;
  const creatingNew = reflexTarget === NEW_REFLEX;
  const canCreate =
    !busy &&
    !missingFabricIds &&
    ruleName.trim().length > 0 &&
    description.trim().length > 0 &&
    subject.trim().length > 0 &&
    threshold > 0 &&
    !!workspaceId &&
    !!dbItemId &&
    !!creatorEmail;

  const notify = (intent: 'success' | 'error', title: string, node?: React.ReactNode) => {
    dispatchToast(
      <Toast>
        <ToastTitle>{title}</ToastTitle>
        {node && <ToastBody>{node}</ToastBody>}
      </Toast>,
      { intent, timeout: 8000 },
    );
  };

  // Authoring-time self-calibration: run the whole-range baseline and pre-fill
  // the threshold from the p90 discord distance. Not run at alert time.
  const suggestThreshold = useCallback(async () => {
    setSuggestBusy(true);
    setSuggestNote(null);
    setError(null);
    try {
      const csl = buildSaxDiscordThresholdQuery({
        timeseriesRef,
        tagIds,
        binKql,
        binSeconds,
        detectionBins,
        ...sax,
      });
      const table = await executeKql(csl);
      const colIndex = (name: string) => table.columns.findIndex((c) => c.name === name);
      const row = table.rows[0];
      const p90Idx = colIndex(SAX_THRESHOLD_COLUMNS.p90);
      const samplesIdx = colIndex(SAX_THRESHOLD_COLUMNS.samples);
      const p90 = row && p90Idx >= 0 ? Number(row[p90Idx]) : NaN;
      const samples = row && samplesIdx >= 0 ? Number(row[samplesIdx]) : 0;
      if (!Number.isFinite(p90) || !samples) {
        setSuggestNote('Not enough recent history to calibrate — enter a threshold manually.');
        return;
      }
      const suggested = Number(p90.toPrecision(4));
      setThreshold(suggested);
      setSuggestNote(
        `Suggested ${suggested} — the 90th-percentile discord distance across ${samples} baseline sample${samples === 1 ? '' : 's'}. Adjust as needed.`,
      );
    } catch (e) {
      setSuggestNote(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestBusy(false);
    }
  }, [timeseriesRef, tagIds, binKql, binSeconds, detectionBins, sax]);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!creatorEmail) throw new Error('Sign in with Fabric before creating an alert.');
      if (!(threshold > 0)) throw new Error('Set a distance threshold before creating the alert.');
      await ensureFabricWriteConsent(creatorEmail);

      const definitionInput = {
        displayName: ruleName.trim(),
        description: description.trim(),
        queryString: built.queryString,
        frequencySeconds,
        kqlDatabaseItemId: dbItemId,
        kqlWorkspaceId: workspaceId,
        creatorEmail,
        subjectBase: subject.trim(),
        subjectField: built.subjectField,
        headline: headline.trim() || subject.trim(),
        notes,
        contextFields: built.contextFields,
      };
      const definition = buildReflexDefinition(definitionInput);

      let reflexItemId: string;
      let webUrl: string;
      let displayName: string;
      if (creatingNew) {
        const created = await createReflex(workspaceId, {
          displayName: ruleName.trim(),
          description: description.trim(),
          definition: definition.definition,
        });
        reflexItemId = created.id;
        webUrl = created.webUrl;
        displayName = created.displayName;
      } else {
        const existing = await getReflexDefinition(workspaceId, reflexTarget);
        const merged = appendEntitiesToDefinition(existing.parts, definition.entities);
        await updateReflexDefinition(workspaceId, reflexTarget, merged);
        reflexItemId = reflexTarget;
        webUrl = reflexWebUrl(workspaceId, reflexTarget);
        displayName = reflexes.find((r) => r.id === reflexTarget)?.displayName ?? ruleName.trim();
      }

      await saveActivatorAlert({
        workspaceId,
        reflexItemId,
        displayName: ruleName.trim(),
        webUrl,
        connectionProfileName,
        tags: tagIds,
        frequency: frequencyKey,
        searchParams: {
          mode: 'anomaly',
          binLabel,
          frequency: frequencyKey,
          lookbackSeconds: built.lookbackSeconds,
          algorithm: 'sax_discords',
          detectionBins,
        },
      }).catch(() => {
        // A failed pointer save must not hide a successful Fabric create.
      });

      notify(
        'success',
        creatingNew ? 'Activator alert created' : 'Rule added to Activator',
        <Link href={webUrl} target="_blank" rel="noreferrer">
          Open “{displayName}” in Fabric
        </Link>,
      );
      window.open(webUrl, '_blank', 'noopener,noreferrer');
      onCreated?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    creatorEmail,
    threshold,
    ruleName,
    description,
    built,
    frequencySeconds,
    dbItemId,
    workspaceId,
    subject,
    headline,
    notes,
    creatingNew,
    reflexTarget,
    reflexes,
    connectionProfileName,
    tagIds,
    frequencyKey,
    binLabel,
    detectionBins,
    onCreated,
    onClose,
  ]);

  return (
    <>
      <Toaster toasterId={toasterId} />
      <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
        <DialogSurface className={styles.surface}>
          <DialogBody>
            <DialogTitle
              action={<Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} />}
            >
              Create an anomaly alert
            </DialogTitle>
            <DialogContent className={styles.content}>
              <Text className={styles.hint}>
                Runs this SAX discord scan on a schedule entirely inside Fabric Activator and emails
                you when a recent window is more unusual than the distance threshold. All processing
                happens server-side in KQL.
              </Text>

              {missingFabricIds && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    This connection profile isn't linked to a Fabric workspace and KQL database yet.
                    Open Settings, edit this connection profile, and run "Discover from Fabric" to
                    enable Activator alerts.
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Details */}
              <Text className={styles.sectionTitle}>Details</Text>
              <Field label="Rule name" required>
                <Input value={ruleName} onChange={(_, d) => setRuleName(d.value)} />
              </Field>
              <Field label="Description" required>
                <Textarea
                  value={description}
                  onChange={(_, d) => setDescription(d.value)}
                  rows={2}
                  placeholder="Describe what this alert watches for."
                />
              </Field>

              <Divider />

              {/* Monitor */}
              <Text className={styles.sectionTitle}>Monitor</Text>
              <Field label="Run frequency">
                <Dropdown
                  value={frequencyLabelFor(frequencyKey)}
                  selectedOptions={[frequencyKey]}
                  onOptionSelect={(_, d) =>
                    setFrequencyKey(d.optionValue ?? DEFAULT_ACTIVATOR_FREQUENCY_KEY)
                  }
                >
                  {ACTIVATOR_FREQUENCIES.map((f) => (
                    <Option key={f.key} value={f.key}>
                      {f.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              <Divider />

              {/* Condition */}
              <Text className={styles.sectionTitle}>Condition</Text>
              <Text className={styles.hint}>
                The alert fires whenever a window in the most-recent {detectionWindowLabel} has a
                nearest-neighbor discord distance at or above this threshold when compared to the
                preceding history. Use “Suggest threshold” to calibrate from recent baseline data.
              </Text>
              <div className={styles.thresholdRow}>
                <Field label="Distance threshold (≥)" required>
                  <SpinButton
                    value={threshold}
                    min={0}
                    step={0.01}
                    onChange={(_, d) => {
                      const v =
                        d.value ?? (d.displayValue != null ? Number(d.displayValue) : undefined);
                      if (v != null && Number.isFinite(v)) setThreshold(v);
                    }}
                  />
                </Field>
                <Button onClick={suggestThreshold} disabled={suggestBusy || missingFabricIds}>
                  {suggestBusy ? <Spinner size="tiny" /> : 'Suggest threshold'}
                </Button>
              </div>
              {suggestNote && (
                <Text className={styles.hint}>{suggestNote}</Text>
              )}
              <Text className={styles.hint}>
                The threshold is frozen into the alert. If the data drifts, re-open this dialog, run
                “Suggest threshold” again, and create an updated alert.
              </Text>

              <Divider />

              {/* Action */}
              <Text className={styles.sectionTitle}>Action — Email</Text>
              <Field
                label="Subject"
                hint="The affected signal id(s) are appended to every subject automatically."
                required
              >
                <Input value={subject} onChange={(_, d) => setSubject(d.value)} />
              </Field>
              <Field label="Headline">
                <Input value={headline} onChange={(_, d) => setHeadline(d.value)} />
              </Field>
              <Field
                label="Notes"
                hint="Prefilled with the detection method + reproducible parameters. Editable."
              >
                <Textarea
                  value={notes}
                  onChange={(_, d) => {
                    setNotes(d.value);
                    setNotesEdited(true);
                  }}
                  rows={6}
                />
              </Field>
              <div className={styles.readonlyBox}>
                <Text>
                  The email is sent to <strong>{creatorEmail || '(your account)'}</strong> and the
                  Context area is preset with the essential result columns. To change the action
                  (e.g. Teams, a pipeline) or the context columns, open the Activator item in Fabric
                  after it is created.
                </Text>
              </div>

              <Divider />

              {/* Save location */}
              <Text className={styles.sectionTitle}>Save location</Text>
              <div className={styles.readonlyBox}>
                <Text>
                  Source: <strong>{connectionProfileName}</strong> — database{' '}
                  <strong>{databaseName || '(unknown)'}</strong>. The alert is created in the same
                  Fabric workspace as this connection.
                </Text>
              </div>
              <Field label="Activator item">
                <RadioGroup
                  value={reflexTarget === NEW_REFLEX ? NEW_REFLEX : 'existing'}
                  onChange={(_, d) =>
                    setReflexTarget(d.value === NEW_REFLEX ? NEW_REFLEX : (reflexes[0]?.id ?? NEW_REFLEX))
                  }
                >
                  <Radio value={NEW_REFLEX} label="Create a new Activator" />
                  <Radio
                    value="existing"
                    label="Add to an existing Activator"
                    disabled={reflexes.length === 0}
                  />
                </RadioGroup>
              </Field>
              {reflexTarget !== NEW_REFLEX && (
                <Field label="Existing Activator" required>
                  <Dropdown
                    value={reflexes.find((r) => r.id === reflexTarget)?.displayName ?? ''}
                    selectedOptions={[reflexTarget]}
                    onOptionSelect={(_, d) => setReflexTarget(d.optionValue ?? NEW_REFLEX)}
                  >
                    {reflexes.map((r) => (
                      <Option key={r.id} value={r.id}>
                        {r.displayName}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}

              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={handleCreate} disabled={!canCreate}>
                {busy ? <Spinner size="tiny" /> : creatingNew ? 'Create alert' : 'Add rule'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
