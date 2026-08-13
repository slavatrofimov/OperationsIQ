import { afterEach, describe, expect, it } from 'vitest';
import {
  clearActiveConnection,
  getActiveKqlOpts,
  getActiveProfileId,
  setActiveConnection,
} from './activeConnection';

afterEach(() => {
  clearActiveConnection();
});

describe('active connection profile id', () => {
  it('returns undefined when no connection is active', () => {
    expect(getActiveProfileId()).toBeUndefined();
  });

  it('exposes the profile id set by ProfileContext', () => {
    setActiveConnection({ kqlOpts: {}, profileId: 'profile-123' });
    expect(getActiveProfileId()).toBe('profile-123');
    expect(getActiveKqlOpts()).toEqual({});
  });

  it('is undefined when a connection is set without a profile id', () => {
    setActiveConnection({ kqlOpts: {} });
    expect(getActiveProfileId()).toBeUndefined();
  });

  it('clears the profile id when the connection is cleared', () => {
    setActiveConnection({ kqlOpts: {}, profileId: 'profile-abc' });
    clearActiveConnection();
    expect(getActiveProfileId()).toBeUndefined();
  });
});
