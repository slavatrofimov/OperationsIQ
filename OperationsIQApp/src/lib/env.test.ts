import { describe, it, expect } from 'vitest';
import { REQUIRED_ENV, missingRequiredEnv, assertEnv } from './env';

/** Build a source object where every required key has a non-empty value. */
function completeSource(): Record<string, unknown> {
  return Object.fromEntries(REQUIRED_ENV.map(([key]) => [key, 'set']));
}

describe('required environment configuration', () => {
  it('reports no missing variables when every required key is set', () => {
    expect(missingRequiredEnv(completeSource())).toEqual([]);
  });

  it('reports the VITE_* names of missing/empty required variables', () => {
    const source = completeSource();
    delete source.msalClientId;
    source.eventhouseDb = '';
    expect(missingRequiredEnv(source).sort()).toEqual(
      ['VITE_EVENTHOUSE_DB', 'VITE_MSAL_CLIENT_ID'].sort(),
    );
  });

  it('treats an entirely empty source as all-missing', () => {
    expect(missingRequiredEnv({})).toEqual(REQUIRED_ENV.map(([, name]) => name));
  });

  it('assertEnv does not throw when configuration is complete', () => {
    expect(() => assertEnv(completeSource())).not.toThrow();
  });

  it('assertEnv throws listing the missing variables', () => {
    const source = completeSource();
    delete source.msalTenantId;
    expect(() => assertEnv(source)).toThrowError(/VITE_MSAL_TENANT_ID/);
  });
});
