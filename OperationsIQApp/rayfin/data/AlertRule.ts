import { entity, uuid, text, date, role } from '@microsoft/rayfin-core';

@entity()
@role('authenticated', '*', { policy: (claims: any, item: any) => claims.sub.eq(item.user_id) })
export class AlertRule {
  @uuid() id!: string;
  @text() user_id!: string;
  @text() name!: string;
  @text() tag_id!: string;
  @text() condition_type!: string; // 'threshold_above' | 'threshold_below' | 'deviation_band' | 'rate_of_change'
  @text() params_json!: string; // JSON: { threshold?, confidence?, window?, ratePerMinute? }
  @text({ optional: true }) notification_type?: string; // 'email' | 'teams'
  @text({ optional: true }) notification_target?: string; // email address or teams webhook
  @text() status!: string; // 'active' | 'paused' | 'triggered'
  @date() created_at!: Date;
  @date({ optional: true }) last_triggered_at?: Date;
}