import { describe, it, expect, beforeEach, vi } from 'vitest';

// The investigation tools read/write persisted rows via `../../evidence`, which
// pulls in the Rayfin data client. Stub it so the tool logic (defaulting,
// gating, error handling, active-target wiring) is what's under test — not I/O.
vi.mock('../../evidence', () => ({
  listInvestigations: vi.fn(),
  createInvestigation: vi.fn(),
}));

import { listInvestigations, createInvestigation } from '../../evidence';
import type { ToolContext } from '../types';
import {
  __resetEvidenceBridgeForTests,
  setEvidenceCapture,
  setActiveInvestigationAccessor,
  type ActiveInvestigationRef,
  type AgentEvidenceResult,
} from '../evidenceBridge';
import { listInvestigationsTool } from './listInvestigations';
import { setActiveInvestigationTool } from './setActiveInvestigation';
import { captureEvidenceTool } from './captureEvidence';
import { createInvestigationTool } from './createInvestigation';

const ctx = { tags: [] } as unknown as ToolContext;

function inv(over: Partial<{ id: string; name: string; description: string; created_at: Date; updated_at: Date }> = {}) {
  return {
    id: 'i1',
    user_id: 'u1',
    name: 'Line 3 vibration',
    description: undefined,
    created_at: new Date('2024-03-10T00:00:00Z'),
    updated_at: new Date('2024-03-13T00:00:00Z'),
    ...over,
  };
}

/** An in-memory active-investigation accessor for asserting set() calls. */
function memAccessor(initial: ActiveInvestigationRef | null = null) {
  let current = initial;
  return {
    get: () => current,
    set: (ref: ActiveInvestigationRef) => {
      current = ref;
    },
    peek: () => current,
  };
}

const listMock = vi.mocked(listInvestigations);
const createMock = vi.mocked(createInvestigation);

describe('investigation & evidence tools', () => {
  beforeEach(() => {
    __resetEvidenceBridgeForTests();
    listMock.mockReset();
    createMock.mockReset();
  });

  it('declares blast radius: list is read-only; set/capture are writes', () => {
    expect(listInvestigationsTool.readOnly).toBe(true);
    expect(setActiveInvestigationTool.readOnly).toBe(false);
    expect(captureEvidenceTool.readOnly).toBe(false);
  });

  describe('list_investigations', () => {
    it('lists cases and flags the active one', async () => {
      listMock.mockResolvedValue([inv({ id: 'i1' }), inv({ id: 'i2', name: 'Pump A' })] as never);
      setActiveInvestigationAccessor(memAccessor({ id: 'i2', name: 'Pump A' }));

      const r = await listInvestigationsTool.run({}, ctx);
      expect(r.ok).toBe(true);
      const data = r.data as { investigations: { id: string; isActive: boolean }[]; activeId: string };
      expect(data.investigations).toHaveLength(2);
      expect(data.activeId).toBe('i2');
      expect(data.investigations.find((i) => i.id === 'i2')?.isActive).toBe(true);
      expect(data.investigations.find((i) => i.id === 'i1')?.isActive).toBe(false);
    });

    it('reports emptiness without throwing', async () => {
      listMock.mockResolvedValue([] as never);
      const r = await listInvestigationsTool.run({}, ctx);
      expect(r.ok).toBe(true);
      expect((r.data as { count: number }).count).toBe(0);
    });
  });

  describe('set_active_investigation', () => {
    it('activates an existing case via the accessor', async () => {
      listMock.mockResolvedValue([inv({ id: 'i1', name: 'Line 3 vibration' })] as never);
      const accessor = memAccessor();
      setActiveInvestigationAccessor(accessor);

      const r = await setActiveInvestigationTool.run({ investigationId: 'i1' }, ctx);
      expect(r.ok).toBe(true);
      expect(accessor.peek()).toEqual({ id: 'i1', name: 'Line 3 vibration' });
    });

    it('rejects an unknown id', async () => {
      listMock.mockResolvedValue([inv({ id: 'i1' })] as never);
      setActiveInvestigationAccessor(memAccessor());
      const r = await setActiveInvestigationTool.run({ investigationId: 'nope' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('not_found');
    });

    it('fails cleanly when the bridge is unavailable', async () => {
      const r = await setActiveInvestigationTool.run({ investigationId: 'i1' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('unavailable');
    });
  });

  describe('capture_evidence', () => {
    const okResult: AgentEvidenceResult = {
      ok: true,
      evidenceId: 'e1',
      pageName: 'Explore',
      chartCount: 2,
    };

    it('captures into the active investigation by default', async () => {
      const capture = vi.fn().mockResolvedValue(okResult);
      setEvidenceCapture(capture);
      setActiveInvestigationAccessor(memAccessor({ id: 'i9', name: 'Active case' }));

      const r = await captureEvidenceTool.run({ annotation: 'baseline' }, ctx);
      expect(r.ok).toBe(true);
      expect(capture).toHaveBeenCalledWith({ investigationId: 'i9', annotation: 'baseline' });
      expect((r.data as { chartCount: number }).chartCount).toBe(2);
    });

    it('prefers an explicit investigationId over ctx / active', async () => {
      const capture = vi.fn().mockResolvedValue(okResult);
      setEvidenceCapture(capture);
      setActiveInvestigationAccessor(memAccessor({ id: 'active', name: 'A' }));

      await captureEvidenceTool.run({ investigationId: 'explicit' }, {
        ...ctx,
        investigationId: 'from-ctx',
      } as ToolContext);
      expect(capture).toHaveBeenCalledWith({ investigationId: 'explicit', annotation: undefined });
    });

    it('falls back to ctx.investigationId when nothing else is set', async () => {
      const capture = vi.fn().mockResolvedValue(okResult);
      setEvidenceCapture(capture);

      await captureEvidenceTool.run({}, { ...ctx, investigationId: 'ctx-inv' } as ToolContext);
      expect(capture).toHaveBeenCalledWith({ investigationId: 'ctx-inv', annotation: undefined });
    });

    it('errors when there is no target investigation', async () => {
      setEvidenceCapture(vi.fn());
      const r = await captureEvidenceTool.run({}, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('no_investigation');
    });

    it('surfaces a capture failure as ok:false', async () => {
      setEvidenceCapture(vi.fn().mockResolvedValue({ ok: false, error: 'no root' }));
      const r = await captureEvidenceTool.run(
        {},
        { ...ctx, investigationId: 'i1' } as ToolContext,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('capture_failed');
    });

    it('fails cleanly when the capture bridge is unavailable', async () => {
      const r = await captureEvidenceTool.run({}, { ...ctx, investigationId: 'i1' } as ToolContext);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('unavailable');
    });
  });

  describe('create_investigation', () => {
    it('creates a case and makes it the active capture target', async () => {
      createMock.mockResolvedValue(
        inv({ id: 'new1', name: 'New case', created_at: new Date('2024-03-13T01:00:00Z') }) as never,
      );
      const accessor = memAccessor();
      setActiveInvestigationAccessor(accessor);

      const r = await createInvestigationTool.run({ name: 'New case' }, ctx);
      expect(r.ok).toBe(true);
      expect(accessor.peek()).toEqual({ id: 'new1', name: 'New case' });
    });
  });
});
