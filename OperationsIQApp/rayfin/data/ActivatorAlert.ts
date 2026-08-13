import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * App-side POINTER to a Fabric Activator (Reflex) alert created from a SAX
 * similarity search. This row records only enough metadata to list the alert
 * and deep-link to it in the Fabric portal — the authoritative rule, schedule,
 * and action live in the Fabric Reflex item itself. Deleting this row removes
 * ONLY the pointer; it never touches the Fabric Reflex item.
 *
 * Row-level security: only the owning user can read/write their pointers.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class ActivatorAlert {
  @uuid() id!: string;
  @text() user_id!: string;
  /** Fabric workspace that owns the Reflex item. */
  @text() workspace_id!: string;
  /** Fabric item id of the created Reflex (Activator). */
  @text() reflex_item_id!: string;
  /** Display name of the rule / Reflex item. */
  @text() display_name!: string;
  /** Deep link that opens the Activator item in the Fabric portal. */
  @text() web_url!: string;
  /** Name of the connection profile the search ran against. */
  @text() connection_profile_name!: string;
  /** JSON-serialised array of the searched signal/tag ids. */
  @text() tags_json!: string;
  /** Run-frequency key (e.g. "15m"). */
  @text() frequency!: string;
  /** JSON snapshot of the search parameters (SAX + binning + mode) for reproducibility. */
  @text({ optional: true }) search_params_json?: string;
  @date() created_at!: Date;
}
