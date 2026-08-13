/**
 * useTerminology: resolves the active Connection Profile's domain terminology
 * (ProfileLabels) so components can render user-facing domain terms — the
 * signal/metric-id label, entity label, hierarchy-level labels, unit-of-measure
 * and sampling-frequency labels — without prop-drilling or hardcoding
 * "Signal"/"Tag"/"Engineering Units".
 *
 * The active profile's labels are merged over DEFAULT_LABELS so any label the
 * profile omits falls back to a sensible default. A small pluralize helper
 * covers the common "one vs. many" phrasing (e.g. "Signal" → "Signals").
 *
 * Scope: domain terminology only. Generic UI chrome (Save/Cancel, section
 * headings) is intentionally left hardcoded.
 */

import { useMemo } from 'react';
import { useProfile } from '../context/ProfileContext';
import { DEFAULT_LABELS, type ProfileLabels } from '../lib/connectionProfile';

/** Simple, domain-term-safe pluralization for short English labels. */
export function pluralizeLabel(word: string): string {
  const w = word.trim();
  if (!w) return w;
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

export interface Terminology extends ProfileLabels {
  /** Plural form of the signal/metric-id label, e.g. "Signals". */
  metricIdLabelPlural: string;
  /** Plural form of the entity label, e.g. "Assets". */
  entityLabelPlural: string;
  /** Ordered hierarchy-level labels (level1..level10). */
  levelLabels: string[];
  /** Pluralize an arbitrary label. */
  pluralize: (word: string) => string;
}

/**
 * Resolve the active profile's domain terminology, merged over DEFAULT_LABELS.
 * Safe to call outside a page that has an active profile — it simply returns
 * the defaults until a profile is selected.
 */
export function useTerminology(): Terminology {
  const { activeProfile } = useProfile();
  return useMemo(() => {
    const labels: ProfileLabels = { ...DEFAULT_LABELS, ...activeProfile?.labels };
    return {
      ...labels,
      metricIdLabelPlural: pluralizeLabel(labels.metricIdLabel),
      entityLabelPlural: pluralizeLabel(labels.entityLabel),
      levelLabels: [
        labels.level1Label,
        labels.level2Label,
        labels.level3Label,
        labels.level4Label,
        labels.level5Label,
        labels.level6Label,
        labels.level7Label,
        labels.level8Label,
        labels.level9Label,
        labels.level10Label,
      ],
      pluralize: pluralizeLabel,
    };
  }, [activeProfile?.labels]);
}
