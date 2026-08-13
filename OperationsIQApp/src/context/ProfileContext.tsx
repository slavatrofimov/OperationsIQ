/**
 * ProfileContext: tracks the active Connection Profile and the user's full
 * profile list. The active profile id is persisted to sessionStorage so it
 * survives page refreshes within the same browser tab. Profile data is loaded
 * from the Rayfin backend when the user is signed in.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  listProfiles,
  profileToKqlOpts,
  type ConnectionProfile,
} from '../lib/connectionProfile';
import { setActiveConnection, clearActiveConnection } from '../lib/activeConnection';
import { ensureFabricSession } from '../lib/rayfinClient';
import { backoffDelayMs, abortableDelay } from '../lib/agent/retry';
import { loadProfilesWithRetry } from '../lib/loadProfilesWithRetry';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tsi:activeProfileId';

interface ProfileContextValue {
  activeProfile: ConnectionProfile | null;
  profiles: ConnectionProfile[];
  isLoading: boolean;
  error: string | null;
  setActiveProfile: (profile: ConnectionProfile) => void;
  refreshProfiles: () => Promise<void>;
  clearActiveProfile: () => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [activeProfile, setActiveProfileState] = useState<ConnectionProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refreshProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Establish the Fabric SSO session before each list attempt and retry
      // transient backend failures with backoff — see loadProfilesWithRetry.
      const list = await loadProfilesWithRetry({
        ensureSession: ensureFabricSession,
        list: listProfiles,
        delayMs: (attempt) => backoffDelayMs(attempt),
        sleep: (ms) => abortableDelay(ms),
      });
      setProfiles(list);
      // Restore active profile from sessionStorage. If it is missing or no
      // longer exists, leave the app without an active profile — App.tsx then
      // forces the mandatory connection selector. There is no default/env
      // fallback: the app cannot run analysis without a configured profile.
      const storedId = sessionStorage.getItem(STORAGE_KEY);
      if (storedId) {
        const found = list.find((p) => p.id === storedId);
        if (found) {
          setActiveProfileState(found);
        }
      }
    } catch (e) {
      // Every attempt failed. Surface the error so the UI can show a retry
      // affordance instead of the misleading "no connections configured" empty
      // state — a failed load is NOT the same as the user having zero profiles.
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoaded(true);
      setIsLoading(false);
    }
  }, []);

  // Load profiles once on mount
  useEffect(() => {
    if (!loaded) {
      refreshProfiles().catch(() => undefined);
    }
  }, [loaded, refreshProfiles]);

  const setActiveProfile = useCallback((profile: ConnectionProfile) => {
    // Optimistically bump last-used so MRU ordering and the "Last used" badge
    // reflect the connect immediately (the backend write happens separately).
    const now = new Date();
    const touched = { ...profile, lastUsedAt: now };
    setActiveProfileState(touched);
    sessionStorage.setItem(STORAGE_KEY, touched.id);
    setProfiles((prev) =>
      prev
        .map((p) => (p.id === profile.id ? { ...p, lastUsedAt: now } : p))
        .sort((a, b) => {
          const at = a.lastUsedAt?.getTime() ?? a.createdAt.getTime();
          const bt = b.lastUsedAt?.getTime() ?? b.createdAt.getTime();
          return bt - at;
        }),
    );
  }, []);

  const clearActiveProfile = useCallback(() => {
    setActiveProfileState(null);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  // Mirror the active profile's connection settings into the module singleton
  // so the low-level query layer (eventhouse.executeKql) targets the active
  // profile's Eventhouse cluster/database without every page threading it.
  useEffect(() => {
    if (activeProfile) {
      setActiveConnection({
        kqlOpts: profileToKqlOpts(activeProfile),
        profileId: activeProfile.id,
        timeseriesRef: activeProfile.timeseriesQuery,
        timeseriesIsWide: activeProfile.timeseriesIsWide === true,
        signalIdDelimiter: activeProfile.signalIdDelimiter,
        hierarchyRef: activeProfile.hierarchyQuery,
        metadataRef: activeProfile.metadataQuery,
        eventsRef: activeProfile.eventsQuery,
      });
    } else {
      clearActiveConnection();
    }
  }, [activeProfile]);

  return (
    <ProfileContext.Provider
      value={{ activeProfile, profiles, isLoading, error, setActiveProfile, refreshProfiles, clearActiveProfile }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within a ProfileProvider');
  return ctx;
}
