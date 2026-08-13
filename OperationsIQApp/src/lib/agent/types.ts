/**
 * Operations Advisor — agent tool layer core types.
 *
 * A "tool" is a thin adapter that exposes one of the app's existing analysis
 * capabilities to the Foundry agent. Tools run CLIENT-SIDE: the delegated Kusto
 * token, Row-Level Security, the active Connection Profile, and the KQL
 * injection guards all live in the browser, so the agent never touches the
 * Eventhouse directly. Instead the agent emits a tool call, the SPA dispatches
 * it here (with the user's context), and posts the result back.
 *
 * Every adapter composes the same seam used by the pages:
 *   build*Query(opts) -> executeKql(csl, kqlOpts) -> parse*(table) -> analytics
 * so no analysis logic is reinvented — the tool layer is schema + glue.
 */

import type { KqlOptions } from '../connectionProfile';
import type { TagInfo } from '../tags';
import type { CaptureContextSummary } from '../../context/CaptureContext';

/**
 * A thumbnail of the active Connection Profile the agent is scoped to. Lets the
 * `get_active_profile` tool tell the user exactly what data it can and cannot
 * see, and gives profile-scoped persistence tools (saved derived metrics, etc.)
 * the `id` they need. Purely descriptive — it never widens the RLS boundary.
 */
export interface ProfileContextInfo {
  /** Connection Profile row id (for profile-scoped persistence tools). */
  id?: string;
  /** Human-friendly profile name shown to the user. */
  name?: string;
  /** One-line description of the data scope (endpoint/database, etc.). */
  scopeDescription?: string;
  /**
   * Optional user-authored description of what the data represents (site,
   * process, domain). Distinct from `scopeDescription` (which is the technical
   * endpoint/db). Surfaced to the agent for situational awareness.
   */
  description?: string;
}

/**
 * The active profile's domain terminology, flattened for the agent. Lets the
 * Operations Advisor speak the user's language ("Plant" not "level1", "Asset"
 * not "entity") and understand what each hierarchy level means. Derived from the
 * profile's `ProfileLabels`; see `useTerminology`.
 */
export interface AgentTerminology {
  /** Label for an asset/entity (e.g. "Asset", "Patient", "Vehicle"). */
  entityLabel: string;
  /** Label for a signal/metric id (e.g. "Tag", "Sensor", "Signal"). */
  metricIdLabel: string;
  /** Label for the unit of measure column. */
  unitOfMeasureLabel: string;
  /** Label for the sampling-frequency column. */
  samplingFrequencyLabel: string;
  /** Ordered hierarchy-level labels (level1..level10), empty entries omitted. */
  levelLabels: string[];
}

/** The public face of a registered tool, surfaced by `list_capabilities`. */
export interface ToolCapability {
  name: string;
  description: string;
  readOnly: boolean;
}

/** A distinct hierarchy-child / facet value with the number of signals under it. */
export interface CatalogValueCount {
  value: string;
  count: number;
}

/** One page of catalog search results plus an over-fetch `hasMore` flag. */
export interface CatalogSearchPage {
  rows: TagInfo[];
  hasMore: boolean;
}

/**
 * Server-backed catalog access, injected into the ToolContext for LARGE catalogs
 * where the whole signal list no longer fits in memory. It is a narrow subset of
 * `lib/catalog.ts`, already bound to the active Connection Profile and delegated
 * token, so the catalog tools (`resolve_tags`, `describe_tag`,
 * `browse_asset_hierarchy`) can issue small, targeted, cancelable queries instead
 * of scanning `ctx.tags`.
 *
 * Kept as an interface (not a direct import of the service) so the tool layer —
 * and its unit tests — never pull the Eventhouse client into scope. When this is
 * absent the tools fall back to the in-memory `ctx.tags` scan, so small-catalog
 * behavior is unchanged. RLS is preserved: every call runs under the user's
 * delegated token exactly as the in-memory path did.
 */
export interface CatalogAccess {
  /** A page of matching signals (server free-text + scope + facet filters). */
  searchTags(
    params: {
      query?: string;
      scope?: Record<string, string | undefined>;
      facetSelections?: Record<string, string[]>;
      skip?: number;
      take?: number;
    },
    signal?: AbortSignal,
  ): Promise<CatalogSearchPage>;
  /** Full metadata for a bounded set of ids (e.g. resolved selection). */
  getTagsByIds(ids: string[], signal?: AbortSignal): Promise<TagInfo[]>;
  /** Distinct child values (+ counts) at one hierarchy level within a scope. */
  getHierarchyChildren(
    params: { scope?: Record<string, string | undefined>; childKey: string; take?: number },
    signal?: AbortSignal,
  ): Promise<CatalogValueCount[]>;
  /** Count of signals matching a filter (for exact "of N" totals). */
  countTags(
    filter: {
      query?: string;
      scope?: Record<string, string | undefined>;
      facetSelections?: Record<string, string[]>;
    },
    signal?: AbortSignal,
  ): Promise<number>;
}

/**
 * Context every tool receives. Carries the signed-in user's data scope so a
 * tool can never read outside the active Connection Profile / RLS boundary.
 */
export interface ToolContext {
  /** Active Connection Profile endpoint/db — the same object pages pass to executeKql. */
  kqlOpts?: KqlOptions;
  /** Profile's custom `Timeseries` query, if any (see ExploreOptions.timeseriesRef). */
  timeseriesRef?: string;
  /** Cached tag catalog for name<->id resolution (loaded once at app level). */
  tags: TagInfo[];
  /**
   * Server-backed catalog access for LARGE catalogs, injected by the app when the
   * whole signal list no longer fits in memory. When present, the catalog tools
   * (`resolve_tags`, `describe_tag`, `browse_asset_hierarchy`) query the service
   * instead of scanning `tags` (which, in large mode, holds only the resolved
   * selection). Absent → the tools fall back to the in-memory `tags` scan, so
   * small-catalog behavior is unchanged.
   */
  catalog?: CatalogAccess;
  /** Active investigation id, for future evidence/RAG tools. */
  investigationId?: string;
  /**
   * Authoritative current time. Tools that resolve relative windows ("last 7
   * days", "yesterday") MUST read the clock from here rather than calling
   * `Date.now()` directly, so the whole agent shares one notion of "now" (and it
   * can be frozen in tests). The dispatcher supplies a default when absent.
   */
  now?: () => Date;
  /**
   * Reader over the active page's published UI state (selected tags, current
   * time window, key settings) — the same structured summary the "Add to
   * investigation" capture uses. Lets the agent be ambiently aware of what the
   * user is looking at without a manual screen capture. Returns null when the
   * active page publishes nothing.
   */
  screenContext?: () => CaptureContextSummary | null;
  /** Thumbnail of the active Connection Profile / data scope (see above). */
  profile?: ProfileContextInfo;
  /**
   * Active profile's domain terminology (hierarchy-level labels, entity/metric
   * labels). Lets the agent use the user's vocabulary and understand the asset
   * hierarchy. Undefined falls back to generic terms.
   */
  terminology?: AgentTerminology;
  /**
   * Self-description of the registered toolset, injected by the dispatcher so
   * `list_capabilities` can enumerate what the agent can do without importing the
   * registry (which would create a static import cycle). Each entry is the
   * public face of a tool: its name, description, and blast radius.
   */
  capabilities?: ToolCapability[];
  /** Cooperative cancellation for in-flight queries. */
  signal?: AbortSignal;
  /**
   * Opt-in for UI-CONTROL side effects — driving the visible app (navigate to a
   * page, set its parameters, run its analysis). Set only after the user turns on
   * "Allow app control". Unlocks tools whose `sideEffect` is `'appControl'`; it
   * does NOT permit persistence writes. Defaults to undefined/false.
   */
  allowAppControl?: boolean;
  /**
   * Opt-in for ACTION side effects — persisting data on the user's behalf (create
   * investigation, capture evidence, add annotation, save derived metric). Set
   * only after the user turns on "Allow actions on your behalf". Unlocks tools
   * whose `sideEffect` is `'write'`; it does NOT permit driving the UI. Defaults
   * to undefined/false.
   *
   * These two grants are enforced INDEPENDENTLY by `policy.checkToolPolicy`, so
   * each toggle unlocks only its own family of tools (least privilege). Neither is
   * ever set on a captured-screen turn (prompt-injection boundary).
   */
  allowActions?: boolean;
}

/** An optional chart a tool can surface (PNG for shape, CSV for exact numbers). */
export interface ToolChart {
  title: string;
  /** data:image/png;base64,... */
  pngDataUrl: string;
  /** CSV of the plotted data (may be empty). */
  csv: string;
}

/**
 * Uniform tool result. Adapters RETURN errors as `ok:false` (never throw) so the
 * agent can read the failure and recover or ask the user for missing input.
 */
export interface ToolResult {
  ok: boolean;
  /** 1-3 lines the model can quote directly. Always present. */
  summary: string;
  /** Compact structured payload — downsampled, never a raw multi-thousand-point series. */
  data?: unknown;
  /** Optional chart for multimodal turns. */
  chart?: ToolChart;
  error?: { code: string; message: string };
}

/** Minimal JSON Schema shape for a tool's parameters (OpenAI function-tool style). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Which independent user grant unlocks a side-effecting (`readOnly:false`) tool:
 *  - `'appControl'` — driving the visible app (navigate / set params / run). Gated
 *    by the "Allow app control" toggle (`ToolContext.allowAppControl`).
 *  - `'write'` — persisting data (create / capture / add / save). Gated by the
 *    "Allow actions on your behalf" toggle (`ToolContext.allowActions`).
 *
 * Read-only tools leave this undefined. `policy.checkToolPolicy` enforces the two
 * grants separately so each toggle unlocks only its own family (least privilege).
 */
export type SideEffect = 'appControl' | 'write';

/**
 * A tool definition. `parameters` is the JSON Schema advertised to the agent;
 * `run` is the client-side adapter that executes it with the user's context.
 *
 * `readOnly` declares the tool's blast radius. A read-only tool may issue queries
 * and read cached state, but must not mutate app/user/remote state. The dispatcher
 * enforces this: a non-read-only tool is refused unless the ToolContext holds the
 * matching grant for its `sideEffect` category (see `registry.dispatchTool` and
 * `policy.ts`). This is the seam for gated, side-effecting tools behind a user
 * confirmation, and a guardrail against prompt injection escalating a
 * captured-screen turn into an unintended action.
 */
export interface AgentTool<A = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** True if the tool only reads (queries/cache) and never mutates state. */
  readOnly: boolean;
  /**
   * For side-effecting tools (`readOnly:false`), which user grant unlocks it. A
   * non-read-only tool that omits this is treated as `'write'` (the more sensitive
   * default) by the policy. Ignored for read-only tools.
   */
  sideEffect?: SideEffect;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Arg-erased tool type for heterogeneous storage in the registry. Each adapter
 * keeps its precise `A` for authoring; the registry treats them uniformly and
 * the dispatcher parses/validates the JSON args before calling `run`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any>;

/** Helper for adapters: build a failed ToolResult without throwing. */
export function toolError(code: string, message: string): ToolResult {
  return { ok: false, summary: message, error: { code, message } };
}
