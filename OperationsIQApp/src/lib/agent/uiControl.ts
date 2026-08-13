/**
 * UI-control bus — the write-seam that lets the Operations Advisor agent
 * DRIVE the app UI (navigate between pages, set a page's input parameters, run
 * its analysis) in addition to the read-only "side tools" that answer questions
 * headlessly.
 *
 * Design mirrors `context/CaptureContext.tsx` (the read seam): the single active
 * page publishes a live controller here; generic agent tools
 * (`tools/uiControlTools.ts`) read/drive it imperatively from
 * `foundryClient.runToolCall`, which executes OUTSIDE React. A module-level
 * singleton (not React context) is deliberate: only one page is mounted at a
 * time, and the tool dispatcher has no React tree to read a context from.
 *
 * SAFETY: navigate/set/run are side-effecting. They are exposed as
 * `readOnly:false` tools and therefore refused by `policy.checkToolPolicy`
 * unless the user has explicitly turned on "let the Operations Advisor control the app"
 * (which sets `ToolContext.allowAppControl`). describe/read are read-only.
 */
import type { PageKey } from '../pages';

/** The kind of a controllable page input, so the agent can supply a valid value. */
export type ParamType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'tags'
  | 'daterange';

/** One controllable input a page exposes to the agent. */
export interface ParamField {
  /** Stable machine name used as the patch key (e.g. "horizon"). */
  name: string;
  /** Human label shown in status/among choices (e.g. "Horizon (bins)"). */
  label: string;
  type: ParamType;
  /** One-line guidance so the model supplies a sensible value. */
  description?: string;
  /** Current value (already in the page's own units). */
  current: unknown;
  /** For `enum`: the allowed values + labels. */
  enumValues?: { value: string | number; label: string }[];
  /** For numeric types: inclusive bounds. */
  min?: number;
  max?: number;
  /** Whether the page needs this before it can run. */
  required?: boolean;
}

/** Outcome of applying a parameter patch. */
export interface SetParamsResult {
  ok: boolean;
  /** Field names that were applied. */
  applied: string[];
  /** Human-readable problems for fields that were rejected. */
  errors: string[];
}

export type RunPhase = 'idle' | 'running' | 'done' | 'error';

/** A snapshot of the active page's run state (polled by run_current_page). */
export interface RunSnapshot {
  phase: RunPhase;
  /** Increments once per COMPLETED run (success or error), so a caller can
   *  detect that a fresh result arrived rather than reading a stale one. */
  generation: number;
  /** Error message when phase === 'error'. */
  message?: string;
  /** Whether a result is currently rendered on the page. */
  hasResult: boolean;
}

/**
 * The live controller a page registers. All methods read/act on the page's
 * CURRENT state (the hook keeps the registered handle pointing at fresh
 * closures every render), so the agent always sees live values.
 */
export interface PageControllerHandle {
  pageKey: PageKey;
  /** Human page name (e.g. "Forecast"). */
  title: string;
  /** Describe the controllable inputs + their current values. */
  getFields(): ParamField[];
  /** Apply a name->value patch to the page's inputs. */
  setParams(patch: Record<string, unknown>): SetParamsResult;
  /** Whether the page currently has everything it needs to run. */
  canRun(): boolean;
  /** Trigger the page's primary analysis (no-op if it cannot run). */
  run(): void;
  /** Current run state. */
  getRunSnapshot(): RunSnapshot;
}

/** Navigator the shell registers so the agent can switch pages. */
export interface NavigatorHandle {
  navigate(page: PageKey): boolean;
  /** Pages currently reachable, with human labels. */
  pages(): { key: PageKey; label: string }[];
  current(): PageKey;
}

/** A structured snapshot of what is currently rendered, for read_current_results. */
export interface ScreenSnapshot {
  pageName?: string;
  markdown: string;
}

// ---------------------------------------------------------------------------
// Registries (module singletons)
// ---------------------------------------------------------------------------

let activeController: PageControllerHandle | null = null;
let navigator: NavigatorHandle | null = null;
let screenCapture: (() => ScreenSnapshot | null) | null = null;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

/** Subscribe to controller/navigator changes (used by the panel to show status). */
export function subscribeUiControl(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Register (or replace) the active page's controller. */
export function setActiveController(handle: PageControllerHandle): void {
  activeController = handle;
  emit();
}

/**
 * Clear the active controller, but only if `handle` is still the current one.
 * This guards against a stale unmount cleanup wiping a controller that a newly
 * mounted page has already registered.
 */
export function clearActiveController(handle: PageControllerHandle): void {
  if (activeController === handle) {
    activeController = null;
    emit();
  }
}

export function getActiveController(): PageControllerHandle | null {
  return activeController;
}

export function setNavigator(handle: NavigatorHandle | null): void {
  navigator = handle;
  emit();
}

export function getNavigator(): NavigatorHandle | null {
  return navigator;
}

export function setScreenCapture(fn: (() => ScreenSnapshot | null) | null): void {
  screenCapture = fn;
}

export function captureScreen(): ScreenSnapshot | null {
  try {
    return screenCapture?.() ?? null;
  } catch {
    return null;
  }
}

/** Test-only: reset all registries. */
export function __resetUiControlForTests(): void {
  activeController = null;
  navigator = null;
  screenCapture = null;
  listeners.clear();
}
