import type { PageKey } from './pages';

/** Tabs always available in the navigation. */
const ALWAYS: PageKey[] = ['investigations', 'playbooks'];

/**
 * Full navigation (all analytical pages) — the set of pages that are reachable.
 * The Deep Discovery "Saved patterns" gallery lives as a tab inside the Patterns
 * page; the "Saved patterns" menu item deep-links to that tab via a nav preset.
 */
const ADVANCED_NAV: PageKey[] = [
  'explore',
  'liveview',
  'forecast',
  'monitor',
  'controlchart',
  'activatorAlerts',
  'alerts',
  'regression',
  'rootcause',
  'causality',
  'discover',
  'classifiers',
  'patterns',
  'compare',
  'calendar',
  'trendvolatility',
  'segmentation',
  'decompose',
  'changepoints',
  'spectrum',
  'processmining',
  'scenario',
  'validation',
  'metadata',
  'derived',
  'sonify',
  'similarity',
];

/** Human labels for each page key, used to render tabs generically. */
export const PAGE_LABELS: Record<PageKey, string> = {
  playbooks: 'Playbooks',
  explore: 'Explore',
  liveview: 'Live view',
  similarity: 'Similarity search',
  forecast: 'Forecast',
  monitor: 'Deviations',
  controlchart: 'Control chart',
  activatorAlerts: 'Activator Alerts',
  alerts: 'Diagnostic Findings',
  regression: 'Regression',
  rootcause: 'Root cause',
  discover: 'Anomalies',
  classifiers: 'Classifiers',
  patterns: 'Patterns',
  compare: 'Compare',
  calendar: 'Heatmaps',
  trendvolatility: 'Trend & volatility',
  segmentation: 'Segmentation',
  derived: 'Derived',
  sonify: 'Sonify',
  decompose: 'Decomposition',
  changepoints: 'Change points',
  spectrum: 'Spectrum',
  processmining: 'Process mining',
  causality: 'Influence map',
  scenario: 'What-if',
  validation: 'Signal validation',
  metadata: 'Signal metadata',
  investigations: 'Investigations',
  config: 'Connections',
};

/**
 * A preset applied when a navigation item is chosen. It lets several menu items
 * route to the same page while pre-configuring what that page should show —
 * e.g. the five "Deep discovery" items all open the Matrix Profile Patterns
 * page but each pre-selects a different analysis recipe.
 */
export interface NavPreset {
  /** Pre-select a Matrix Profile analysis recipe on the Patterns page. */
  recipeId?: string;
  /** Pre-select a tab on the Patterns (Deep Discovery) page. */
  patternsTab?: 'runs' | 'library';
}

/**
 * A single selectable menu entry. Multiple items may target the same {@link page}
 * with different {@link preset}s (e.g. the Deep discovery recipes).
 */
export interface NavItem {
  /** Stable, unique key for this menu entry. */
  key: string;
  /** User-facing label. */
  label: string;
  /** The page this item routes to. */
  page: PageKey;
  /** Optional preset applied to the target page on navigation. */
  preset?: NavPreset;
}

/**
 * A labeled cluster of items nested one level deeper than a {@link NavSection}.
 * Used to split a single section into named groups (e.g. "Deep discovery" →
 * "Across one signal" / "Across multiple signals").
 */
export interface NavSubSection {
  header?: string;
  items: NavItem[];
}

/**
 * A labeled cluster within a dropdown. A blank header renders inline. A section
 * carries either a flat list of {@link items} or, for a two-level section, a set
 * of {@link subsections}; exactly one is populated.
 */
export interface NavSection {
  header?: string;
  items?: NavItem[];
  subsections?: NavSubSection[];
}

/** All nav items in a section, whether flat or nested under subsections. */
export function sectionItems(section: NavSection): NavItem[] {
  return section.items ?? section.subsections?.flatMap((ss) => ss.items) ?? [];
}

/**
 * A top-level navigation group. Related capabilities are collected under a
 * single menu so the advanced-mode navigation stays compact. A group whose only
 * visible item is itself renders as a direct button rather than a dropdown;
 * groups with several items render as a dropdown, with an optional header per
 * section.
 */
export interface NavGroup {
  id: string;
  label: string;
  sections: NavSection[];
}

/**
 * The master, goal-based menu for advanced mode. The order here is the rendered
 * menu order. Items are filtered to those whose page is reachable before
 * rendering.
 */
const NAV_MODEL: NavGroup[] = [
  {
    id: 'explore',
    label: 'Explore',
    sections: [
      {
        items: [
          { key: 'explore', label: 'Overview', page: 'explore' },
          { key: 'liveview', label: 'Live view', page: 'liveview' },
          { key: 'trendvolatility', label: 'Trend & volatility', page: 'trendvolatility' },
          { key: 'spectrum', label: 'Spectrum', page: 'spectrum' },
          { key: 'similarity', label: 'Similarity search', page: 'similarity' },
          { key: 'compare', label: 'Compare', page: 'compare' },
          { key: 'calendar', label: 'Heatmaps', page: 'calendar' },
          { key: 'derived', label: 'Derived metrics', page: 'derived' },
          { key: 'sonify', label: 'Sonify', page: 'sonify' },
        ],
      },
    ],
  },
  {
    id: 'diagnose',
    label: 'Diagnose',
    sections: [
      {
        header: 'Explain relationships',
        items: [
          { key: 'causality', label: 'Influence map', page: 'causality' },
          { key: 'rootcause', label: 'Root cause', page: 'rootcause' },
          { key: 'regression', label: 'Regression & sensitivity', page: 'regression' },
          { key: 'decompose', label: 'Decomposition', page: 'decompose' },
          { key: 'changepoints', label: 'Change points', page: 'changepoints' },
        ],
      },
      {
        header: 'Health monitoring',
        items: [
          { key: 'monitor', label: 'Deviations', page: 'monitor' },
          { key: 'controlchart', label: 'Control chart', page: 'controlchart' },
          { key: 'validation', label: 'Signal validation', page: 'validation' },
          { key: 'alerts', label: 'Diagnostic Findings', page: 'alerts' },
          { key: 'metadata', label: 'Signal metadata', page: 'metadata' },
        ],
      },
    ],
  },
  {
    id: 'planning',
    label: 'Planning',
    sections: [
      {
        items: [
          { key: 'forecast', label: 'Forecast', page: 'forecast' },
          { key: 'scenario', label: 'What-if', page: 'scenario' },
        ],
      },
    ],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    sections: [
      {
        header: 'Quick interactive discovery',
        items: [
          { key: 'discover-anomalies', label: 'Anomalies', page: 'discover' },
          { key: 'discover-classifiers', label: 'Classifiers', page: 'classifiers' },
          { key: 'segmentation', label: 'Segmentation', page: 'segmentation' },
          { key: 'processmining', label: 'Process mining', page: 'processmining' },
        ],
      },
      {
        header: 'Deep discovery',
        subsections: [
          {
            header: 'Across one signal',
            items: [
              { key: 'mp-normal-cycles', label: 'Normal cycles', page: 'patterns', preset: { recipeId: 'normal-cycles' } },
              { key: 'mp-anomalies', label: 'Anomalies', page: 'patterns', preset: { recipeId: 'anomalies' } },
              { key: 'mp-regime', label: 'Regime change', page: 'patterns', preset: { recipeId: 'regime-changes' } },
              { key: 'mp-degradation', label: 'Slow degradation', page: 'patterns', preset: { recipeId: 'degradation' } },
              { key: 'mp-auto', label: 'Auto-discovery', page: 'patterns', preset: { recipeId: 'auto-length' } },
            ],
          },
          {
            header: 'Across multiple signals',
            items: [
              { key: 'mp-compare', label: 'Compare two signals', page: 'patterns', preset: { recipeId: 'compare-shared' } },
              { key: 'mp-vs-baseline', label: 'Changes vs baseline', page: 'patterns', preset: { recipeId: 'compare-novelty' } },
              { key: 'mp-multi-events', label: 'Multi-sensor events', page: 'patterns', preset: { recipeId: 'multi-sensor-events' } },
              { key: 'mp-multi-anomalies', label: 'Multi-sensor anomalies', page: 'patterns', preset: { recipeId: 'multi-sensor-anomalies' } },
              { key: 'mp-multi-segments', label: 'Multi-sensor segments', page: 'patterns', preset: { recipeId: 'multi-sensor-segments' } },
              { key: 'mp-fleet-shape', label: 'Fleet common shape', page: 'patterns', preset: { recipeId: 'fleet-common-shape' } },
            ],
          },
        ],
      },
      {
        header: 'Review saved patterns',
        items: [{ key: 'saved-patterns', label: 'Saved patterns', page: 'patterns', preset: { patternsTab: 'library' } }],
      },
    ],
  },
  {
    id: 'playbooks',
    label: 'Playbooks',
    sections: [{ items: [{ key: 'playbooks', label: 'Playbooks', page: 'playbooks' }] }],
  },
  {
    id: 'alertCenter',
    label: 'Activator Alerts',
    sections: [
      {
        items: [
          { key: 'activatorAlerts', label: 'Activator Alerts', page: 'activatorAlerts' },
        ],
      },
    ],
  },
  {
    id: 'investigations',
    label: 'Investigations',
    sections: [{ items: [{ key: 'investigations', label: 'Investigations', page: 'investigations' }] }],
  },
];

/**
 * Whether a nav item is the exact current selection, taking presets into account.
 *
 * Several menu items can target the same page (e.g. the five "Deep discovery"
 * recipes all open `patterns`). Matching on page alone would light up every
 * sibling; we also compare the preset dimension the page uses (recipe or
 * patterns tab) so only the item that produced the current view reads as active.
 */
export function isNavItemActive(item: NavItem, current: PageKey, preset?: NavPreset): boolean {
  if (item.page !== current) return false;

  const itemRecipe = item.preset?.recipeId;
  const curRecipe = preset?.recipeId;
  if (itemRecipe !== undefined || curRecipe !== undefined) {
    return itemRecipe === curRecipe;
  }

  const itemPatternsTab = item.preset?.patternsTab;
  const curPatternsTab = preset?.patternsTab;
  if (itemPatternsTab !== undefined || curPatternsTab !== undefined) {
    return itemPatternsTab === curPatternsTab;
  }

  return true;
}

/**
 * Resolve the full navigation.
 *
 * Returns the full goal-based {@link NAV_MODEL}, filtered to items whose page is
 * reachable, with section headers preserved (rendered as grouped dropdowns).
 * Every analytical page is visible so the user — and the AI — can reach any
 * page.
 */
export function resolveNav(): NavGroup[] {
  const visible = new Set(visiblePages());

  const groups: NavGroup[] = [];
  for (const group of NAV_MODEL) {
    const sections = group.sections
      .map((s): NavSection => {
        if (s.subsections) {
          const subsections = s.subsections
            .map((ss) => ({ ...ss, items: ss.items.filter((i) => visible.has(i.page)) }))
            .filter((ss) => ss.items.length > 0);
          return { ...s, subsections };
        }
        return { ...s, items: (s.items ?? []).filter((i) => visible.has(i.page)) };
      })
      .filter((s) => sectionItems(s).length > 0);
    if (sections.length > 0) groups.push({ ...group, sections });
  }
  return groups;
}

/**
 * The ordered list of navigation tabs to show. Every analytical page is
 * visible; Playbooks and Investigations are always present.
 */
export function visiblePages(): PageKey[] {
  const ordered: PageKey[] = [...ADVANCED_NAV, 'playbooks'];
  const seen = new Set<PageKey>();
  const result: PageKey[] = [];
  for (const p of [...ordered, ...ALWAYS]) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}
