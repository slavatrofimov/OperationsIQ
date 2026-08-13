import { useMemo } from 'react';
import { useProfile } from '../context/ProfileContext';
import { getHierarchyLevels } from '../lib/tagTree';

/** Resolve the active profile's hierarchy levels once for page-level consumers. */
export function useHierarchyLevels() {
  const { activeProfile } = useProfile();
  return useMemo(() => getHierarchyLevels(activeProfile?.labels), [activeProfile]);
}
