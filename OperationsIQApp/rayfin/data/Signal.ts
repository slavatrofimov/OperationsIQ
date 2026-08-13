import { entity, role, uuid, text, one } from '@microsoft/rayfin-core';
import { DataSource } from './DataSource.js';

/**
 * A logical tag (single measured channel) within a DataSource, e.g. "Pump-07
 * vibration" (design spec §5). Analyses and labels hang off a Signal.
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'])
export class Signal {
  @uuid() id!: string;

  /** Foreign key to the owning DataSource. */
  @uuid() dataSource_id!: string;
  @one(() => DataSource) dataSource?: DataSource;

  /** Tag/point name as it appears in the source's tag column. */
  @text({ min: 1, max: 200 }) tagName!: string;

  /** Engineering unit, e.g. "mm/s", "degC", "A". */
  @text({ optional: true, max: 50 }) unit?: string;

  @text({ optional: true, max: 1000 }) description?: string;
}
