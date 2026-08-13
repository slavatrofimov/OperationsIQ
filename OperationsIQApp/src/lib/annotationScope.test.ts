import { describe, it, expect, vi, beforeEach } from 'vitest';

// createAnnotation must stamp the active connection profile id so a single app
// instance keeps one profile's annotations off another's timeline.
const { create, getActiveProfileId } = vi.hoisted(() => ({
  create: vi.fn(async (row: Record<string, unknown>) => ({ id: 'a1', ...row })),
  getActiveProfileId: vi.fn((): string | undefined => 'profile-xyz'),
}));

vi.mock('./rayfinClient', () => ({
  client: { data: { Annotation: { create, update: vi.fn(), delete: vi.fn() } } },
  getFabricAccountId: vi.fn(() => 'user-1'),
}));
vi.mock('./activeConnection', () => ({
  getActiveProfileId: () => getActiveProfileId(),
}));
// eventhouse/kql pull in msal/env at module scope; stub the read path.
vi.mock('./eventhouse', () => ({ queryRows: vi.fn(async () => []) }));

import { createAnnotation } from './annotations';

describe('createAnnotation profile scoping', () => {
  beforeEach(() => {
    create.mockClear();
    getActiveProfileId.mockReturnValue('profile-xyz');
  });

  const input = {
    annotationType: 'note',
    title: 'Compressor trip',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    scope: { type: 'TagId', id: 't1', label: 'Tag 1' },
  };

  it('stamps connection_profile_id from the active profile', async () => {
    await createAnnotation(input);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ connection_profile_id: 'profile-xyz' });
  });

  it('stamps undefined when no profile is active', async () => {
    getActiveProfileId.mockReturnValue(undefined);
    await createAnnotation(input);
    expect(create.mock.calls[0][0].connection_profile_id).toBeUndefined();
  });
});
