/**
 * IndustryContext: tracks the active industry for the playbook catalog.
 *
 * Industry narrows the playbook catalog to a sector. It is persisted to
 * localStorage so a user's working sector survives refreshes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { IndustryKey } from '../lib/industries';
import { INDUSTRIES } from '../lib/industries';

const INDUSTRY_KEY = 'tsi:industry';

interface IndustryContextValue {
  industry: IndustryKey;
  setIndustry: (i: IndustryKey) => void;
}

const IndustryContext = createContext<IndustryContextValue | null>(null);

function readIndustry(): IndustryKey {
  const v = localStorage.getItem(INDUSTRY_KEY);
  return INDUSTRIES.some((i) => i.key === v) ? (v as IndustryKey) : 'oil_gas';
}

export function IndustryProvider({ children }: { children: ReactNode }) {
  const [industry, setIndustryState] = useState<IndustryKey>(readIndustry);

  useEffect(() => {
    localStorage.setItem(INDUSTRY_KEY, industry);
  }, [industry]);

  const setIndustry = useCallback((i: IndustryKey) => setIndustryState(i), []);

  const value = useMemo(
    () => ({ industry, setIndustry }),
    [industry, setIndustry],
  );

  return <IndustryContext.Provider value={value}>{children}</IndustryContext.Provider>;
}

export function useIndustry(): IndustryContextValue {
  const ctx = useContext(IndustryContext);
  if (!ctx) throw new Error('useIndustry must be used within an IndustryProvider');
  return ctx;
}
