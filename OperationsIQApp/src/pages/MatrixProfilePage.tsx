import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Subtitle1,
  Tab,
  TabList,
  Text,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowLeftRegular } from '@fluentui/react-icons';
import { useAuth } from '../context/AuthContext';
import { ensureLivyConsent } from '../lib/msal';
import { getFabricAccountEmail } from '../lib/rayfinClient';
import type { TagInfo } from '../lib/tags';
import type { KqlOptions } from '../lib/connectionProfile';
import type { SimilarityQuerySeed } from '../lib/appTypes';
import type { AnalysisJob, JobType, Label, LabelCategory, LabelInput } from '../lib/mp/types';
import {
  listJobs,
  submitJob,
  cancelJob,
  listLabels,
  listAllLabels,
  createLabels,
  updateLabel,
  deleteLabel,
  listLabelCategories,
  type LabelUpdate,
} from '../lib/mp/analysisClient';
import { dispatchJob, pollJobStatus, deleteJob, stopJob, isUnfinished } from '../lib/mp/livyDispatch';
import { toJobInput } from '../state/wizardState';
import { defaultAnalysisName, jobTypeLabel, JOB_TYPE_ORDER } from '../lib/mp/naming';
import { recipeById } from '../lib/mp/recipes';
import { Wizard } from '../components/mp/wizard/Wizard';
import { useControlledPage, pf, coerce } from '../hooks/usePageController';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import { fmtWindow, tagNames } from '../lib/captureContextHelpers';
import { ResultsView } from '../components/mp/ResultsView';
import { PatternRunsTable } from '../components/mp/PatternRunsTable';
import { PatternLibraryPanel } from '../components/mp/PatternLibraryPanel';
import { ExplainRail, Glossary } from '../components/mp/ExplainRail';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';
import { useTagLabeler } from '../context/TagDisplayContext';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  root: {
    display: 'flex',
    gap: tokens.spacingHorizontalL,
    padding: `${tokens.spacingVerticalM} 0`,
    alignItems: 'flex-start',
  },
  wizard: { width: '360px', flexShrink: 0 },
  center: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  side: {
    width: '280px',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  review: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: `${tokens.spacingVerticalM} 0`,
  },
  reviewHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  noProfile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalXXXL,
  },
});

export interface MatrixProfilePageProps {
  tags: TagInfo[];
  /** Active connection profile's KQL endpoint, used as the analysis source. */
  kqlOpts?: KqlOptions;
  /** Pre-select an analysis recipe (e.g. from a "Deep discovery" menu item). */
  initialRecipeId?: string;
  /** Pre-select the landing tab (e.g. "Saved patterns" from a menu item). */
  initialTab?: 'runs' | 'library';
  /**
   * Launch a granularity-locked Similarity search prefilled from a discovered
   * pattern ("Find more like these" — Scenario 2). Wired to the app-level seed
   * handler that navigates to the Similarity page.
   */
  onUseAsQuery?: (seed: SimilarityQuerySeed) => void;
}

/**
 * The Matrix Profile Patterns tab. Hosts the analysis wizard, job history panel,
 * and the full ResultsView for the selected job.
 */
export function MatrixProfilePage({ tags, kqlOpts, initialRecipeId, initialTab, onUseAsQuery }: MatrixProfilePageProps) {
  const styles = useStyles();
  const { status } = useAuth();
  const labeler = useTagLabeler();

  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
  const [view, setView] = useState<'list' | 'review'>('list');
  const [labels, setLabels] = useState<Label[]>([]);
  const [savedPatterns, setSavedPatterns] = useState<Label[]>([]);
  const [listTab, setListTab] = useState<'runs' | 'library'>('runs');
  const [categories, setCategories] = useState<LabelCategory[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toasterId = useId('mp-toaster');
  const { dispatchToast } = useToastController(toasterId);

  // The recipe we arrived with (from a "Deep discovery" menu item) drives the
  // page title and the default run-history type filter, so each entry point
  // reads distinctly instead of showing an identical, unlabeled surface.
  const recipe = initialRecipeId ? recipeById(initialRecipeId) : undefined;

  // Run-history filter by analysis type, defaulted to the type we arrived with.
  const [typeFilter, setTypeFilter] = useState<JobType | 'all'>(() => recipe?.jobType ?? 'all');

  // Latest jobs snapshot + a re-entrancy guard for the background poll loop.
  const jobsRef = useRef<AnalysisJob[]>([]);
  jobsRef.current = jobs;
  const pollingRef = useRef(false);

  const selectedJob = jobs.find((j) => j.id === selectedJobId);

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);

  // Saved-patterns library helpers: a friendly signal label honoring the global "show tag
  // id" preference, and a resolver from a pattern's run id to its analysis type (patterns
  // store only a jobId, so the analysis-type filter looks the type up in the run history).
  const libLabelFor = useCallback(
    (id: string) => labeler(id, nameById.get(id)),
    [labeler, nameById],
  );
  const jobTypeById = useMemo(() => new Map(jobs.map((j) => [j.id, j.type])), [jobs]);
  const jobTypeFor = useCallback(
    (jobId?: string) => (jobId ? jobTypeById.get(jobId) : undefined),
    [jobTypeById],
  );

  // "Review saved patterns" is a dedicated, read-only surface (from its own menu item):
  // just the saved-pattern library, with no wizard and no run history. It is distinguished
  // from the analysis pages by arriving on the library tab without a discovery recipe.
  const savedOnly = initialTab === 'library' && !recipe;
  const captureSummary = useMemo<CaptureContextSummary | null>(() => {
    if (!selectedJob) return null;
    return {
      sections: [
        {
          title: 'Selected analysis',
          fields: [
            { label: 'Name', value: selectedJob.name ?? '(unnamed)' },
            { label: 'Signal', value: tagNames([selectedJob.signalId], nameById) },
            { label: 'Type', value: selectedJob.type },
            {
              label: 'Window',
              value: fmtWindow(new Date(selectedJob.windowStart), new Date(selectedJob.windowEnd)),
            },
            {
              label: 'Subsequence length',
              value: selectedJob.subLen != null ? String(selectedJob.subLen) : 'Auto',
            },
            { label: 'Status', value: selectedJob.status },
          ],
        },
      ],
    };
  }, [selectedJob, nameById]);
  useRegisterCaptureContext(captureSummary);

  const refreshJobs = useCallback(async () => {
    try {
      const fetched = await listJobs();
      setJobs(fetched.sort((a, b) => {
        const ta = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
        const tb = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
        return tb - ta;
      }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshLabels = useCallback(async (signalId: string) => {
    try {
      const fetched = await listLabels(signalId);
      setLabels(fetched);
    } catch { /* non-critical */ }
  }, []);

  const refreshCategories = useCallback(async () => {
    try {
      const cats = await listLabelCategories();
      setCategories(cats);
    } catch { /* non-critical */ }
  }, []);

  const refreshSavedPatterns = useCallback(async () => {
    try {
      const all = await listAllLabels();
      setSavedPatterns(all);
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => {
    if (status === 'signed-in') {
      void refreshJobs();
      void refreshCategories();
      void refreshSavedPatterns();
    }
  }, [status, refreshJobs, refreshCategories, refreshSavedPatterns]);

  // Refresh labels when selected job changes
  useEffect(() => {
    if (selectedJob) void refreshLabels(selectedJob.signalId);
  }, [selectedJob, refreshLabels]);

  // Background poll: every 15s, read the Livy session/statement for every
  // unfinished job with a live session and persist its transparent status, then
  // reload the run history. The pollingRef guard prevents overlapping passes when
  // a slow request outlasts the interval.
  useEffect(() => {
    if (status !== 'signed-in') return;

    const tick = async () => {
      if (pollingRef.current) return;
      const active = jobsRef.current.filter((j) => isUnfinished(j) && j.livySessionId);
      if (active.length === 0) return;
      pollingRef.current = true;
      try {
        await Promise.all(
          active.map((j) => pollJobStatus(j, { kqlOpts }).catch(() => null)),
        );
        await refreshJobs();
      } finally {
        pollingRef.current = false;
      }
    };

    const handle = window.setInterval(() => void tick(), 15_000);
    return () => window.clearInterval(handle);
  }, [status, kqlOpts, refreshJobs]);

  // When a "Deep discovery" menu item pre-selects a recipe, show the wizard
  // (list view) so the pre-seeded analysis is visible, and default the run-history
  // filter to that recipe's analysis type so the list matches the entry point.
  useEffect(() => {
    if (initialRecipeId) {
      setView('list');
      setTypeFilter(recipeById(initialRecipeId)?.jobType ?? 'all');
    }
  }, [initialRecipeId]);

  // When the "Saved patterns" menu item deep-links here, open the list view on
  // that tab instead of the default Runs tab.
  useEffect(() => {
    if (initialTab) {
      setView('list');
      setListTab(initialTab);
    }
  }, [initialTab]);

  const handleSubmit = async (input: ReturnType<typeof toJobInput>) => {
    try {
      // The SPA submits the Spark job directly to the Fabric Livy endpoint,
      // which needs the delegated Livy API scopes. Prompt for consent from this
      // submit gesture if they have not been granted yet, before creating the
      // job row — so the subsequent Livy dispatch has a usable token. No popup
      // appears when the scopes are already consented.
      await ensureLivyConsent(getFabricAccountEmail());

      const signalTag = tags.find((t) => t.tagId === input.signalId);
      const name =
        input.name ??
        defaultAnalysisName({
          type: input.type,
          signalName: signalTag?.tagName,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        });
      // Forward the full wizard-built input (`toJobInput`) so every job field is
      // persisted — including the multi-series selection (`signalIds`/`minCount`) that
      // MULTIDIM_*/CONSENSUS_MOTIF runs need. Enumerating fields here previously dropped
      // `signalIds`, so the Livy dispatch resolved a single series and Spark rejected the
      // run ("requires at least two series"). Only `name` is overridden with the default.
      const newJob = await submitJob({
        ...input,
        name,
      });
      setJobs((prev) => [newJob, ...prev]);
      setSelectedJobId(newJob.id);
      setView('review');

      // Immediately dispatch the QUEUED row to the Fabric Livy endpoint (create a
      // Spark session + submit the analysis statement). The returned patch records
      // the session/statement ids and initial status; merge the display fields into
      // local state so the run history reflects the real state without waiting for
      // the next poll (Date fields are refreshed from the DB by refreshJobs).
      const patch = await dispatchJob(newJob, { kqlOpts });
      setJobs((prev) =>
        prev.map((j) =>
          j.id === newJob.id
            ? {
                ...j,
                status: patch.status ?? j.status,
                progressPct: patch.progressPct ?? j.progressPct,
                stage: patch.stage ?? j.stage,
                livySessionId: patch.livySessionId ?? j.livySessionId,
                livyStatementId: patch.livyStatementId ?? j.livyStatementId,
                livyState: patch.livyState ?? j.livyState,
                sparkUiUrl: patch.sparkUiUrl ?? j.sparkUiUrl,
                errorMessage: patch.errorMessage ?? j.errorMessage,
              }
            : j,
        ),
      );
    } catch (err) {
      // A dismissed/blocked consent popup surfaces as an MSAL error; guide the
      // user rather than showing a raw error code.
      const code =
        typeof err === 'object' && err !== null && 'errorCode' in err
          ? (err as { errorCode?: string }).errorCode
          : undefined;
      if (code === 'user_cancelled' || code === 'consent_required' || code === 'access_denied') {
        setLoadError(
          'Permission to run the analysis was not granted. Approve the requested Fabric Livy access and try again.',
        );
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleCancel = async (id: string) => {
    const job = jobsRef.current.find((j) => j.id === id);
    try {
      // Real stop-early: tear down the Livy compute so it stops burning capacity, then
      // mark the row CANCELLED. Any best-so-far streamed to job_progress is retained and
      // still shown in the review view — we don't blank the results on cancel.
      if (job) await stopJob(job, { kqlOpts });
      await cancelJob(id);
      await refreshJobs();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    const job = jobsRef.current.find((j) => j.id === id);
    if (!job) return;
    // Optimistically drop it from the list; the Livy session (if any) is torn
    // down best-effort so a stuck session stops consuming capacity.
    setJobs((prev) => prev.filter((j) => j.id !== id));
    if (selectedJobId === id) {
      setSelectedJobId(undefined);
      setView('list');
    }
    try {
      await deleteJob(job, { kqlOpts });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      await refreshJobs();
    }
  };

  const handleCreateLabels = async (inputs: LabelInput[]) => {
    // Nothing to persist (e.g. "apply to all similar" propagated to zero spans): don't
    // hit the backend and never report a phantom success.
    if (inputs.length === 0) {
      dispatchToast(
        <Toast>
          <ToastTitle>Nothing to label</ToastTitle>
          <ToastBody>No matching stretches were found to label.</ToastBody>
        </Toast>,
        { intent: 'warning' },
      );
      return;
    }
    try {
      const created = await createLabels(inputs);
      // Optimistically merge the saved labels into state so they appear immediately —
      // the control-plane read can lag briefly behind the write, so we don't rely on
      // an immediate re-fetch (which could return a stale list and hide the new label).
      const mergeById = (prev: Label[]) => {
        const map = new Map(prev.map((l) => [l.id, l]));
        for (const l of created) map.set(l.id, l);
        return [...map.values()];
      };
      setLabels(mergeById);
      setSavedPatterns(mergeById);
      dispatchToast(
        <Toast>
          <ToastTitle>
            {created.length > 1 ? `${created.length} labels saved` : 'Label saved'}
          </ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      // Reconcile with the store so the UI reflects what actually persisted (server ids,
      // createdAt, and any rows written by other sessions). Unioned with the optimistic
      // state above so a lagging read can't briefly hide the just-created labels.
      void refreshSavedPatterns();
      if (selectedJob) void refreshLabels(selectedJob.signalId);
    } catch (err) {
      dispatchToast(
        <Toast>
          <ToastTitle>Couldn’t save the label</ToastTitle>
          <ToastBody>{err instanceof Error ? err.message : String(err)}</ToastBody>
        </Toast>,
        { intent: 'error', timeout: 8000 },
      );
    }
  };

  const handleUpdateLabel = async (id: string, patch: LabelUpdate) => {
    // Optimistic edit so the UI updates immediately; reconcile with the store next.
    const prevLabels = labels;
    const prevSaved = savedPatterns;
    const apply = (ls: Label[]) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l));
    setLabels(apply);
    setSavedPatterns(apply);
    try {
      await updateLabel(id, patch);
      dispatchToast(
        <Toast>
          <ToastTitle>Label updated</ToastTitle>
        </Toast>,
        { intent: 'success' },
      );
      void refreshSavedPatterns();
      if (selectedJob) void refreshLabels(selectedJob.signalId);
    } catch (err) {
      setLabels(prevLabels);
      setSavedPatterns(prevSaved);
      dispatchToast(
        <Toast>
          <ToastTitle>Couldn’t update the label</ToastTitle>
          <ToastBody>{err instanceof Error ? err.message : String(err)}</ToastBody>
        </Toast>,
        { intent: 'error', timeout: 8000 },
      );
    }
  };

  const handleDeleteLabel = async (id: string) => {
    // Optimistic removal so the UI updates immediately; reconcile with the store next.
    const prevLabels = labels;
    const prevSaved = savedPatterns;
    setLabels((ls) => ls.filter((l) => l.id !== id));
    setSavedPatterns((ls) => ls.filter((l) => l.id !== id));
    try {
      await deleteLabel(id);
    } catch (err) {
      setLabels(prevLabels);
      setSavedPatterns(prevSaved);
      dispatchToast(
        <Toast>
          <ToastTitle>Couldn’t delete the label</ToastTitle>
          <ToastBody>{err instanceof Error ? err.message : String(err)}</ToastBody>
        </Toast>,
        { intent: 'error', timeout: 8000 },
      );
    }
  };

  const handleJobUpdate = useCallback(async () => {
    await refreshJobs();
  }, [refreshJobs]);

  useControlledPage({
    pageKey: 'patterns',
    title: recipe ? recipe.title : 'Patterns',
    fields: [
      {
        field: pf.enumOf(
          'typeFilter',
          'Run-history analysis type',
          typeFilter,
          [
            { value: 'all', label: 'All types' },
            ...JOB_TYPE_ORDER.map((t) => ({ value: t, label: jobTypeLabel(t) })),
          ],
          { description: 'Filter the pattern-analysis run history by analysis type.' },
        ),
        apply: (v) =>
          setTypeFilter(coerce.enumValue(v, ['all', ...JOB_TYPE_ORDER]) as JobType | 'all'),
      },
      {
        field: pf.string('selectedJobId', 'Selected job id', selectedJobId ?? '', {
          description: 'Existing pattern-analysis job id to open in the review view.',
        }),
        apply: (v) => {
          const id = coerce.string(v);
          setSelectedJobId(id || undefined);
          setView(id ? 'review' : 'list');
        },
      },
      {
        field: pf.enumOf('view', 'View', view, [
          { value: 'list', label: 'Job list' },
          { value: 'review', label: 'Review selected job' },
        ]),
        apply: (v) => setView(coerce.enumValue(v, ['list', 'review']) as 'list' | 'review'),
      },
    ],
    canRun: false,
    run: () => {},
    loading: false,
    error: loadError ?? undefined,
    hasResult: !!selectedJob,
  });

  if (status !== 'signed-in') {
    return (
      <div className={styles.noProfile}>
        <Text size={500}>Sign in to use Pattern Analysis.</Text>
      </div>
    );
  }

  if (tags.length === 0) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>No tags available.</MessageBarTitle>
          Configure a ConnectionProfile with a timeseries source to start analyzing patterns.
        </MessageBarBody>
      </MessageBar>
    );
  }

  // Review view: a dedicated, full-width surface for the selected analysis so it is
  // not buried beneath a growing run-history list.
  if (view === 'review' && selectedJob) {
    return (
      <div className={styles.review}>
        <Toaster toasterId={toasterId} position="top-end" />
        <div className={styles.reviewHeader}>
          <Button
            appearance="subtle"
            icon={<ArrowLeftRegular />}
            onClick={() => setView('list')}
          >
            {savedOnly ? 'Back to saved patterns' : 'Back to analyses'}
          </Button>
        </div>

        {loadError && (
          <ErrorMessageBar error={loadError} prefix="Error: " />
        )}

        <OutputDescription label="Pattern analysis results">
          {EXPLAINERS.patterns.outputs!.results}
        </OutputDescription>
        <ResultsView
          job={selectedJob}
          tags={tags}
          labels={labels}
          categories={categories}
          onCreateLabels={(inputs) => void handleCreateLabels(inputs)}
          onUpdateLabel={(id, patch) => void handleUpdateLabel(id, patch)}
          onDeleteLabel={(id) => void handleDeleteLabel(id)}
          onJobUpdate={() => void handleJobUpdate()}
          onStop={handleCancel}
          onFindMore={onUseAsQuery}
        />
      </div>
    );
  }

  // "Review saved patterns" surface: a clean, read-only library with no analysis wizard and
  // no run-history tab — just the saved patterns and their filters.
  if (savedOnly) {
    return (
      <div className={styles.page}>
        <Toaster toasterId={toasterId} position="top-end" />
        <Subtitle1>Saved patterns</Subtitle1>
        <PageIntro
          title="Saved patterns"
          overview="Every pattern and anomaly you've saved from your analyses, in one place. Search and filter by analysis type, kind, category, or signal to find a saved shape."
          interpretation="Saved patterns are the labels you applied to motifs and anomalies during a run. Open the run a pattern came from to review it in context, or delete one to remove it from the library."
        />

        <div className={styles.root}>
          <div className={styles.center}>
            {loadError && (
              <ErrorMessageBar error={loadError} prefix="Error: " />
            )}
            <PatternLibraryPanel
              patterns={savedPatterns}
              categories={categories}
              labelFor={libLabelFor}
              jobTypeFor={jobTypeFor}
              onOpenRun={(jobId) => {
                setSelectedJobId(jobId);
                setView('review');
              }}
              onDelete={(id) => void handleDeleteLabel(id)}
            />
          </div>

          <div className={styles.side}>
            <ExplainRail title="What is Pattern Analysis?">
              <Text size={200}>
                Matrix Profile analysis finds the most repeated and most unusual stretches in your time series.
                It uses Spark for large windows and gives you answers in plain language — no signal-processing
                knowledge needed.
              </Text>
            </ExplainRail>
            <ExplainRail title="Glossary">
              <Glossary />
            </ExplainRail>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <Toaster toasterId={toasterId} position="top-end" />
      <Subtitle1>{recipe ? recipe.title : 'Pattern analysis'}</Subtitle1>
      <PageIntro
        title={recipe ? recipe.title : 'Patterns'}
        overview={recipe ? recipe.explainer : EXPLAINERS.patterns.overview}
        interpretation={EXPLAINERS.patterns.interpretation}
        technical={EXPLAINERS.patterns.technical}
      />

      <div className={styles.root}>
        {/* Left: Wizard */}
        <div className={styles.wizard}>
          <Wizard tags={tags} onSubmit={handleSubmit} initialRecipeId={initialRecipeId} />
        </div>

        {/* Center: Job history (selecting a job opens the review view) */}
        <div className={styles.center}>
          {loadError && (
            <ErrorMessageBar error={loadError} prefix="Error: " />
          )}

          <TabList
            selectedValue={listTab}
            onTabSelect={(_, d) => setListTab(d.value as 'runs' | 'library')}
          >
            <Tab value="runs">Runs</Tab>
            <Tab value="library">Saved patterns ({savedPatterns.length})</Tab>
          </TabList>

          {listTab === 'runs' ? (
            <>
              <OutputDescription label="Pattern analysis jobs">
                {EXPLAINERS.patterns.outputs!.jobPanel}
              </OutputDescription>
              <PatternRunsTable
                jobs={jobs}
                onCancel={handleCancel}
                onDelete={(id) => void handleDelete(id)}
                onSelect={(id) => {
                  setSelectedJobId(id);
                  setView('review');
                }}
                selectedId={selectedJobId}
                typeFilter={typeFilter}
                onTypeFilterChange={setTypeFilter}
              />
            </>
          ) : (
            <PatternLibraryPanel
              patterns={savedPatterns}
              categories={categories}
              labelFor={libLabelFor}
              jobTypeFor={jobTypeFor}
              initialAnalysisType={recipe?.jobType ?? 'all'}
              onOpenRun={(jobId) => {
                setSelectedJobId(jobId);
                setView('review');
              }}
              onDelete={(id) => void handleDeleteLabel(id)}
            />
          )}
        </div>

        {/* Right: Explain rail + Glossary */}
        <div className={styles.side}>
          <ExplainRail title="What is Pattern Analysis?">
            <Text size={200}>
              Matrix Profile analysis finds the most repeated and most unusual stretches in your time series.
              It uses Spark for large windows and gives you answers in plain language — no signal-processing
              knowledge needed.
            </Text>
          </ExplainRail>
          <ExplainRail title="Glossary">
            <Glossary />
          </ExplainRail>
        </div>
      </div>
    </div>
  );
}
