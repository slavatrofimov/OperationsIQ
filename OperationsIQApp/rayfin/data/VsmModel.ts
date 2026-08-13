import { entity, role, uuid, text, int, decimal, date } from '@microsoft/rayfin-core';

/**
 * Metadata for a trained SAX-VSM model. Term weights live in VsmModelTerm rows.
 * These parameters are passed straight through to sax_vsm_train / sax_vsm_classify.
 * `numerosity_reduction` is 'exact' (drop consecutive duplicate words) or 'none'.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class VsmModel {
  @uuid() id!: string;
  @text() user_id!: string;
  @text() name!: string;
  @int() window_size!: number;
  @int() paa_size!: number;
  @int() alphabet_size!: number;
  @decimal() znorm_threshold!: number;
  @text() numerosity_reduction!: string;
  /**
   * Connection profile this model was trained under (Fabric profile id). Scopes the
   * model so it is only surfaced under its owning profile. Optional for back-compat
   * with rows created before profile scoping (those are hidden until re-created).
   */
  @text({ optional: true }) connection_profile_id?: string;
  @date() created_at!: Date;
}
