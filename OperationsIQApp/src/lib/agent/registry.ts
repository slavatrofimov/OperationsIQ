/**
 * Tool registry + dispatcher.
 *
 * The single array `AGENT_TOOLS` is the source of truth. It feeds two things:
 *  1. `toolDefinitions()` — the function-tool specs advertised to the Foundry
 *     agent when a run is started.
 *  2. `dispatchTool()` — the client-side executor that runs a tool the agent
 *     asked for, always inside the SPA (so the user's token/RLS apply).
 *
 * The single array `AGENT_TOOLS` is the source of truth for every read-only
 * analysis adapter the agent can call. Add further adapters here as they are built.
 */

import type { ToolContext, ToolResult, AnyAgentTool, JsonSchema } from './types';
import { toolError } from './types';
import { validateArgs } from './validate';
import { checkToolPolicy } from './policy';
import { resolveTagsTool } from './tools/resolveTags';
import { forecastTool } from './tools/forecast';
import { forecastDetailTool } from './tools/forecastDetail';
import { seriesDetailTool } from './tools/seriesDetail';
import { exploreSignalsTool } from './tools/exploreSignals';
import { decomposeSignalTool } from './tools/decomposeSignal';
import { detectChangePointTool } from './tools/detectChangePoint';
import { analyzeSpectrumTool } from './tools/analyzeSpectrum';
import { diagnoseAnomaliesTool } from './tools/diagnoseAnomalies';
import { mineProcessesTool } from './tools/mineProcesses';
import { monitorDeviationTool } from './tools/monitorDeviation';
import { controlChartTool } from './tools/controlChart';
import { detectDiscordsTool } from './tools/detectDiscords';
import { rankCausesTool } from './tools/rankCauses';
import { causalityMatrixTool } from './tools/causalityMatrix';
import { regressionAnalysisTool } from './tools/regressionAnalysis';
import { validateSignalTool } from './tools/validateSignal';
import { findSimilarPatternsTool } from './tools/findSimilarPatterns';
import { segmentCyclesTool } from './tools/segmentCycles';
import { computeDerivedMetricTool } from './tools/computeDerivedMetric';
import { comparePeriodsTool } from './tools/comparePeriods';
import { runScenarioTool } from './tools/runScenario';
import { temporalHeatmapTool } from './tools/temporalHeatmap';
// Side tools — context, catalog, recall, self-knowledge, and gated writes.
import { getCurrentTimeTool } from './tools/getCurrentTime';
import { resolveTimeWindowTool } from './tools/resolveTimeWindow';
import { describeTagTool } from './tools/describeTag';
import { browseAssetHierarchyTool } from './tools/browseAssetHierarchy';
import { listEventsTool } from './tools/listEvents';
import { getDataCoverageTool } from './tools/getDataCoverage';
import { getScreenContextTool } from './tools/getScreenContext';
import { getActiveProfileTool } from './tools/getActiveProfile';
import { listCapabilitiesTool } from './tools/listCapabilities';
import { explainMethodTool } from './tools/explainMethod';
import { requestUserChoiceTool } from './tools/requestUserChoice';
import { listSavedDerivedMetricsTool } from './tools/listSavedDerivedMetrics';
import { listAlertRulesTool } from './tools/listAlertRules';
import { createInvestigationTool } from './tools/createInvestigation';
import { listInvestigationsTool } from './tools/listInvestigations';
import { setActiveInvestigationTool } from './tools/setActiveInvestigation';
import { captureEvidenceTool } from './tools/captureEvidence';
import { addAnnotationTool } from './tools/addAnnotation';
import { saveDerivedMetricTool } from './tools/saveDerivedMetric';
import { uiControlTools } from './tools/uiControlTools';

export const AGENT_TOOLS: AnyAgentTool[] = [
  resolveTagsTool,
  forecastTool,
  forecastDetailTool,
  seriesDetailTool,
  exploreSignalsTool,
  decomposeSignalTool,
  detectChangePointTool,
  analyzeSpectrumTool,
  monitorDeviationTool,
  controlChartTool,
  detectDiscordsTool,
  rankCausesTool,
  causalityMatrixTool,
  diagnoseAnomaliesTool,
  regressionAnalysisTool,
  validateSignalTool,
  findSimilarPatternsTool,
  segmentCyclesTool,
  mineProcessesTool,
  computeDerivedMetricTool,
  comparePeriodsTool,
  runScenarioTool,
  temporalHeatmapTool,
  // Temporal & environment awareness (read-only).
  getCurrentTimeTool,
  resolveTimeWindowTool,
  // Data catalog & metadata (read-only).
  describeTagTool,
  browseAssetHierarchyTool,
  listEventsTool,
  getDataCoverageTool,
  // UI / session context (read-only).
  getScreenContextTool,
  getActiveProfileTool,
  // Self-knowledge & grounding (read-only).
  listCapabilitiesTool,
  explainMethodTool,
  // Conversational UX (read-only): ask the user to confirm / pick via buttons.
  requestUserChoiceTool,
  // Memory & knowledge recall (read-only).
  listSavedDerivedMetricsTool,
  listAlertRulesTool,
  listInvestigationsTool,
  // Side-effecting / autonomy (WRITE — sideEffect:'write', gated by ctx.allowActions).
  createInvestigationTool,
  setActiveInvestigationTool,
  captureEvidenceTool,
  addAnnotationTool,
  saveDerivedMetricTool,
  // UI-control tools: drive the live app (navigate / set params / run / read).
  // navigate/set/run are side-effecting and gated by policy.checkToolPolicy.
  ...uiControlTools,
];

/**
 * Static self-description of the toolset, derived once from `AGENT_TOOLS`. It is
 * injected into every dispatch so `list_capabilities` can enumerate the tools
 * without importing this module (which would be a circular import).
 */
const CAPABILITIES = AGENT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  readOnly: t.readOnly,
}));

const BY_NAME = buildIndex(AGENT_TOOLS);

/** Index tools by name, failing fast on a duplicate so drift is caught early. */
function buildIndex(tools: AnyAgentTool[]): Map<string, AnyAgentTool> {
  const map = new Map<string, AnyAgentTool>();
  for (const t of tools) {
    if (map.has(t.name)) throw new Error(`Duplicate agent tool name: ${t.name}`);
    map.set(t.name, t);
  }
  return map;
}

/** OpenAI-style function-tool definitions to send when starting a run. */
export function toolDefinitions() {
  return AGENT_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * A single Foundry "Function calling" tool definition, in the *flattened* shape
 * the agents API expects inside `definition.tools` (name/description/parameters
 * at the top level). This differs from {@link toolDefinitions} which returns the
 * nested Chat-Completions shape (`{ function: { ... } }`) used by other clients.
 */
export interface FunctionToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Optional structured-output strictness. Left undefined (off) for our tools
   *  because several use optional params / numeric bounds / additionalProperties,
   *  which strict mode forbids. `dispatchTool` re-validates args regardless. */
  strict?: boolean;
}

/**
 * Function-tool definitions in the flattened shape the Foundry agents API
 * expects under `definition.tools`. This is the schema published into the agent
 * definition by the provisioning script (`scripts/provision-foundry-agent.ts`).
 */
export function functionToolDefs(): FunctionToolDef[] {
  return AGENT_TOOLS.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Execute one agent-requested tool call. `rawArgs` is the JSON string the model
 * produced. Every failure mode (unknown tool, bad JSON, schema violation, policy
 * refusal, adapter throw) is turned into an `ok:false` ToolResult so the agent can
 * read and recover from it.
 *
 * Order of enforcement:
 *   1. Tool must be registered.
 *   2. Side-effect policy — a non-read-only tool is refused unless the context
 *      holds the grant matching its `sideEffect` family (appControl → allowAppControl,
 *      write → allowActions; see ToolContext + policy.ts). A guardrail for gated
 *      tools and prompt injection.
 *   3. Arguments must parse as JSON and satisfy the tool's advertised schema.
 */
export async function dispatchTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return toolError('unknown_tool', `Unknown tool: ${name}`);

  const policy = checkToolPolicy(tool, ctx);
  if (!policy.ok) return toolError(policy.code, policy.message);

  // Inject the toolset self-description so list_capabilities can enumerate it
  // without importing the registry. Caller-supplied capabilities win (tests).
  const runCtx: ToolContext = ctx.capabilities ? ctx : { ...ctx, capabilities: CAPABILITIES };

  let parsed: unknown;
  try {
    parsed = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return toolError('bad_args', `Tool ${name} received invalid JSON arguments.`);
  }

  const validation = validateArgs(tool.parameters, parsed);
  if (!validation.ok) {
    return toolError('bad_args', `Tool ${name} arguments are invalid: ${validation.errors.join(' ')}`);
  }

  try {
    return await tool.run(validation.value as never, runCtx);
  } catch (e) {
    return toolError('tool_error', `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
