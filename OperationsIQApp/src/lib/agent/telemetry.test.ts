import { describe, it, expect } from 'vitest';
import { createTelemetryCollector } from './telemetry';

describe('createTelemetryCollector', () => {
  it('aggregates tool calls, usage, and run statuses across passes', () => {
    let t = 1000;
    const collector = createTelemetryCollector(() => t);

    collector.addToolCall({ name: 'resolve_tags', ok: true, durationMs: 12 });
    collector.addToolCall({ name: 'forecast', ok: false, durationMs: 40, errorCode: 'timeout', timedOut: true });
    collector.addUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    collector.addUsage({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    collector.addRunStatus('completed');
    collector.addRunStatus('completed');

    t = 1250; // 250ms elapsed
    const snap = collector.snapshot();

    expect(snap.runs).toBe(2);
    expect(snap.runStatuses).toEqual(['completed', 'completed']);
    expect(snap.usage).toEqual({ promptTokens: 120, completionTokens: 60, totalTokens: 180 });
    expect(snap.toolCalls).toHaveLength(2);
    expect(snap.toolCalls[1]).toMatchObject({ name: 'forecast', ok: false, timedOut: true });
    expect(snap.totalMs).toBe(250);
  });

  it('ignores null/undefined usage and starts empty', () => {
    const collector = createTelemetryCollector(() => 0);
    collector.addUsage(undefined);
    collector.addUsage(null);
    const snap = collector.snapshot();
    expect(snap.usage).toEqual({});
    expect(snap.toolCalls).toEqual([]);
    expect(snap.runs).toBe(0);
  });

  it('snapshot is an immutable copy (does not mutate later)', () => {
    const collector = createTelemetryCollector(() => 0);
    collector.addToolCall({ name: 'a', ok: true, durationMs: 1 });
    const snap = collector.snapshot();
    collector.addToolCall({ name: 'b', ok: true, durationMs: 1 });
    expect(snap.toolCalls).toHaveLength(1);
  });
});
