import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { hasEventhouseSession, onEventhouseSignInRequired, setFabricIdentityProvider, signInForEventhouse, signOutEventhouse } from '../lib/msal';
import { getFabricAccountEmail } from '../lib/rayfinClient';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthContextValue {
  status: AuthStatus;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Tracks the Eventhouse (Kusto) sign-in state. This is the token the browser
 * uses to read time-series data directly from the Eventhouse. Rayfin/Fabric SSO
 * (writes) is a separate context handled by rayfinClient.ts and wired in later.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');

  // Gate Eventhouse account selection on the Fabric/Rayfin SSO identity so reads
  // never run under a different account than writes. Read lazily on each token
  // acquisition, so a changed Fabric session is honored without re-wiring.
  useEffect(() => {
    setFabricIdentityProvider(getFabricAccountEmail);
    return () => setFabricIdentityProvider(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    hasEventhouseSession()
      .then((has) => {
        if (!cancelled) setStatus(has ? 'signed-in' : 'signed-out');
      })
      .catch(() => {
        if (!cancelled) setStatus('signed-out');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-show the sign-in gate when a token silently expires mid-session (a query
  // hits a silent-acquire failure or a 401/403). The user then re-signs from a
  // gesture, which is the only reliable interactive path inside the Fabric
  // portal iframe.
  useEffect(() => onEventhouseSignInRequired(() => setStatus('signed-out')), []);

  const signIn = useCallback(async () => {
    // Prefill the Kusto account picker with the Fabric-SSO identity so the user
    // is not shown the wrong signed-in account.
    await signInForEventhouse(getFabricAccountEmail());
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async () => {
    await signOutEventhouse();
    setStatus('signed-out');
  }, []);

  return <AuthContext.Provider value={{ status, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
