/**
 * Operations Advisor chat panel — a right-side OverlayDrawer that talks to the
 * Foundry agent. This is the baby-step slice: a single conversation thread per
 * open panel, streaming turns through `runAgentTurn`, which executes the app's
 * client-side tools (resolve_tags, forecast) when the agent asks for them.
 *
 * "New session" starts a fresh Foundry thread. The tool context is built from
 * the active Connection Profile + the cached tag catalog, so the agent operates
 * strictly within the user's data scope (RLS honored by executeKql).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  InlineDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  Button,
  Textarea,
  Spinner,
  Text,
  Caption1,
  Badge,
  Switch,
  MessageBar,
  MessageBarBody,
  MessageBarActions,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular,
  Send24Regular,
  Add24Regular,
  Lightbulb24Regular,
  Lightbulb28Regular,
  ArrowClockwise16Regular,
  Info16Regular,
  Info24Regular,
  ArrowMaximize24Regular,
  ArrowMinimize24Regular,
} from '@fluentui/react-icons';
import type { KqlOptions } from '../lib/connectionProfile';
import type { TagInfo } from '../lib/tags';
import type { ToolChart, ToolContext, AgentTerminology } from '../lib/agent/types';
import {
  createConversation,
  runAgentTurn,
  AgentTurnError,
  type TurnAttachments,
  type TurnMode,
} from '../lib/agent/foundryClient';
import { MarkdownView } from './MarkdownView';
import { AdvisorInteraction } from './AdvisorInteraction';
import { subscribeInteraction, type InteractionRequest } from '../lib/agent/interaction';
import { env } from '../lib/env';
import { capturePageMarkdown, capturePageCharts } from '../lib/pageCapture';
import { useCaptureContextReader } from '../context/CaptureContext';
import { looksLikeExplainScreen } from '../lib/agent/explainIntent';
import { getActiveController, getNavigator } from '../lib/agent/uiControl';
import { createCatalogAccess } from '../lib/agent/catalogAccess';
import { useProfile } from '../context/ProfileContext';
import { useCatalogMode } from '../context/CatalogContext';

const useStyles = makeStyles({
  drawer: { maxWidth: '100vw', height: '100%', position: 'relative' },
  body: { display: 'flex', flexDirection: 'column', height: '100%', gap: tokens.spacingVerticalM },
  log: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  msg: {
    padding: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    overflowWrap: 'anywhere',
  },
  user: {
    backgroundColor: tokens.colorBrandBackground2,
    alignSelf: 'flex-end',
    maxWidth: '85%',
    // User text is plain: preserve their line breaks/whitespace verbatim.
    whiteSpace: 'pre-wrap',
  },
  assistant: { backgroundColor: tokens.colorNeutralBackground3, alignSelf: 'flex-start', maxWidth: '95%' },
  status: { color: tokens.colorNeutralForeground3, alignSelf: 'flex-start' },
  composer: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  composerRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  grow: { flex: 1 },
  intro: { color: tokens.colorNeutralForeground3 },
  permissions: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  permRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
  },
  permLabelGroup: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  infoButton: { minWidth: 'auto', color: tokens.colorNeutralForeground3 },
  empty: {
    margin: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    padding: tokens.spacingVerticalXXL,
  },
  // Left-edge drag handle to resize the docked drawer. The Fluent InlineDrawer
  // surface clips its content (`overflow: hidden`), so the handle must sit fully
  // INSIDE the drawer — an overhang (negative margin) would be clipped away,
  // leaving only an un-grabbable sliver. It spans the full height with a
  // comfortable hit-area anchored to the left edge. A thin full-height rule
  // (::after) hugs the edge; a grip pill (child, inherits `color`) sits just
  // inside and signals draggability. Rule + grip brighten on hover and turn
  // brand-accented while dragging. Focusable for keyboard resizing (arrow keys).
  // `color` drives the grip via currentColor so hover/active states are a
  // single-property swap.
  //
  // z-index: Fluent's DrawerBody sibling also resolves to `z-index: 1` (it's
  // `position: relative`, and Fluent applies z-index:1 internally). Two
  // positioned siblings with equal z-index stack in DOM order, and DrawerBody
  // comes AFTER this handle in the JSX — so with a tied z-index, DrawerBody
  // paints on top and swallows every pointer event across the handle's entire
  // hit area, making it completely un-grabbable. Use a higher z-index so this
  // handle reliably wins the stacking order regardless of DrawerBody's value.
  resizer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: '14px',
    cursor: 'col-resize',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    touchAction: 'none',
    color: tokens.colorNeutralStroke1,
    ':hover': {
      color: tokens.colorNeutralStroke1Hover,
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
    '::after': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: '2px',
      backgroundColor: tokens.colorNeutralStroke2,
    },
  },
  resizerActive: {
    color: tokens.colorBrandStroke1,
    '::after': { backgroundColor: tokens.colorBrandStroke1 },
  },
  // The visible "grab me" grip: a rounded pill anchored just inside the left
  // edge (beside the edge rule) so it reads as draggable without being clipped.
  // Inherits the resizer's `color` (via currentColor) so a single hover/active
  // swap recolors it.
  resizerGrip: {
    position: 'relative',
    zIndex: 1,
    marginLeft: '4px',
    width: '4px',
    height: '36px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: 'currentColor',
  },
});

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  charts?: ToolChart[];
}

/**
 * Persist the conversation (thread id + message log) in sessionStorage so a
 * reload keeps the advisor's context. Cleared by "New session".
 *
 * A SINGLE stable key is used: the panel is mounted once (in the header) and
 * holds one global conversation/thread, so per-page keying would only copy that
 * one conversation into every visited page's slot and desync save vs. restore.
 *
 * Only thread id + TEXT turns are stored — chart images and captured-screen
 * content are never persisted (size + sensitivity). Best-effort throughout.
 */
interface PersistedSession {
  threadId: string;
  messages: ChatMessage[];
}

const STORAGE_KEY = 'operationsAdvisor.session';

function loadSession(): PersistedSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (!parsed?.threadId || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveSession(threadId: string | null, messages: ChatMessage[]): void {
  try {
    if (!threadId) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    // Persist the thread id + TEXT turns only. Chart PNG data URLs and
    // captured-screen images are deliberately NEVER written to sessionStorage
    // (both for size — data URLs blow the quota — and sensitivity — captured
    // screen content should not linger in web storage). Best-effort: any
    // failure is swallowed since persistence is a nicety, not a requirement.
    const textOnly = messages.map((m) => ({ role: m.role, text: m.text }));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ threadId, messages: textOnly }));
  } catch {
    /* give up quietly — persistence is a nicety, not a requirement */
  }
}

/**
 * Panel width persistence. The drawer width is user-controlled (drag handle +
 * maximize toggle); the last chosen width is remembered across reloads. Clamped
 * to a sane minimum and the viewport width (full-page) maximum.
 */
const WIDTH_STORAGE_KEY = 'operationsAdvisor.width';
const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 360;
/** Keyboard resize step (px) when the drag handle is focused. */
const WIDTH_STEP = 32;

/** Largest allowed width — the full viewport. Guarded for SSR/non-DOM contexts. */
function maxWidth(): number {
  return typeof window !== 'undefined' ? window.innerWidth : 1920;
}

function clampWidth(px: number): number {
  // The lower bound is normally MIN_WIDTH, but on a viewport narrower than
  // MIN_WIDTH that would force width above the viewport's own max — clamp the
  // floor down to whatever the viewport allows so the two bounds never invert.
  const upper = maxWidth();
  const lower = Math.min(MIN_WIDTH, upper);
  return Math.max(lower, Math.min(px, upper));
}

function loadWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(px)));
  } catch {
    /* give up quietly — persistence is a nicety, not a requirement */
  }
}

/** Turn a raw error message into a concise, human, actionable sentence. */
function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('capacity') && m.includes('paused')) return message; // already friendly + actionable
  if (m.includes('sign in') || m.includes('unauthorized') || m.includes('401') || m.includes('403'))
    return 'Your session needs a refresh — please sign in again, then retry.';
  if (m.includes('429') || m.includes('too many requests'))
    return 'The service is busy right now. Wait a moment, then retry.';
  if (m.includes('timed out') || m.includes('timeout') || m.includes('took too long'))
    return 'That took too long to finish. Try a narrower question, then retry.';
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network'))
    return 'Network hiccup reaching the Operations Advisor. Check your connection, then retry.';
  return message;
}

/**
 * Human-friendly progress labels. With the UI-control tools the agent's actions
 * are semantic, so status reflects what it is actually DOING (opening a page,
 * setting parameters, running an analysis) rather than a generic spinner. For
 * calls that carry arguments we enrich the label from those arguments and the
 * live UI-control bus (page names, field labels).
 */
const TOOL_LABELS: Record<string, string> = {
  resolve_tags: 'Looking up the matching signals…',
  forecast: 'Forecasting the signal…',
  forecast_detail: 'Digging into the forecast details…',
  get_current_time: 'Checking the clock…',
  resolve_time_window: 'Working out the time window…',
  describe_tag: 'Reading the tag metadata…',
  browse_asset_hierarchy: 'Exploring the asset hierarchy…',
  list_events: 'Looking up operational events…',
  get_data_coverage: 'Checking data coverage and freshness…',
  get_screen_context: 'Reading what\'s on your screen…',
  get_active_profile: 'Checking the active data scope…',
  list_capabilities: 'Reviewing its own capabilities…',
  explain_method: 'Consulting the method glossary…',
  list_saved_derived_metrics: 'Recalling saved derived metrics…',
  list_alert_rules: 'Recalling existing alert rules…',
  create_investigation: 'Creating an investigation…',
  add_annotation: 'Adding an annotation…',
  save_derived_metric: 'Saving the derived metric…',
  describe_current_page: 'Reading the current page…',
  read_current_results: 'Reading the results on screen…',
  navigate_to_page: 'Opening the page…',
  set_page_params: 'Setting the parameters…',
  run_current_page: 'Running the analysis…',
};

/** Best-effort parse of a tool's raw JSON argument string. */
function parseArgs(rawArgs?: string): Record<string, unknown> {
  if (!rawArgs || !rawArgs.trim()) return {};
  try {
    const v = JSON.parse(rawArgs);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Map a page key to its human label via the navigator, falling back to the key. */
function pageLabel(key: string): string {
  const match = getNavigator()?.pages().find((p) => p.key === key);
  return match?.label ?? key;
}

/** Map field names to their human labels via the active page controller. */
function fieldLabels(names: string[]): string {
  const fields = getActiveController()?.getFields() ?? [];
  const byName = new Map(fields.map((f) => [f.name, f.label]));
  const labels = names.map((n) => byName.get(n) ?? n);
  return labels.join(', ');
}

function toolLabel(name: string, rawArgs?: string): string {
  const args = parseArgs(rawArgs);
  switch (name) {
    case 'navigate_to_page': {
      const page = typeof args.page === 'string' ? args.page : '';
      return page ? `Opening the ${pageLabel(page)} page…` : 'Opening the page…';
    }
    case 'set_page_params': {
      const params = args.params && typeof args.params === 'object' ? (args.params as object) : {};
      const names = Object.keys(params);
      const ctrl = getActiveController();
      const where = ctrl ? ` on ${ctrl.title}` : '';
      return names.length
        ? `Setting ${fieldLabels(names)}${where}…`
        : `Adjusting the parameters${where}…`;
    }
    case 'run_current_page': {
      const ctrl = getActiveController();
      return ctrl ? `Running the ${ctrl.title} analysis…` : 'Running the analysis…';
    }
    default:
      return TOOL_LABELS[name] ?? `Running ${name.replace(/_/g, ' ')}…`;
  }
}

const STORAGE_KEY_CONTROL = 'operationsAdvisor.control';

/** What the advisor can do, shown behind the header info button. */
const CAPABILITY_BLURB =
  "The Operations Advisor can resolve tags, forecast signals, check data coverage, " +
  "recall past work, and analyze what's on your screen — always within your data " +
  "permissions. Use the toggles to let it drive the app or save findings for you.";

/** Detail behind the "Allow app control" info icon. */
const CONTROL_INFO =
  'Lets the advisor open pages, set parameters, and run analyses for you. It explains ' +
  'each step and asks before running; you can edit any control yourself at any time. ' +
  'Left off, it only answers questions.';

/** Detail behind the "Allow actions on your behalf" info icon. */
const ACTIONS_INFO =
  'Lets the advisor create investigations, annotations, and saved metrics on your ' +
  'behalf. Read-only analysis works either way.';

/** Compact, focusable info icon that reveals a longer description on hover/focus. */
function InfoTip({ content, className }: { content: string; className?: string }) {
  return (
    <Tooltip content={content} relationship="description" withArrow>
      <Button
        appearance="transparent"
        size="small"
        className={className}
        icon={<Info16Regular />}
        aria-label="More information"
      />
    </Tooltip>
  );
}

export interface OperationsAdvisorPanelProps {
  open: boolean;
  onClose: () => void;
  kqlOpts?: KqlOptions;
  timeseriesRef?: string;
  tags: TagInfo[];
  investigationId?: string;
  /** Active Connection Profile id — enables profile-scoped tools (saved metrics). */
  profileId?: string;
  /** Active Connection Profile name — surfaced by get_active_profile. */
  profileName?: string;
  /** One-line description of the active data scope (endpoint/database). */
  profileScope?: string;
  /** User-authored description of what the data represents — surfaced to the agent. */
  profileDescription?: string;
  /** Active profile's domain terminology (hierarchy-level + entity/metric labels). */
  terminology?: AgentTerminology;
  /** Human-friendly name of the current page (stamped on the captured snapshot). */
  pageName?: string;
  /** Returns the DOM element the Operations Advisor should analyze for "Explain this screen". */
  getCaptureRoot?: () => HTMLElement | null;
  /**
   * A prompt to submit automatically once the panel is open and a thread is
   * ready — used by the "Start" hand-off from a playbook. Submitting it
   * also turns on app control so the advisor can drive the app through the
   * analysis. Cleared via {@link onPromptConsumed} after it is sent.
   */
  pendingPrompt?: string | null;
  /** Called once a {@link pendingPrompt} has been submitted, so the owner clears it. */
  onPromptConsumed?: () => void;
}

export function OperationsAdvisorPanel({
  open,
  onClose,
  kqlOpts,
  timeseriesRef,
  tags,
  investigationId,
  profileId,
  profileName,
  profileScope,
  profileDescription,
  terminology,
  pageName,
  getCaptureRoot,
  pendingPrompt,
  onPromptConsumed,
}: OperationsAdvisorPanelProps) {
  const styles = useStyles();
  const readCaptureContext = useCaptureContextReader();
  const { activeProfile } = useProfile();
  const catalogMode = useCatalogMode();

  // For large catalogs, give the agent's catalog tools a server-backed access
  // seam (bound to the active profile + token) instead of the full in-memory
  // `tags` array. Gated to large mode and to a profile that matches the panel's
  // scope; otherwise left undefined so the tools use the in-memory fallback and
  // small-catalog behavior is unchanged. `kqlOpts` is the same endpoint/db the
  // rest of the panel already passes to executeKql.
  const catalogAccess = useMemo(
    () =>
      catalogMode === 'large' && activeProfile && activeProfile.id === profileId
        ? createCatalogAccess(activeProfile, kqlOpts)
        : undefined,
    [catalogMode, activeProfile, profileId, kqlOpts],
  );
  const restored = useRef<PersistedSession | null>(loadSession());
  const [threadId, setThreadId] = useState<string | null>(restored.current?.threadId ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(restored.current?.messages ?? []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A structured question the agent asked via `request_user_choice` (Approve /
  // Cancel or a pick-one list), rendered as clickable buttons below the log.
  // Ephemeral — never persisted; cleared on New session and when a new turn starts.
  const [pending, setPending] = useState<InteractionRequest | null>(null);
  // Opt-in for side-effecting (write) tools. Defaults OFF; the user must tick the
  // box each session before the Operations Advisor may create investigations, annotations,
  // or saved metrics. This is the UI half of the policy.ts gate.
  const [allowWrites, setAllowWrites] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Remembers the last user turn so a failed turn can be re-run via "Retry".
  const lastTurnRef = useRef<{ rawText: string; attachScreen: boolean } | null>(null);

  // Docked-drawer width (px), user-controlled via the left-edge drag handle and
  // the maximize/restore toggle; restored from localStorage and persisted on
  // release. `restoreWidth` remembers the pre-maximize width so restore returns
  // to it; `dragging` toggles the handle's active accent.
  const [width, setWidth] = useState<number>(() => loadWidth());
  const [dragging, setDragging] = useState(false);
  const restoreWidthRef = useRef<number>(width);

  const isMaximized = width >= maxWidth() - 1;

  const commitWidth = useCallback((px: number) => {
    const next = clampWidth(px);
    setWidth(next);
    saveWidth(next);
  }, []);

  // Pointer-based drag: the drawer is docked to the right (position="end"), so a
  // larger width means the left edge moves further left — width tracks the
  // distance from the pointer to the right edge of the viewport.
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setDragging(true);
      const onMove = (ev: PointerEvent) => {
        setWidth(clampWidth(window.innerWidth - ev.clientX));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setDragging(false);
        setWidth((w) => {
          saveWidth(w);
          restoreWidthRef.current = w;
          return w;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [],
  );

  const onResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Right edge is fixed, so ArrowLeft widens, ArrowRight narrows.
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        commitWidth(width + WIDTH_STEP);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        commitWidth(width - WIDTH_STEP);
      }
    },
    [commitWidth, width],
  );

  const toggleMaximize = useCallback(() => {
    if (isMaximized) {
      commitWidth(restoreWidthRef.current || DEFAULT_WIDTH);
    } else {
      restoreWidthRef.current = width;
      commitWidth(maxWidth());
    }
  }, [commitWidth, isMaximized, width]);

  // Keep width within the viewport when the window shrinks below the current
  // width. Route through clampWidth (not a bare Math.min) so the floor is
  // still respected — a bare Math.min(w, innerWidth) could push width below
  // MIN_WIDTH on a narrow viewport, desyncing the drag/keyboard range from
  // aria-valuemin/aria-valuemax.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // "Let the Operations Advisor control the app" — the explicit, user-granted opt-in that
  // enables the side-effecting UI-control tools (navigate / set params / run).
  // Read-only analysis tools work regardless. Persisted for the session so the
  // grant survives a reload. Default OFF (see policy.ts: no silent escalation).
  const [controlEnabled, setControlEnabled] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY_CONTROL) === '1';
    } catch {
      return false;
    }
  });
  const controlRef = useRef(controlEnabled);
  controlRef.current = controlEnabled;
  const setControl = useCallback((on: boolean) => {
    setControlEnabled(on);
    // Update the ref synchronously (not just on the next render) so a caller
    // that enables control and immediately submits a turn in the same tick —
    // e.g. the playbook hand-off below — is honored for that turn.
    controlRef.current = on;
    try {
      sessionStorage.setItem(STORAGE_KEY_CONTROL, on ? '1' : '0');
    } catch {
      /* best-effort */
    }
  }, []);

  const startSession = useCallback(async () => {
    setError(null);
    setStatus('Starting session…');
    setBusy(true);
    try {
      const id = await createConversation(true);
      setThreadId(id);
      setMessages([]);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus(null);
      setBusy(false);
    }
  }, []);

  // Open a thread the first time the panel is shown.
  useEffect(() => {
    if (open && !threadId && !busy) void startSession();
  }, [open, threadId, busy, startSession]);

  // Keep the log scrolled to the newest message.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, status, pending]);

  // Subscribe to structured questions the agent raises via `request_user_choice`.
  // The tool publishes the request (outside React) on the module-level bus; we
  // surface the latest one as clickable controls below the log.
  useEffect(() => subscribeInteraction((req) => setPending(req)), []);

  // Persist the conversation so a reload keeps context (see saveSession).
  useEffect(() => {
    saveSession(threadId, messages);
  }, [threadId, messages]);

  /**
   * Send one turn. When `attachScreen` is true (explicit "Explain this screen"
   * button) or the typed prompt clearly refers to the current view, a snapshot
   * of the screen (page Markdown + chart PNGs) is attached for the Operations Advisor to
   * analyze. Images are only sent when a vision-capable agent is configured
   * (env.operationsAdvisorVision); the Markdown snapshot is always sent.
   */
  const submit = useCallback(
    async (rawText: string, opts?: { attachScreen?: boolean }) => {
      if (!threadId || busy) return;
      const text = rawText.trim();
      // First turn of a fresh conversation → include the one-shot orientation
      // briefing (profile, terminology, hierarchy snapshot). Restored sessions
      // already have messages, so they never re-orient.
      const isFirstTurn = messages.length === 0;
      const attachScreen = opts?.attachScreen ?? looksLikeExplainScreen(text);
      if (!text && !attachScreen) return;
      lastTurnRef.current = { rawText, attachScreen };

      let attachments: TurnAttachments | undefined;
      let attachedCharts: ToolChart[] = [];
      if (attachScreen) {
        const root = getCaptureRoot?.();
        if (root) {
          // Capture reads the live DOM and ECharts instances; a single
          // malformed chart must never take down the whole turn. If capture
          // throws we log and continue with whatever (if anything) we captured,
          // so the question is still sent instead of the button silently failing.
          try {
            const screenMarkdown = capturePageMarkdown(root, pageName, readCaptureContext());
            const charts = capturePageCharts(root);
            const useImages = env.operationsAdvisorVision && charts.length > 0;
            attachments = {
              pageName,
              screenMarkdown,
              images: useImages
                ? charts.map((c) => ({ title: c.title, pngDataUrl: c.pngDataUrl }))
                : [],
            };
            attachedCharts = useImages ? charts : [];
          } catch (e) {
            console.error('Failed to capture the current screen for the advisor', e);
          }
        }
      }

      const shownText =
        text || (attachScreen ? 'Explain what I am looking at on this screen.' : '');

      setInput('');
      setError(null);
      // A new turn supersedes any pending choice buttons from the previous one.
      setPending(null);
      setBusy(true);
      setMessages((m) => [...m, { role: 'user', text: shownText, charts: attachedCharts }]);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const ctx: ToolContext = {
        kqlOpts,
        timeseriesRef,
        tags,
        catalog: catalogAccess,
        investigationId,
        signal: ctrl.signal,
        now: () => new Date(),
        // Ambient screen awareness: the same structured summary the manual
        // "Explain this screen" capture uses, read on demand by get_screen_context.
        screenContext: () => readCaptureContext(),
        profile: { id: profileId, name: profileName, scopeDescription: profileScope, description: profileDescription },
        terminology,
        // Two INDEPENDENT side-effect grants (least privilege): "Allow app control"
        // unlocks the UI-driving tools; "Allow actions" unlocks persistence writes.
        // Each maps only to its own tool family in policy.checkToolPolicy — enabling
        // one no longer leaks into the other. Both honor the capture guard (a
        // prompt-injection boundary: captured content must never trigger a side
        // effect), so neither is set on an "explain this screen" turn. The control
        // grant is read from a ref so it is current for the whole turn.
        allowAppControl: controlRef.current && !attachScreen,
        allowActions: allowWrites && !attachScreen,
      };
      // The same grants, expressed as a per-turn hint for the model. The hosted
      // agent's instructions are static and cannot see the toggles, so this is
      // how the agent learns to (e.g.) default to driving the app when "Allow app
      // control" is on. Mirrors the grants above — both honor the capture boundary
      // (no app-control / write hint on an "explain screen" turn).
      const mode: TurnMode = {
        appControl: controlRef.current && !attachScreen,
        actions: allowWrites && !attachScreen,
      };
      const turnCharts: ToolChart[] = [];

      try {
        const reply = await runAgentTurn(
          threadId,
          text,
          ctx,
          {
            onStatus: (s) => {
              if (s === 'reviewing_chart') {
                setStatus('Studying the chart…');
              } else if (s === 'requires_action') {
                setStatus('Working on it…');
              } else if (s === 'queued') {
                setStatus('Getting ready…');
              } else {
                // in_progress with no active tool: a single, calm label. Specific
                // progress comes from onToolCall (the actions it takes), not from
                // rotating through generic phrases.
                setStatus('Thinking…');
              }
            },
            onToolCall: (name, rawArgs) => {
              setStatus(toolLabel(name, rawArgs));
            },
            onChart: (c) => {
              turnCharts.push(c);
              setStatus('Building the chart…');
            },
          },
          attachments,
          mode,
          { firstTurn: isFirstTurn },
        );
        setMessages((m) => [
          ...m,
          { role: 'assistant', text: reply || '(no response)', charts: turnCharts },
        ]);
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          // User cancelled — not an error worth surfacing.
        } else if (e instanceof AgentTurnError) {
          // The run failed but produced partial text — show it, then explain.
          if (e.partialText) {
            setMessages((m) => [
              ...m,
              { role: 'assistant', text: e.partialText, charts: turnCharts },
            ]);
          }
          setError(friendlyError(e.message));
        } else {
          setError(friendlyError(e instanceof Error ? e.message : String(e)));
        }
      } finally {
        setStatus(null);
        setBusy(false);
        abortRef.current = null;
      }
    },
    [
      threadId,
      busy,
      messages,
      kqlOpts,
      timeseriesRef,
      tags,
      catalogAccess,
      investigationId,
      profileId,
      profileName,
      profileScope,
      profileDescription,
      terminology,
      allowWrites,
      pageName,
      getCaptureRoot,
      readCaptureContext,
    ],
  );

  const send = useCallback(() => void submit(input), [submit, input]);
  const explainScreen = useCallback(() => void submit(input, { attachScreen: true }), [submit, input]);

  // Re-run the last user turn. Strip the trailing FAILED turn first so submit
  // re-adds exactly one question — with no duplicate. A failed turn ends either
  // as [user(Q)] (plain error) or [user(Q), assistant(partial)] (AgentTurnError
  // with partial text), so drop a trailing assistant bubble AND its preceding
  // user question.
  const retry = useCallback(() => {
    const last = lastTurnRef.current;
    if (!last || busy) return;
    setError(null);
    setMessages((m) => {
      let end = m.length;
      if (end && m[end - 1].role === 'assistant') end -= 1; // drop partial reply
      if (end && m[end - 1].role === 'user') end -= 1; // drop the failed question
      return m.slice(0, end);
    });
    void submit(last.rawText, { attachScreen: last.attachScreen });
  }, [submit, busy]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // Playbook hand-off: when the app opens the panel with a pending prompt
  // (from a playbook "Start"), turn on app control so the advisor can drive the
  // analysis, then submit the prompt exactly once. A ref guards against a
  // re-fire during the async gap before the owner clears the prompt.
  const handoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !pendingPrompt || !threadId || busy) return;
    if (handoffRef.current === pendingPrompt) return;
    handoffRef.current = pendingPrompt;
    setControl(true);
    void submit(pendingPrompt);
    onPromptConsumed?.();
  }, [open, pendingPrompt, threadId, busy, setControl, submit, onPromptConsumed]);

  return (
    <InlineDrawer
      className={styles.drawer}
      style={{ width: `${width}px` }}
      position="end"
      separator
      open={open}
    >
      <div
        className={`${styles.resizer} ${dragging ? styles.resizerActive : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={Math.round(Math.min(MIN_WIDTH, maxWidth()))}
        aria-valuemax={Math.round(maxWidth())}
        aria-valuenow={Math.round(width)}
        title="Drag to resize (or use arrow keys)"
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
      >
        <span className={styles.resizerGrip} aria-hidden />
      </div>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <>
              <Tooltip content={CAPABILITY_BLURB} relationship="description" withArrow>
                <Button
                  appearance="subtle"
                  icon={<Info24Regular />}
                  aria-label="About the Operations Advisor"
                />
              </Tooltip>
              <Button
                appearance="subtle"
                icon={isMaximized ? <ArrowMinimize24Regular /> : <ArrowMaximize24Regular />}
                title={isMaximized ? 'Restore panel width' : 'Maximize to full width'}
                aria-label={isMaximized ? 'Restore panel width' : 'Maximize to full width'}
                onClick={toggleMaximize}
              />
              <Button
                appearance="subtle"
                icon={<Add24Regular />}
                title="New session"
                disabled={busy}
                onClick={() => void startSession()}
              />
              <Button
                appearance="subtle"
                icon={<Dismiss24Regular />}
                title="Close"
                onClick={onClose}
              />
            </>
          }
        >
          Operations Advisor
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody className={styles.body}>
        <Caption1 className={styles.intro}>
          Ask about your operational signals, or use “Explain this screen” to analyze the
          current view.
        </Caption1>

        <div className={styles.permissions} role="group" aria-label="Advisor permissions">
          <div className={styles.permRow}>
            <div className={styles.permLabelGroup}>
              <Switch
                checked={controlEnabled}
                disabled={busy}
                onChange={(_, d) => setControl(d.checked)}
                label="Allow app control"
              />
              <InfoTip content={CONTROL_INFO} className={styles.infoButton} />
            </div>
            {controlEnabled && (
              <Badge appearance="tint" color="brand">
                Guiding
              </Badge>
            )}
          </div>
          <div className={styles.permRow}>
            <div className={styles.permLabelGroup}>
              <Switch
                checked={allowWrites}
                disabled={busy}
                onChange={(_, d) => setAllowWrites(!!d.checked)}
                label="Allow actions on your behalf"
              />
              <InfoTip content={ACTIONS_INFO} className={styles.infoButton} />
            </div>
            {allowWrites && (
              <Badge appearance="tint" color="success">
                Enabled
              </Badge>
            )}
          </div>
        </div>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
            {lastTurnRef.current && (
              <MessageBarActions>
                <Button
                  appearance="transparent"
                  icon={<ArrowClockwise16Regular />}
                  disabled={busy || !threadId}
                  onClick={retry}
                >
                  Retry
                </Button>
              </MessageBarActions>
            )}
          </MessageBar>
        )}

        <div
          className={styles.log}
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-atomic="false"
          aria-busy={busy}
        >
          {messages.length === 0 && !status && (
            <div className={styles.empty}>
              <Lightbulb28Regular />
              <Text size={200}>
                Try “Forecast the boiler outlet temperature” or “Explain this screen”.
              </Text>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`${styles.msg} ${m.role === 'user' ? styles.user : styles.assistant}`}
            >
              {m.role === 'assistant' ? (
                <MarkdownView markdown={m.text} />
              ) : (
                <Text>{m.text}</Text>
              )}
              {m.charts?.map((c) => (
                <img
                  key={c.title}
                  src={c.pngDataUrl}
                  alt={c.title}
                  style={{ maxWidth: '100%', borderRadius: 4, marginTop: 8 }}
                />
              ))}
            </div>
          ))}
          {pending && (
            <AdvisorInteraction
              request={pending}
              disabled={busy || !threadId}
              onSelect={(reply) => void submit(reply)}
            />
          )}
          {status && (
            <div className={styles.status}>
              <Spinner size="tiny" label={status} labelPosition="after" />
            </div>
          )}
        </div>

        <div className={styles.composer}>
          {getCaptureRoot && (
            <Tooltip
              content="Capture what's on screen now (charts included) and ask the Operations Advisor to analyze it"
              relationship="label"
              withArrow
            >
              <Button
                appearance="secondary"
                icon={<Lightbulb24Regular />}
                disabled={busy || !threadId}
                onClick={explainScreen}
              >
                Explain this screen
              </Button>
            </Tooltip>
          )}
          <div className={styles.composerRow}>
            <Textarea
              className={styles.grow}
              value={input}
              placeholder={
                controlEnabled
                  ? 'e.g. Guide me through forecasting the boiler outlet temperature'
                  : 'e.g. Forecast the boiler outlet temperature, or ask me to explain this screen'
              }
              onChange={(_, d) => setInput(d.value)}
              onKeyDown={onKeyDown}
              disabled={busy || !threadId}
              resize="vertical"
            />
            <Button
              appearance="primary"
              icon={busy ? <Spinner size="tiny" /> : <Send24Regular />}
              disabled={busy || !threadId || !input.trim()}
              onClick={() => void send()}
            />
          </div>
        </div>
      </DrawerBody>
    </InlineDrawer>
  );
}
