import { entity, role, uuid, text, date } from '@microsoft/rayfin-core';

/**
 * A reusable label taxonomy entry per workspace (design spec §5, §7.5), e.g.
 * "Bearing fault", "Healthy cycle". Shared org-wide for consistent labeling; owner-only
 * edit/delete is a per-action DAB policy applied at deploy time (design spec §9).
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'])
export class LabelCategory {
  @uuid() id!: string;

  @text({ min: 1, max: 100, unique: true }) name!: string;

  /** Display color (hex) used for all labels in this category. */
  @text({ max: 9 }) color!: string;

  @text({ optional: true, max: 500 }) description?: string;

  /** System user id (claims.sub) of the creator. */
  @text() createdBy!: string;

  @date() createdAt!: Date;
}
