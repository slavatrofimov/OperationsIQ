import { describe, it, expect } from 'vitest';
import type { AccountInfo } from '@azure/msal-browser';
import { sameIdentity, selectEventhouseAccount } from './msalIdentity';

function account(username: string): AccountInfo {
  return {
    username,
    homeAccountId: `${username}-home`,
    localAccountId: `${username}-local`,
    environment: 'login.microsoftonline.com',
    tenantId: 'tenant',
  } as AccountInfo;
}

describe('sameIdentity', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(sameIdentity('User@Contoso.com', ' user@contoso.com ')).toBe(true);
  });

  it('does not match different identities', () => {
    expect(sameIdentity('a@contoso.com', 'b@contoso.com')).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(sameIdentity(undefined, 'a@contoso.com')).toBe(false);
    expect(sameIdentity('a@contoso.com', undefined)).toBe(false);
    expect(sameIdentity('', 'a@contoso.com')).toBe(false);
  });
});

describe('selectEventhouseAccount', () => {
  const alice = account('alice@contoso.com');
  const bob = account('bob@contoso.com');

  it('without a Fabric identity, uses the active account', () => {
    expect(selectEventhouseAccount([alice, bob], bob, undefined)).toBe(bob);
  });

  it('without a Fabric identity, falls back to the first cached account', () => {
    expect(selectEventhouseAccount([alice, bob], null, undefined)).toBe(alice);
  });

  it('returns undefined when there are no cached accounts', () => {
    expect(selectEventhouseAccount([], null, undefined)).toBeUndefined();
    expect(selectEventhouseAccount([], null, 'alice@contoso.com')).toBeUndefined();
  });

  it('keeps the active account when it matches the Fabric identity', () => {
    expect(selectEventhouseAccount([alice, bob], alice, 'ALICE@contoso.com')).toBe(alice);
  });

  it('ignores a divergent active account and adopts the matching cached one', () => {
    // Active account (bob) differs from the Fabric identity (alice): fail over
    // to the cached account that matches rather than reading under bob.
    expect(selectEventhouseAccount([alice, bob], bob, 'alice@contoso.com')).toBe(alice);
  });

  it('fails closed when no cached account matches the Fabric identity', () => {
    // Multi-account browser where only a different user is cached: return
    // undefined so the caller re-prompts instead of reading under the wrong id.
    expect(selectEventhouseAccount([bob], bob, 'alice@contoso.com')).toBeUndefined();
    expect(selectEventhouseAccount([bob], null, 'alice@contoso.com')).toBeUndefined();
  });
});
