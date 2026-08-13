import { entity, role, uuid, text, date, one } from '@microsoft/rayfin-core';
import { Investigation } from './Investigation.js';

/**
 * A single captured page snapshot saved into an {@link Investigation}. Stores the
 * Markdown representation of the page's main content and the user's annotation.
 * The ECharts graphs on the page are stored as separate {@link EvidenceArtifact}
 * rows.
 *
 * Row-level security: only the owning user can read/write their evidence.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Evidence {
  @uuid() id!: string;

  /** Foreign key to the owning Investigation. */
  @uuid() investigation_id!: string;
  @one(() => Investigation) investigation?: Investigation;

  @text() user_id!: string;
  /** Which app page this evidence was captured from (PageKey). */
  @text() page_key!: string;
  /** Human-friendly page name (PAGE_LABELS[pageKey]). */
  @text() page_name!: string;
  /** Display name / email of the capturing user. */
  @text() user_name!: string;
  /** The user's free-text annotation / comments about this page. */
  @text({ optional: true }) annotation?: string;
  /**
   * Markdown snapshot of the page's main content is stored as chunked
   * `markdown` {@link EvidenceArtifact} rows (to stay under the backend's 64 KB
   * per-mutation cap). This column is retained for backward compatibility and
   * small snapshots but is generally left empty.
   */
  @text({ optional: true }) markdown?: string;

  @date() created_at!: Date;
}
