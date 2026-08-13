import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A saved Exploration view: the full set of tags, time range, and visualization
 * settings a user has configured on the Explore tab, so they can reload it
 * later. `config_json` is the serialized {@link ExploreConfigSnapshot} produced
 * by the client (src/lib/savedViews.ts).
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class SavedView {
  @uuid() id!: string;
  @text() user_id!: string;
  @text() name!: string;
  @text() config_json!: string;
  /**
   * Connection profile this view was saved under (Fabric profile id). Scopes the
   * view so it is only surfaced under its owning profile. Optional for back-compat
   * with rows created before profile scoping (those are hidden until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;
  @date() created_at!: Date;
}
