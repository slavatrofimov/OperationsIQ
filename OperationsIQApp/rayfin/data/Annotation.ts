import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A user-authored time-series annotation, stored in the app's SQL DB (Events,
 * by contrast, live in the KQL DB and are ingested externally). Rendered on the
 * exploration timeline alongside Events and UNIONed with them in the profile's
 * Events query.
 *
 * An annotation marks a point in time (when `end_timestamp` is null) or a span
 * (when `end_timestamp` is set). Its scope matches the Eventhouse Events schema:
 * `(scope_type, scope_id)` where `scope_type` is `TagId` for a single signal or
 * `Level1`..`LevelN` for a hierarchy node, and `scope_id` is the tag id or that
 * level's value. `user_id` and `created_at` are annotation-only additions used
 * for authoring and audit metadata.
 *
 * Visibility: every authenticated user can read all annotations (team-wide,
 * matching Events). Only the author (`user_id`) may update or delete their own.
 */
@entity()
@role('authenticated', ['read'])
@role('authenticated', ['create', 'update', 'delete'], {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class Annotation {
  @uuid() id!: string;

  /** System user id (claims.sub) of the author. Captured automatically. */
  @text() user_id!: string;

  /** Annotation type, one of the configured ANNOTATION_TYPES (see src/lib/annotationTypes.ts). */
  @text() annotation_type!: string;

  /** Short headline shown as the marker label and list title. */
  @text() title!: string;

  /** Optional long-form description shown on hover / in the list. */
  @text({ optional: true }) detail?: string;

  /** Start of the annotation (or the single point for point annotations). */
  @date() timestamp!: Date;

  /** End of the annotation span. Null for point annotations. */
  @date({ optional: true }) end_timestamp?: Date;

  /** Scope type: 'TagId' for one tag, or 'Level1'..'LevelN' for a hierarchy node. */
  @text() scope_type!: string;

  /** Scope id: the tag id for TagId scopes, or the selected level's value for LevelK scopes. */
  @text() scope_id!: string;

  /**
   * Owning Connection Profile id (the active profile's Fabric id), captured
   * automatically on create. Scopes each annotation to the Eventhouse schema it
   * was authored against so a single app instance + single shared SQL DB can
   * serve many profiles: the `AnnotationsExternal` external table (the OneLake
   * mirror of this table surfaced in the Eventhouse) is filtered by this column
   * in the connection profile's Events query, keeping one profile's annotations
   * out of another's timeline. Null for legacy rows authored before profile
   * scoping existed.
   */
  @text({ optional: true }) connection_profile_id?: string;

  /** Creation timestamp. Captured automatically. */
  @date() created_at!: Date;
}
