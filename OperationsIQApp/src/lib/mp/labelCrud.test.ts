import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Rayfin client so label CRUD runs without a real Fabric session.
const { create, update, remove } = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../rayfinClient', () => ({
  client: { data: { Label: { create, update, delete: remove } } },
  getFabricAccountId: vi.fn(() => 'user-1'),
  ensureFabricSession: vi.fn(async () => true),
}));

import { createLabel, updateLabel } from './analysisClient';
import type { LabelInput } from './types';

const baseInput: LabelInput = {
  signalId: 'pressure-01',
  jobId: 'job-1',
  kind: 'MOTIF',
  startIndex: 100,
  length: 32,
  text: 'Healthy cycle',
  category: 'builtin:healthy',
  color: '#16a34a',
  confidence: 0.9,
  secondsPerSample: 5,
};

beforeEach(() => {
  create.mockReset();
  update.mockReset();
  remove.mockReset();
});

describe('createLabel persistence guard', () => {
  it('throws when the store does not return a persisted row (no fabricated success)', async () => {
    create.mockResolvedValue(undefined);
    await expect(createLabel(baseInput)).rejects.toThrow(/not saved/i);
  });

  it('throws when the returned row has no id', async () => {
    create.mockResolvedValue({});
    await expect(createLabel(baseInput)).rejects.toThrow(/not saved/i);
  });

  it('maps the persisted id back onto the created label and writes the category FK', async () => {
    create.mockResolvedValue({ id: 'label-123', createdAt: new Date('2026-07-01T00:00:00.000Z') });
    const label = await createLabel(baseInput);
    expect(label.id).toBe('label-123');
    expect(label.signalId).toBe('pressure-01');
    expect(label.category).toBe('builtin:healthy');
    expect(label.createdAt).toBe('2026-07-01T00:00:00.000Z');
    // Category is persisted through the soft labelCategory_id text FK.
    expect(create.mock.calls[0][0].labelCategory_id).toBe('builtin:healthy');
  });
});

describe('updateLabel', () => {
  it('updates only the editable fields, mapping category to labelCategory_id', async () => {
    update.mockResolvedValue({ id: 'label-123' });
    await updateLabel('label-123', {
      text: 'Bearing spall',
      category: 'builtin:anomaly',
      color: '#dc2626',
      confidence: 0.75,
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toEqual({ id: 'label-123' });
    expect(update.mock.calls[0][1]).toEqual({
      text: 'Bearing spall',
      labelCategory_id: 'builtin:anomaly',
      color: '#dc2626',
      confidence: 0.75,
    });
  });
});
