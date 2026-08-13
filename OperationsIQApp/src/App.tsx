import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorMessageBar } from './components/ErrorMessageBar';
import {
  Badge,
  Button,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';
import { AppShell } from './components/AppShell';
import { AppNav } from './components/AppNav';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProfileProvider, useProfile } from './context/ProfileContext';
import { IndustryProvider } from './context/IndustryContext';
import { BinningProvider } from './context/BinningContext';
import { DataLimitsProvider } from './context/DataLimitsContext';
import { TooltipSettingsProvider } from './context/TooltipSettingsContext';
import { TimezoneProvider } from './context/TimezoneContext';
import { TagDisplayProvider } from './context/TagDisplayContext';
import { TagSelectionLimitProvider } from './context/TagSelectionLimitContext';
import { CaptureContextProvider, useCaptureContextReader } from './context/CaptureContext';
import { ExplanationsProvider } from './context/ExplanationsContext';
import {
  ActiveInvestigationProvider,
  useActiveInvestigation,
} from './context/ActiveInvestigationContext';
import { SelectionProvider } from './context/SelectionContext';
import { CatalogProvider, useCatalog } from './context/CatalogContext';
import { AppSettingsButton } from './components/AppSettingsButton';
import { UserMenuButton } from './components/UserMenuButton';
import { getFabricAccountEmail } from './lib/rayfinClient';
import { ProfileSelector } from './components/ProfileSelector';import { ExplorePage } from './pages/ExplorePage';
import { LiveViewPage } from './pages/LiveViewPage';
import { SimilarityPage } from './pages/SimilarityPage';
import { ForecastPage } from './pages/ForecastPage';
import { MonitorPage } from './pages/MonitorPage';
import { ControlChartPage } from './pages/ControlChartPage';
import { RegressionPage } from './pages/RegressionPage';
import { RootCausePage } from './pages/RootCausePage';
import { DecompositionPage } from './pages/DecompositionPage';
import { ChangePointsPage } from './pages/ChangePointsPage';
import { SpectrumPage } from './pages/SpectrumPage';
import { ProcessMiningPage } from './pages/ProcessMiningPage';
import { ScenarioPage } from './pages/ScenarioPage';
import { SignalValidationPage } from './pages/SignalValidationPage';
import { CausalityPage } from './pages/CausalityPage';
import { SignalMetadataPage } from './pages/SignalMetadataPage';
import { DiscoverPage, ClassifiersPage } from './pages/DiscoverPage';
import { ComparePage } from './pages/ComparePage';
import { CalendarPage } from './pages/CalendarPage';
import { TrendVolatilityPage } from './pages/TrendVolatilityPage';
import { SegmentationPage } from './pages/SegmentationPage';
import { DerivedPage } from './pages/DerivedPage';
import { SonifyPage } from './pages/SonifyPage';
import { ConfigPage } from './pages/ConfigPage';
import { MatrixProfilePage } from './pages/MatrixProfilePage';
import { AlertCenterPage } from './pages/AlertCenterPage';
import { ActivatorAlertsPage } from './pages/ActivatorAlertsPage';
import { PlaybooksPage } from './pages/PlaybooksPage';
import { InvestigationsPage } from './pages/InvestigationsPage';
import { AddToInvestigationButton } from './components/AddToInvestigationButton';
import { OperationsAdvisorButton } from './components/OperationsAdvisorButton';
import { OperationsAdvisorPanel } from './components/OperationsAdvisorPanel';
import { ViewContextButton } from './components/ViewContextButton';
import { visiblePages, resolveNav, PAGE_LABELS, type NavPreset } from './lib/personas';
import type { Playbook } from './lib/playbooks';
import { buildPlaybookGuidancePrompt } from './lib/agent/playbookPrompt';
import { env, operationsAdvisorConfigReady } from './lib/env';
import { setNavigator, setScreenCapture } from './lib/agent/uiControl';
import {
  setEvidenceCapture,
  setActiveInvestigationAccessor,
} from './lib/agent/evidenceBridge';
import { captureCurrentPageEvidence } from './lib/evidenceCapture';
import { capturePageMarkdown } from './lib/pageCapture';
import { listTags, type TagInfo } from './lib/tags';
import { getEffectiveSignalMetadata, applySignalMetadataToTags, metadataOverlayWarning } from './lib/signalMetadata';
import { useAsyncAction } from './hooks/useAsync';
import { useTerminology } from './hooks/useTerminology';
import type { AgentTerminology } from './lib/agent/types';
import type { SimilarityQuerySeed } from './lib/appTypes';
import { profileToKqlOpts, deleteProfile, markProfileUsed } from './lib/connectionProfile';
import type { ConnectionProfile } from './lib/connectionProfile';
import type { PageKey } from './lib/pages';

const useStyles = makeStyles({
  centered: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalL,
    paddingTop: tokens.spacingVerticalXXXL,
  },
  headerRight: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', gap: tokens.spacingHorizontalM },
  profileBadge: {
    cursor: 'pointer',
    height: 'auto',
    minHeight: '20px',
    maxWidth: '240px',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    textAlign: 'center',
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
});

/** True when the Eventhouse read path (MSAL + cluster) is fully configured. */
function eventhouseConfigReady(): boolean {
  return Boolean(
    env.msalClientId && env.msalTenantId && env.eventhouseQueryUri && env.eventhouseDb,
  );
}

function Shell() {
  const styles = useStyles();
  const { status, signIn, signOut } = useAuth();
  const {
    activeProfile,
    profiles,
    isLoading: profilesLoading,
    error: profilesError,
    setActiveProfile,
    refreshProfiles,
    clearActiveProfile,
  } = useProfile();
  const { active: activeInvestigation, setActive: setActiveInvestigation } =
    useActiveInvestigation();

  const [page, setPage] = useState<PageKey>('explore');
  const [navPreset, setNavPreset] = useState<NavPreset | undefined>();
  const [loadedTags, setLoadedTags] = useState<TagInfo[]>([]);

  const {
    seedTags: seedCatalog,
    resolvedTags,
    mode,
    probeSettled,
    metadataWarning: catalogMetadataWarning,
    clearMetadataWarning: clearCatalogMetadataWarning,
  } = useCatalog();

  // Effective tag catalog handed to pages. Small mode uses the full in-memory
  // load; large mode uses only the bounded resolved-selection subset from
  // CatalogContext, so the full array is never materialized for very large
  // catalogs. Declared early because several memos below scan `tags`.
  const resolvedList = useMemo(() => Array.from(resolvedTags.values()), [resolvedTags]);
  const tags = mode === 'large' ? resolvedList : loadedTags;
  const [seed, setSeed] = useState<SimilarityQuerySeed | null>(null);
  const [showProfileSelector, setShowProfileSelector] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [activePlaybookPrompt, setActivePlaybookPrompt] = useState<string | null>(null);
  const [metadataWarning, setMetadataWarning] = useState<string | null>(null);
  const [operationsAdvisorOpen, setOperationsAdvisorOpen] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  const readCaptureContext = useCaptureContextReader();

  const pages = visiblePages();
  const navGroups = resolveNav();

  const kqlOpts = useMemo(
    () => (activeProfile ? profileToKqlOpts(activeProfile) : undefined),
    [activeProfile],
  );

  // Domain terminology for the Operations Advisor. Level labels are trimmed to
  // the levels actually populated in the loaded catalog so the agent isn't told
  // about empty hierarchy levels; falls back to the full set before tags load.
  const terminology = useTerminology();
  const agentTerminology = useMemo<AgentTerminology | undefined>(() => {
    if (!activeProfile) return undefined;
    const levelKeys = [
      'level1', 'level2', 'level3', 'level4', 'level5',
      'level6', 'level7', 'level8', 'level9', 'level10',
    ] as const;
    const presentLabels = levelKeys
      .map((k, i) => ({
        label: terminology.levelLabels[i],
        present: tags.some((t) => {
          const v = (t as unknown as Record<string, unknown>)[k];
          return typeof v === 'string' && v.trim().length > 0;
        }),
      }))
      .filter((x) => x.present && x.label)
      .map((x) => x.label);
    return {
      entityLabel: terminology.entityLabel,
      metricIdLabel: terminology.metricIdLabel,
      unitOfMeasureLabel: terminology.unitOfMeasureLabel,
      samplingFrequencyLabel: terminology.samplingFrequencyLabel,
      levelLabels: presentLabels.length ? presentLabels : terminology.levelLabels,
    };
  }, [activeProfile, terminology, tags]);

  const handleNavSelect = useCallback((target: PageKey, preset?: NavPreset) => {
    setPage(target);
    setNavPreset(preset);
  }, []);

  // Register the navigator so the agent's `navigate_to_page` tool can switch
  // pages. We keep the handle pointed at fresh values via the dependency list.
  useEffect(() => {
    setNavigator({
      navigate: (target) => {
        if (!pages.includes(target)) return false;
        handleNavSelect(target);
        return true;
      },
      pages: () => pages.map((key) => ({ key, label: PAGE_LABELS[key] })),
      current: () => page,
    });
    return () => setNavigator(null);
  }, [pages, page, handleNavSelect]);

  // Register the screen-capture provider so the agent's `read_current_results`
  // tool can read back what is currently rendered (reusing the existing
  // page-capture + capture-context seams). Wraps only the page content root.
  useEffect(() => {
    setScreenCapture(() => {
      const root = captureRef.current;
      if (!root) return null;
      const pageName = PAGE_LABELS[page];
      return {
        pageName,
        markdown: capturePageMarkdown(root, pageName, readCaptureContext()),
      };
    });
    return () => setScreenCapture(null);
  }, [page, readCaptureContext]);

  // Register the evidence-capture + active-investigation bridge so the agent's
  // capture_evidence / list_investigations / set_active_investigation tools can
  // snapshot the current page and manage the capture target from OUTSIDE React,
  // reusing the exact same capture path as the manual "Add to investigation".
  useEffect(() => {
    setEvidenceCapture(async ({ investigationId, annotation }) => {
      const root = captureRef.current;
      if (!root) {
        return { ok: false, error: 'Could not find the page content to capture.' };
      }
      const pageName = PAGE_LABELS[page];
      try {
        const { evidence, chartCount } =
          await captureCurrentPageEvidence({
            root,
            pageKey: page,
            pageName,
            captureContext: readCaptureContext(),
            investigationId,
            annotation,
          });
        return {
          ok: true,
          evidenceId: evidence.id,
          pageName,
          chartCount,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
    return () => setEvidenceCapture(null);
  }, [page, readCaptureContext]);

  // Publish the active-investigation preference to the same bridge so tools can
  // read the current capture target and activate a different investigation. A
  // ref mirrors the value so a `set` performed mid-turn (e.g. create_investigation
  // followed by capture_evidence) is observed immediately, without waiting for the
  // React state update to re-render.
  const activeInvestigationRef = useRef(activeInvestigation);
  activeInvestigationRef.current = activeInvestigation;
  useEffect(() => {
    setActiveInvestigationAccessor({
      get: () => activeInvestigationRef.current,
      set: (ref) => {
        activeInvestigationRef.current = ref;
        setActiveInvestigation(ref);
      },
    });
    return () => setActiveInvestigationAccessor(null);
  }, [setActiveInvestigation]);

  const [tagsState, loadTags] = useAsyncAction(listTags);

  // Reload the tag catalog when the user signs in or switches profiles. The
  // trigger is intentionally the profile *id* (not object identity) so a
  // refreshProfiles() that replaces the active profile with an equal object does
  // not re-fetch; the latest profile/kqlOpts are read from refs so the effect
  // stays honest about its dependencies (no exhaustive-deps suppression).
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;
  const kqlOptsRef = useRef(kqlOpts);
  kqlOptsRef.current = kqlOpts;
  const profileId = activeProfile?.id;

  useEffect(() => {
    if (status !== 'signed-in' || !profileId) return;
    // Wait for the one-time size probe to decide the data-access mode before
    // committing to a load strategy; otherwise we would eagerly full-load during
    // the brief window where `mode` still reads its 'small' default.
    if (!probeSettled) return;
    // Large catalogs never full-load: `tags` is sourced from the resolved-selection
    // cache instead (see the `tags` derivation below). This is the memory win.
    if (mode === 'large') return;
    const profile = activeProfileRef.current;
    if (!profile) return;
    loadTags(profile, kqlOptsRef.current)
      .then(async (loaded) => {
        // Overlay governed signal metadata from RayFin so limits are visible
        // immediately across every page and the agent, independent of the
        // OneLake-mirror latency in the KQL catalog path.
        try {
          const meta = await getEffectiveSignalMetadata(profileId);
          setLoadedTags(applySignalMetadataToTags(loaded, meta));
          setMetadataWarning(null);
        } catch (e) {
          // Degrade visibly: keep the raw catalog so the app still works, but
          // surface a non-blocking warning so operators know the displayed
          // limits may be incomplete or stale rather than silently trusting them.
          setLoadedTags(loaded);
          setMetadataWarning(metadataOverlayWarning(e));
        }
      })
      .catch(() => undefined);
  }, [status, profileId, probeSettled, mode, loadTags]);

  // Seed the catalog resolution cache with whatever the full-array load produced,
  // so selected-id labels resolve immediately in small mode. Skipped in large mode,
  // where `tags` *is* the cache (seeding it from itself would be redundant and
  // could feed back into the derivation above).
  useEffect(() => {
    if (mode === 'large') return;
    if (tags.length > 0) seedCatalog(tags);
  }, [mode, tags, seedCatalog]);

  // An active profile is mandatory: whenever the user is signed in and no
  // profile is selected, force the blocking selector so they must pick one. The
  // selector stays open while the list is still loading (or retrying) and when
  // the load failed — in those cases it shows a spinner or an error+retry state
  // rather than the misleading "no connections configured" empty state. It must
  // never fall through to the app with no active profile.
  useEffect(() => {
    if (status === 'signed-in' && !activeProfile) {
      setShowProfileSelector(true);
    } else {
      setShowProfileSelector(false);
    }
  }, [status, activeProfile]);

  const handleUseAsQuery = useCallback((s: SimilarityQuerySeed) => {
    setSeed(s);
    setPage('similarity');
  }, []);

  // Keep the current page valid for the navigation. If the current page is not
  // in the visible set (e.g. after signing in), fall back to the first tab.
  useEffect(() => {
    if (status === 'signed-in' && !pages.includes(page)) {
      setPage(pages[0]);
    }
  }, [pages, page, status]);

  // Start a playbook: hand it off to the Operations Advisor. We build a
  // self-contained guidance prompt from the playbook, open the advisor panel,
  // and queue the prompt — the panel enables app control and submits it so the
  // advisor guides the user (and drives the app) through the analysis.
  const startPlaybook = useCallback((playbook: Playbook) => {
    setActivePlaybookPrompt(buildPlaybookGuidancePrompt(playbook));
    setOperationsAdvisorOpen(true);
  }, []);

  const handleSelectProfile = useCallback(
    async (profile: ConnectionProfile) => {
      setActiveProfile(profile);
      setShowProfileSelector(false);
      markProfileUsed(profile.id).catch(() => undefined);
    },
    [setActiveProfile],
  );

  const handleDeleteProfile = useCallback(
    async (id: string) => {
      await deleteProfile(id);
      await refreshProfiles();
      if (activeProfile?.id === id) clearActiveProfile();
    },
    [activeProfile, clearActiveProfile, refreshProfiles],
  );

  const handleProfileSaved = useCallback(
    async (saved: ConnectionProfile) => {
      await refreshProfiles();
      setActiveProfile(saved);
      setShowConfig(false);
      setEditingProfile(null);
      setPage('explore');
    },
    [refreshProfiles, setActiveProfile],
  );

  // Baseline build/auth config check (MSAL + Eventhouse env). The stronger
  // "a Connection Profile is mandatory" rule is enforced separately by the
  // blocking profile selector (shown whenever signed-in with no active
  // profile), so analysis pages never render without a profile.
  const configReady = eventhouseConfigReady();

  const headerRight =
    status === 'signed-in' ? (
      <div className={styles.headerRight}>
        {configReady && page !== 'investigations' && page !== 'config' && (
          <AddToInvestigationButton
            pageKey={page}
            pageName={PAGE_LABELS[page]}
            getCaptureRoot={() => captureRef.current}
          />
        )}
        {configReady && (
          <OperationsAdvisorButton
            open={operationsAdvisorOpen}
            onToggle={() => setOperationsAdvisorOpen((o) => !o)}
          />
        )}
        {activeProfile && (
          <Badge
            appearance="tint"
            color="brand"
            className={styles.profileBadge}
            onClick={() => setShowProfileSelector(true)}
            title="Change connection"
          >
            {activeProfile.name}
          </Badge>
        )}
        <ViewContextButton />
        <AppSettingsButton onOpenConnections={() => setShowProfileSelector(true)} />
        <UserMenuButton email={getFabricAccountEmail()} onSignOut={() => signOut()} />
      </div>
    ) : null;

  // The Operations Advisor panel docks beside the page content (via AppShell's `aside`),
  // so opening it resizes the page rather than overlaying it, and the page stays
  // interactive. Rendered only when configured and signed-in.
  const operationsAdvisorPanel =
    configReady && operationsAdvisorConfigReady() && status === 'signed-in' ? (
      <OperationsAdvisorPanel
        open={operationsAdvisorOpen}
        onClose={() => setOperationsAdvisorOpen(false)}
        kqlOpts={kqlOpts}
        timeseriesRef={activeProfile?.timeseriesQuery}
        tags={tags}
        investigationId={activeInvestigation?.id}
        profileId={activeProfile?.id}
        profileName={activeProfile?.name}
        profileScope={
          activeProfile ? `${activeProfile.databaseName} @ ${activeProfile.eventhouseQueryUri}` : undefined
        }
        profileDescription={activeProfile?.description}
        terminology={agentTerminology}
        pageName={PAGE_LABELS[page]}
        getCaptureRoot={() => captureRef.current}
        pendingPrompt={activePlaybookPrompt}
        onPromptConsumed={() => setActivePlaybookPrompt(null)}
      />
    ) : null;

  // Show profile selector modal
  if (showProfileSelector && status === 'signed-in') {
    return (
      <AppShell right={headerRight}>
        <ProfileSelector
          profiles={profiles}
          isLoading={profilesLoading}
          error={profilesError}
          onRetry={() => { refreshProfiles().catch(() => undefined); }}
          onSelect={handleSelectProfile}
          onEdit={(p) => { setEditingProfile(p); setShowConfig(true); setShowProfileSelector(false); }}
          onCreate={() => { setEditingProfile(null); setShowConfig(true); setShowProfileSelector(false); }}
          onDelete={handleDeleteProfile}
        />
      </AppShell>
    );
  }

  // Show config page (when navigated from profile selector/edit, not tab click)
  if (showConfig) {
    return (
      <AppShell right={headerRight}>
        <ConfigPage
          profile={editingProfile}
          onSaved={handleProfileSaved}
          onCancel={() => { setShowConfig(false); setEditingProfile(null); setPage('explore'); }}
        />
      </AppShell>
    );
  }

  return (
    <AppShell right={headerRight} aside={operationsAdvisorPanel}>
      {!configReady ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Configuration incomplete.</MessageBarTitle>
            Set <code>VITE_MSAL_CLIENT_ID</code> (and the other Eventhouse values) in{' '}
            <code>.env.local</code>, or create a Connection Profile after signing in. The MSAL
            client id requires an Entra SPA app registration with delegated permission to the
            Kusto cluster.
          </MessageBarBody>
        </MessageBar>
      ) : status === 'loading' ? (
        <div className={styles.centered}>
          <Spinner label="Checking session…" />
        </div>
      ) : status === 'signed-out' ? (
        <div className={styles.centered}>
          <Text size={500}>Sign in to query the Eventhouse.</Text>
          <Button appearance="primary" onClick={() => signIn()}>
            Sign in
          </Button>
        </div>
      ) : (
        <>
          <AppNav groups={navGroups} current={page} currentPreset={navPreset} onSelect={handleNavSelect} />

          {tagsState.error && (
            <ErrorMessageBar error={tagsState.error} prefix="Failed to load tags: " />
          )}

          {(metadataWarning ?? catalogMetadataWarning) && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Governed metadata unavailable</MessageBarTitle>
                {metadataWarning ?? catalogMetadataWarning}
              </MessageBarBody>
              <Button
                appearance="transparent"
                size="small"
                onClick={() => {
                  setMetadataWarning(null);
                  clearCatalogMetadataWarning();
                }}
              >
                Dismiss
              </Button>
            </MessageBar>
          )}

          <div ref={captureRef}>
          <PageErrorBoundary resetKey={`${page}::${activeProfile?.id ?? ''}`}>
          {page === 'playbooks' ? (
            <PlaybooksPage onStart={startPlaybook} />
          ) : page === 'explore' ? (
            <ExplorePage tags={tags} onUseAsQuery={handleUseAsQuery} />
          ) : page === 'liveview' ? (
            <LiveViewPage tags={tags} />
          ) : page === 'similarity' ? (
            <SimilarityPage tags={tags} seed={seed} />
          ) : page === 'forecast' ? (
            <ForecastPage tags={tags} />
          ) : page === 'monitor' ? (
            <MonitorPage tags={tags} />
          ) : page === 'controlchart' ? (
            <ControlChartPage tags={tags} />
          ) : page === 'activatorAlerts' ? (
            <ActivatorAlertsPage onNavigate={handleNavSelect} />
          ) : page === 'alerts' ? (
            <AlertCenterPage />
          ) : page === 'regression' ? (
            <RegressionPage tags={tags} />
          ) : page === 'rootcause' ? (
            <RootCausePage tags={tags} />
          ) : page === 'decompose' ? (
            <DecompositionPage tags={tags} />
          ) : page === 'changepoints' ? (
            <ChangePointsPage tags={tags} />
          ) : page === 'spectrum' ? (
            <SpectrumPage tags={tags} />
          ) : page === 'processmining' ? (
            <ProcessMiningPage tags={tags} />
          ) : page === 'scenario' ? (
            <ScenarioPage tags={tags} />
          ) : page === 'validation' ? (
            <SignalValidationPage tags={tags} />
          ) : page === 'causality' ? (
            <CausalityPage tags={tags} />
          ) : page === 'metadata' ? (
            <SignalMetadataPage tags={tags} />
          ) : page === 'discover' ? (
            <DiscoverPage tags={tags} />
          ) : page === 'classifiers' ? (
            <ClassifiersPage tags={tags} />
          ) : page === 'patterns' ? (
            <MatrixProfilePage
              tags={tags}
              kqlOpts={kqlOpts}
              initialRecipeId={navPreset?.recipeId}
              initialTab={navPreset?.patternsTab}
              onUseAsQuery={handleUseAsQuery}
            />
          ) : page === 'compare' ? (
            <ComparePage tags={tags} />
          ) : page === 'calendar' ? (
            <CalendarPage tags={tags} />
          ) : page === 'trendvolatility' ? (
            <TrendVolatilityPage tags={tags} />
          ) : page === 'segmentation' ? (
            <SegmentationPage tags={tags} />
          ) : page === 'sonify' ? (
            <SonifyPage tags={tags} />
          ) : page === 'investigations' ? (
            <InvestigationsPage />
          ) : page === 'config' ? (
            <ConfigPage
              profile={activeProfile}
              onSaved={handleProfileSaved}
              onCancel={() => setPage('explore')}
            />
          ) : (
            <DerivedPage tags={tags} />
          )}
          </PageErrorBoundary>
          </div>
        </>
      )}
    </AppShell>
  );
}

export function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <AuthProvider>
        <ProfileProvider>
          <IndustryProvider>
            <DataLimitsProvider>
            <BinningProvider>
              <TooltipSettingsProvider>
                <TimezoneProvider>
                <TagDisplayProvider>
                  <TagSelectionLimitProvider>
                  <CaptureContextProvider>
                    <ExplanationsProvider>
                      <ActiveInvestigationProvider>
                        <SelectionProvider>
                          <CatalogProvider>
                            <Shell />
                          </CatalogProvider>
                        </SelectionProvider>
                      </ActiveInvestigationProvider>
                    </ExplanationsProvider>
                  </CaptureContextProvider>
                  </TagSelectionLimitProvider>
                </TagDisplayProvider>
                </TimezoneProvider>
              </TooltipSettingsProvider>
            </BinningProvider>
            </DataLimitsProvider>
          </IndustryProvider>
        </ProfileProvider>
      </AuthProvider>
    </FluentProvider>
  );
}