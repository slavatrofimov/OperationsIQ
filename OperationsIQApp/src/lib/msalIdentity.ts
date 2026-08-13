import type { AccountInfo } from '@azure/msal-browser';

/**
 * Pure identity-alignment helpers for the Eventhouse (Kusto) MSAL session.
 *
 * The Eventhouse MSAL session is deliberately separate from the Fabric/Rayfin
 * SSO session, so in a multi-account browser MSAL could cache a *different*
 * identity than the one Rayfin/Fabric writes run under. Reads would then hit the
 * Eventhouse under the wrong account (RLS still applies, but to the wrong user)
 * — an audit / data-governance hazard. These helpers gate account selection on
 * the Fabric identity so reads and writes share one identity.
 *
 * Kept free of the MSAL client instance (and `window`) so it is unit-testable in
 * a plain Node environment; `msal.ts` re-exports these.
 */

/** Case-insensitive identity comparison (MSAL username / UPN vs Fabric email). */
export function sameIdentity(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Choose the cached Kusto account for silent token acquisition, gated on the
 * Fabric identity.
 *
 *  - No Fabric identity known -> the active account, else the first cached one
 *    (backward-compatible: nothing to align against yet).
 *  - Fabric identity known -> the active account only when it matches, else any
 *    cached account that matches; `undefined` when none match (fail closed, so
 *    the caller re-prompts instead of reading under the wrong identity).
 */
export function selectEventhouseAccount(
  accounts: AccountInfo[],
  active: AccountInfo | null,
  expected: string | undefined,
): AccountInfo | undefined {
  if (!expected) return active ?? accounts[0];
  if (active && sameIdentity(active.username, expected)) return active;
  return accounts.find((a) => sameIdentity(a.username, expected));
}
