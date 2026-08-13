/**
 * First-turn orientation briefing for the Operations Advisor.
 *
 * Hierarchies can hold hundreds of thousands of tags, so we NEVER send the full
 * tree. Instead, on the first turn of a fresh conversation we compute a bounded
 * summary from the already-loaded, RLS-scoped catalog (`ctx.tags`) — no extra
 * query — so the agent starts with situational awareness: which connection it is
 * on, what the data represents, the user's terminology, a top-level hierarchy
 * snapshot, and a pointer to the long-running Deep Discovery recipes. The agent
 * deepens on demand via `browse_asset_hierarchy`.
 */

import type { ToolContext } from './types';
import type { TagInfo } from '../tags';

/** How many level-1 nodes to enumerate before summarizing the remainder. */
const TOP_LEVEL1_NODES = 20;

/** Count distinct non-empty values of `key` across the catalog. */
function distinctCount(tags: TagInfo[], key: keyof TagInfo): number {
  const seen = new Set<string>();
  for (const t of tags) {
    const v = t[key];
    if (typeof v === 'string' && v.trim()) seen.add(v);
  }
  return seen.size;
}

/**
 * Build the one-shot orientation briefing text, or null when there is nothing
 * useful to say (no catalog and no profile info). Bounded to a few hundred
 * tokens: enumerates only the top level-1 nodes and summarizes the rest.
 */
export function buildOrientationBriefingText(ctx: ToolContext): string | null {
  const tags = ctx.tags ?? [];
  const profile = ctx.profile;
  const term = ctx.terminology;
  const hasProfile = !!(profile?.name || profile?.description || profile?.scopeDescription);
  if (!tags.length && !hasProfile) return null;

  const lines: string[] = [];

  // --- Connection / data scope --------------------------------------------
  if (profile?.name) lines.push(`Connection profile: ${profile.name}.`);
  if (profile?.description) lines.push(`What this data represents: ${profile.description}`);
  if (profile?.scopeDescription) lines.push(`Data source: ${profile.scopeDescription}.`);

  // --- Terminology ---------------------------------------------------------
  const levelLabels = term?.levelLabels ?? [];
  if (term) {
    const parts: string[] = [];
    if (term.entityLabel) parts.push(`an asset is called a "${term.entityLabel}"`);
    if (term.metricIdLabel) parts.push(`a signal is called a "${term.metricIdLabel}"`);
    if (parts.length) lines.push(`Terminology: ${parts.join('; ')}.`);
    if (levelLabels.length) {
      lines.push(
        `Hierarchy levels (top → bottom): ${levelLabels
          .map((l, i) => `level${i + 1}="${l}"`)
          .join(', ')}.`,
      );
    }
  }

  // --- Catalog size --------------------------------------------------------
  if (tags.length) {
    const metricCount = distinctCount(tags, 'metric');
    lines.push(
      `Catalog (RLS-scoped to you): ${tags.length} signal(s) across ${metricCount} distinct metric(s).`,
    );

    // --- Hierarchy snapshot: top level-1 nodes with tag counts -------------
    const level1Counts = new Map<string, number>();
    let noLevel1 = 0;
    for (const t of tags) {
      const v = t.level1;
      if (typeof v === 'string' && v.trim()) level1Counts.set(v, (level1Counts.get(v) ?? 0) + 1);
      else noLevel1 += 1;
    }
    if (level1Counts.size) {
      const l1Label = levelLabels[0] || 'level1';
      const sorted = [...level1Counts.entries()].sort((a, b) => b[1] - a[1]);
      const shown = sorted.slice(0, TOP_LEVEL1_NODES);
      const remainder = sorted.length - shown.length;
      const listed = shown.map(([name, n]) => `${name} (${n})`).join(', ');
      let snapshot = `Top ${l1Label} nodes by signal count: ${listed}`;
      if (remainder > 0) {
        const remTags = sorted.slice(TOP_LEVEL1_NODES).reduce((s, [, n]) => s + n, 0);
        snapshot += `, and ${remainder} more ${l1Label} node(s) (${remTags} signals)`;
      }
      snapshot +=
        `. This is a summary only — use browse_asset_hierarchy to drill into any node ` +
        `and resolve_tags to find specific signals.`;
      lines.push(snapshot);
      if (noLevel1 > 0) lines.push(`${noLevel1} signal(s) have no ${l1Label} assignment.`);
    }
  }

  // --- Deep Discovery pointer ---------------------------------------------
  lines.push(
    'Beyond the fast interactive tools, the app offers long-running Deep Discovery ' +
      '(Matrix Profile) recipes on the Patterns page — e.g. finding normal cycles, ' +
      'anomalies, regime changes, degradation, and cross-sensor events. These run in ' +
      'the background (not headless), so OFFER the right recipe by name when a request ' +
      'calls for deep pattern mining, help set it up on the Patterns page, and hand the ' +
      'run off to the user.',
  );

  const body = lines.join('\n');
  return (
    '[Environment orientation for this conversation — situational context, not a user ' +
    'request. Use it to ground your reasoning and speak the user\'s terminology.\n' +
    body +
    ']'
  );
}
