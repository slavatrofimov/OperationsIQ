/**
 * UI-control tools — the agent's ability to DRIVE the app, not just query it.
 *
 * These tools operate the live UI through the `uiControl` bus: navigate between
 * pages, read/set the active page's inputs, and run its analysis so the user
 * watches every step. Results are read back from the same screen-capture seam
 * the "Explain this screen" button uses.
 *
 * SAFETY: describe/read are read-only. navigate/set/run are `readOnly:false` with
 * `sideEffect:'appControl'`, so `policy.checkToolPolicy` refuses them unless the
 * user turned on "Allow app control" (which sets `ToolContext.allowAppControl`).
 * That grant unlocks only this family — it does not permit persistence writes.
 */
import type { AgentTool, AnyAgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { abortableDelay } from '../retry';
import {
  captureScreen,
  getActiveController,
  getNavigator,
  type ParamField,
  type PageControllerHandle,
} from '../uiControl';
import type { PageKey } from '../../pages';

/** Trim captured screen text so a result stays small (agent-tool-design.md). */
const MAX_SCREEN_CHARS = 4000;

function truncate(text: string, max = MAX_SCREEN_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** Serialize a field for the model: name/label/type/current + constraints. */
function describeField(f: ParamField) {
  return {
    name: f.name,
    label: f.label,
    type: f.type,
    current: f.current,
    ...(f.enumValues ? { allowed: f.enumValues.map((e) => e.value) } : {}),
    ...(f.min != null ? { min: f.min } : {}),
    ...(f.max != null ? { max: f.max } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.description ? { description: f.description } : {}),
  };
}

function pageStateData(ctrl: PageControllerHandle) {
  const snap = ctrl.getRunSnapshot();
  return {
    page: ctrl.pageKey,
    title: ctrl.title,
    canRun: ctrl.canRun(),
    run: { phase: snap.phase, hasResult: snap.hasResult, ...(snap.message ? { error: snap.message } : {}) },
    fields: ctrl.getFields().map(describeField),
  };
}

function availablePages(): { key: PageKey; label: string }[] {
  return getNavigator()?.pages() ?? [];
}

// ---------------------------------------------------------------------------
// describe_current_page (read-only)
// ---------------------------------------------------------------------------

export const describeCurrentPageTool: AgentTool<Record<string, never>> = {
  name: 'describe_current_page',
  readOnly: true,
  description:
    'Inspect the page the user is currently looking at: its controllable input ' +
    'parameters (with current values, allowed values, and ranges), whether it can ' +
    'run, and whether a result is shown. Also lists the pages you can navigate to. ' +
    'Call this before set_page_params or run_current_page so you use valid field ' +
    'names and values.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(): Promise<ToolResult> {
    const ctrl = getActiveController();
    const pages = availablePages();
    if (!ctrl) {
      return {
        ok: true,
        summary:
          'The current page does not expose controllable parameters. ' +
          (pages.length ? `You can navigate to: ${pages.map((p) => p.label).join(', ')}.` : ''),
        data: { page: getNavigator()?.current(), controllable: false, availablePages: pages },
      };
    }
    const data = pageStateData(ctrl);
    return {
      ok: true,
      summary:
        `On the ${data.title} page. ${data.fields.length} input(s); ` +
        `${data.canRun ? 'ready to run' : 'not ready to run'}; ` +
        `${data.run.hasResult ? 'a result is shown' : 'no result yet'}.`,
      data: { ...data, controllable: true, availablePages: pages },
    };
  },
};

// ---------------------------------------------------------------------------
// read_current_results (read-only) — reuses the screen-capture seam
// ---------------------------------------------------------------------------

export const readCurrentResultsTool: AgentTool<Record<string, never>> = {
  name: 'read_current_results',
  readOnly: true,
  description:
    'Read what is currently rendered on the page (the analysis parameters and ' +
    'results as text) so you can interpret it for the user. Use this after ' +
    'run_current_page, or whenever you need to reason about what the user is ' +
    'seeing. Returns a text snapshot of the page content.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(): Promise<ToolResult> {
    const ctrl = getActiveController();
    const snap = ctrl?.getRunSnapshot();
    const screen = captureScreen();
    if (!screen || !screen.markdown.trim()) {
      return {
        ok: true,
        summary:
          snap && !snap.hasResult
            ? 'No result is rendered yet — set parameters and run the page first.'
            : 'Could not read the current screen content.',
        data: { hasResult: snap?.hasResult ?? false, phase: snap?.phase },
      };
    }
    return {
      ok: true,
      summary: `Read the ${screen.pageName ?? 'current'} screen (${snap?.phase ?? 'unknown'} state).`,
      data: {
        pageName: screen.pageName,
        phase: snap?.phase,
        hasResult: snap?.hasResult ?? false,
        content: truncate(screen.markdown),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// navigate_to_page (side-effecting)
// ---------------------------------------------------------------------------

export interface NavigateArgs {
  page: string;
}

export const navigateToPageTool: AgentTool<NavigateArgs> = {
  name: 'navigate_to_page',
  readOnly: false,
  sideEffect: 'appControl',
  description:
    'Open one of the app pages so the user sees it. Use the page key from ' +
    'describe_current_page\'s availablePages (e.g. "forecast", "monitor", ' +
    '"decompose"). After navigating, call describe_current_page to read the new ' +
    'page\'s inputs.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'string', description: 'Page key to open (see availablePages).' },
    },
    required: ['page'],
    additionalProperties: false,
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const nav = getNavigator();
    if (!nav) return toolError('unavailable', 'Navigation is not available right now.');
    const pages = nav.pages();
    const target = String(args.page ?? '').trim() as PageKey;
    const match = pages.find((p) => p.key === target);
    if (!match) {
      return toolError(
        'bad_args',
        `Unknown page "${args.page}". Valid pages: ${pages.map((p) => p.key).join(', ')}.`,
      );
    }
    if (nav.current() === target) {
      const ctrl = getActiveController();
      return {
        ok: true,
        summary: `Already on the ${match.label} page.`,
        data: ctrl ? pageStateData(ctrl) : { page: target },
      };
    }
    const ok = nav.navigate(target);
    if (!ok) return toolError('nav_failed', `Could not open the ${match.label} page.`);

    // The destination page's controller registers on mount (next React commit).
    // Poll briefly so we can return its inputs in the same turn.
    for (let i = 0; i < 20; i++) {
      const ctrl = getActiveController();
      if (ctrl && ctrl.pageKey === target) {
        return {
          ok: true,
          summary: `Opened the ${match.label} page.`,
          data: pageStateData(ctrl),
        };
      }
      try {
        await abortableDelay(100, ctx.signal);
      } catch {
        break; // aborted
      }
    }
    return {
      ok: true,
      summary: `Opened the ${match.label} page.`,
      data: { page: target, note: 'This page has no controllable parameters.' },
    };
  },
};

// ---------------------------------------------------------------------------
// set_page_params (side-effecting)
// ---------------------------------------------------------------------------

export interface SetParamsArgs {
  params: Record<string, unknown>;
}

export const setPageParamsTool: AgentTool<SetParamsArgs> = {
  name: 'set_page_params',
  readOnly: false,
  sideEffect: 'appControl',
  description:
    'Set one or more input parameters on the current page (the user sees the ' +
    'controls update). Pass an object of fieldName -> value using field names and ' +
    'value formats from describe_current_page. Tag fields take an array of tag ids ' +
    '(resolve_tags first). Date-range fields take { start, end } as ISO 8601. ' +
    'This does NOT run the analysis — call run_current_page after the user confirms.',
  parameters: {
    type: 'object',
    properties: {
      params: {
        type: 'object',
        description: 'Map of field name to new value (see describe_current_page).',
        additionalProperties: true,
      },
    },
    required: ['params'],
    additionalProperties: false,
  },
  async run(args): Promise<ToolResult> {
    const ctrl = getActiveController();
    if (!ctrl) {
      return toolError('unavailable', 'The current page does not expose controllable parameters.');
    }
    const patch = args.params;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return toolError('bad_args', 'params must be an object of fieldName -> value.');
    }
    const result = ctrl.setParams(patch as Record<string, unknown>);
    const fields = ctrl.getFields().map(describeField);
    const summaryParts: string[] = [];
    if (result.applied.length) summaryParts.push(`Set ${result.applied.join(', ')}.`);
    if (result.errors.length) summaryParts.push(`Could not set: ${result.errors.join(' ')}`);
    return {
      ok: result.ok,
      summary: summaryParts.join(' ') || 'No changes applied.',
      data: {
        applied: result.applied,
        errors: result.errors,
        canRun: ctrl.canRun(),
        fields,
      },
      ...(result.ok ? {} : { error: { code: 'partial', message: result.errors.join(' ') } }),
    };
  },
};

// ---------------------------------------------------------------------------
// run_current_page (side-effecting) — triggers + waits for completion
// ---------------------------------------------------------------------------

/** Poll cadence + budget for waiting on a run (kept under TOOL_CALL_TIMEOUT_MS). */
const RUN_POLL_MS = 400;
const RUN_WAIT_BUDGET_MS = 55_000;

export const runCurrentPageTool: AgentTool<Record<string, never>> = {
  name: 'run_current_page',
  readOnly: false,
  sideEffect: 'appControl',
  description:
    'Run the current page\'s analysis with its current parameters and wait for it ' +
    'to finish, then return a snapshot of the result so you can interpret it. Make ' +
    'sure required inputs are set (describe_current_page shows canRun). Typically ' +
    'used after set_page_params and after the user confirms the parameters.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx: ToolContext): Promise<ToolResult> {
    const ctrl = getActiveController();
    if (!ctrl) {
      return toolError('unavailable', 'The current page cannot be run by the assistant.');
    }
    if (!ctrl.canRun()) {
      const missing = ctrl
        .getFields()
        .filter((f) => f.required && isEmpty(f.current))
        .map((f) => f.label);
      return toolError(
        'not_ready',
        missing.length
          ? `The page is not ready to run — set: ${missing.join(', ')}.`
          : 'The page is not ready to run yet.',
      );
    }

    const startGen = ctrl.getRunSnapshot().generation;
    ctrl.run();

    const deadline = Date.now() + RUN_WAIT_BUDGET_MS;
    // Wait until a fresh run completes (generation advances past startGen) or the
    // page settles into a terminal phase after having started.
    let snap = ctrl.getRunSnapshot();
    while (Date.now() < deadline) {
      snap = ctrl.getRunSnapshot();
      if (snap.generation > startGen && snap.phase !== 'running') break;
      try {
        await abortableDelay(RUN_POLL_MS, ctx.signal);
      } catch {
        return toolError('aborted', 'The run was cancelled.');
      }
    }

    if (snap.generation <= startGen && snap.phase === 'running') {
      return {
        ok: true,
        summary: 'The analysis is still running. Read the results shortly with read_current_results.',
        data: { phase: 'running' },
      };
    }
    if (snap.phase === 'error') {
      return toolError('run_failed', snap.message || 'The analysis failed.');
    }

    // Success — read back what is now rendered.
    const screen = captureScreen();
    return {
      ok: true,
      summary: `Ran the ${ctrl.title} analysis. ${screen?.markdown ? 'Results are on screen.' : ''}`.trim(),
      data: {
        phase: snap.phase,
        hasResult: snap.hasResult,
        ...(screen?.markdown ? { content: truncate(screen.markdown) } : {}),
      },
    };
  },
};

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** All UI-control tools, in a natural call order. */
export const uiControlTools: AnyAgentTool[] = [
  describeCurrentPageTool,
  readCurrentResultsTool,
  navigateToPageTool,
  setPageParamsTool,
  runCurrentPageTool,
];
