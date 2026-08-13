import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A saved Derived-metric definition the user can reload on the Derived tab.
 * It captures the base tags (in alias order A, B, C…), the arithmetic formula,
 * the post-transform, and the binning budget. `definition_json` is the
 * serialized {@link DerivedMetricDefinition} produced by the client
 * (src/lib/savedDerivedMetrics.ts).
 *
 * Derived metrics are specific to a Connection Profile — the referenced tags
 * only exist within a given Eventhouse schema — so each row is scoped to a
 * `profile_id` in addition to the owning user. Row-level security: only the
 * owning user can read/write.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class SavedDerivedMetric {
  @uuid() id!: string;
  @text() user_id!: string;
  /** The Connection Profile this derived metric belongs to. */
  @text() profile_id!: string;
  @text() name!: string;
  /** JSON-serialised DerivedMetricDefinition object. */
  @text() definition_json!: string;
  @date() created_at!: Date;
}
