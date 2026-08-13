import { entity, role, uuid, text, decimal, one } from '@microsoft/rayfin-core';
import { VsmModel } from './VsmModel.js';

/**
 * One (class_label, word) -> weight term of a trained SAX-VSM model. On CLASSIFY
 * the client reads these rows and materializes them into an inline KQL
 * `datatable(class_label:string, word:string, weight:real)[...]` passed as the
 * Model argument to sax_vsm_classify. `user_id` is duplicated here so row-level
 * security can scope terms to the owner without a parent join.
 */
@entity()
@role('authenticated', '*', {
  policy: (claims, item) => claims.sub.eq(item.user_id),
})
export class VsmModelTerm {
  @uuid() id!: string;
  @text() user_id!: string;
  @uuid() vsm_model_id!: string; // FK -> VsmModel
  @one(() => VsmModel) vsm_model?: VsmModel;
  @text() class_label!: string;
  @text() word!: string;
  @decimal() weight!: number;
}
