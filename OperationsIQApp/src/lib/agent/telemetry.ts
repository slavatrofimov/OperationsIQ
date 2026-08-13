/**
 * Operations Advisor — turn telemetry seam.
 *
 * A small, VENDOR-NEUTRAL collector for what one agent turn cost and did: token
 * usage (from the Foundry run's `usage` object), and per-tool-call counts,
 * latencies, and failures. `runAgentTurn` fills a collector and hands the
 * finished `TurnTelemetry` to an optional sink (see `TurnProgress.onTelemetry`)
 * plus, in dev, the console. Nothing here is wired to a specific analytics
 * vendor — forward the snapshot wherever you like by composing a sink.
 */

/** One client-side tool invocation's outcome. */
export interface ToolCallTelemetry {
  name: string;
  ok: boolean;
  durationMs: number;
  /** ToolResult error code when `ok` is false (e.g. 'timeout', 'bad_args'). */
  errorCode?: string;
  /** True when the call was aborted by the per-tool timeout. */
  timedOut?: boolean;
}

/** Token usage, normalized from the Foundry run `usage` object. */
export interface TurnUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Everything one user turn spent / did, aggregated across run passes. */
export interface TurnTelemetry {
  /** Number of agent run passes (1 normally, 2 when the vision follow-up runs). */
  runs: number;
  /** Terminal status of each run pass, in order. */
  runStatuses: string[];
  /** Token usage summed across passes. */
  usage: TurnUsage;
  /** Every tool call made during the turn. */
  toolCalls: ToolCallTelemetry[];
  /** Wall-clock duration of the whole turn, in ms. */
  totalMs: number;
}

export type TelemetrySink = (telemetry: TurnTelemetry) => void;

export interface TelemetryCollector {
  addToolCall(call: ToolCallTelemetry): void;
  addUsage(usage: TurnUsage | undefined | null): void;
  addRunStatus(status: string): void;
  /** Finalize a snapshot, stamping `totalMs` from collector creation. */
  snapshot(): TurnTelemetry;
}

/** Create a fresh collector. `now` is injectable for deterministic tests. */
export function createTelemetryCollector(now: () => number = Date.now): TelemetryCollector {
  const start = now();
  const toolCalls: ToolCallTelemetry[] = [];
  const runStatuses: string[] = [];
  const usage: TurnUsage = {};
  let runs = 0;

  return {
    addToolCall(call) {
      toolCalls.push(call);
    },
    addUsage(u) {
      if (!u) return;
      usage.promptTokens = (usage.promptTokens ?? 0) + (u.promptTokens ?? 0);
      usage.completionTokens = (usage.completionTokens ?? 0) + (u.completionTokens ?? 0);
      usage.totalTokens = (usage.totalTokens ?? 0) + (u.totalTokens ?? 0);
    },
    addRunStatus(status) {
      runs += 1;
      runStatuses.push(status);
    },
    snapshot() {
      return {
        runs,
        runStatuses: [...runStatuses],
        usage: { ...usage },
        toolCalls: [...toolCalls],
        totalMs: now() - start,
      };
    },
  };
}

/**
 * Dev-only sink: logs a compact one-line summary plus the per-tool detail. Kept
 * deliberately simple; production forwarding should compose its own sink.
 */
export function consoleTelemetrySink(t: TurnTelemetry): void {
  const failed = t.toolCalls.filter((c) => !c.ok);
  // eslint-disable-next-line no-console
  console.info(
    `[operations-advisor] turn: ${t.runs} run(s) [${t.runStatuses.join(', ')}], ` +
      `${t.toolCalls.length} tool call(s)` +
      (failed.length ? ` (${failed.length} failed)` : '') +
      `, tokens=${t.usage.totalTokens ?? '?'} ` +
      `(in ${t.usage.promptTokens ?? '?'} / out ${t.usage.completionTokens ?? '?'}), ` +
      `${t.totalMs}ms`,
    t.toolCalls,
  );
}
