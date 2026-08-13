import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * An Investigation: a named, described multi-step analysis session that acts as
 * the container ("evidence pack") for captured page snapshots ({@link Evidence}).
 * Row-level security: only the owning user can read/write their investigations.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Investigation {
  @uuid() id!: string;
  @text() user_id!: string;
  @text() name!: string;
  @text({ optional: true }) description?: string;
  /**
   * Connection profile this investigation was created under (Fabric profile id).
   * Scopes the investigation so it is only surfaced under its owning profile.
   * Optional for back-compat with rows created before profile scoping (those are
   * hidden until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;
  @date() created_at!: Date;
  @date() updated_at!: Date;
}
