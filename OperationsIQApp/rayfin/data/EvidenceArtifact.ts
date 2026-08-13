import { entity, role, uuid, text, int, date, one } from '@microsoft/rayfin-core';
import { Evidence } from './Evidence.js';

/**
 * A binary/textual artifact belonging to a piece of {@link Evidence}. Each
 * ECharts graph on a captured page is stored as a `png` (the chart image,
 * base64-encoded without the data-URL prefix) and a `csv` (the chart's
 * underlying plotted data); the page's Markdown snapshot is stored as one or
 * more `markdown` artifacts (ordinal 0).
 *
 * Large content is split into <= ~40 KB chunks across multiple rows sharing the
 * same (kind, ordinal) and ordered by `seq`, because the backend caps a single
 * GraphQL mutation at 64 KB. The client reassembles chunks in `seq` order on
 * read. One chunk per row keeps every write comfortably under the cap.
 *
 * Row-level security mirrors the owning Evidence via `user_id`.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class EvidenceArtifact {
  @uuid() id!: string;

  /** Foreign key to the owning Evidence row. */
  @uuid() evidence_id!: string;
  @one(() => Evidence) evidence?: Evidence;

  @text() user_id!: string;
  /** 'png' | 'csv' | 'markdown'. */
  @text() kind!: string;
  /** Chart title (best-effort). */
  @text() title!: string;
  /** MIME type, e.g. image/png or text/csv. */
  @text() mime!: string;
  /** Logical index within the page (chart number; 0 for markdown). */
  @int() ordinal!: number;
  /** Chunk sequence within one (kind, ordinal), 0-based. */
  @int() seq!: number;
  /** One chunk of the content (see class doc); base64 for png, text otherwise. */
  @text() content!: string;

  @date() created_at!: Date;
}
