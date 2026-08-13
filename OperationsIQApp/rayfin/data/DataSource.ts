import { entity, role, uuid, text, decimal, date, many } from '@microsoft/rayfin-core';
import { Signal } from './Signal.js';

/**
 * A registered KQL / Eventhouse source of raw sensor time series (design spec §5).
 *
 * Only the connection + column mapping metadata lives here; the raw series stay in the
 * KQL database. This is a shared workspace catalog, so every authenticated user can
 * read and register sources. Restricting registration to a data-engineer role requires
 * a custom DAB role (the typed `@role` decorator supports the built-in `authenticated`
 * role only) and is applied at deploy time (design spec §9 hardening).
 */
@entity()
@role('authenticated', ['create', 'read', 'update', 'delete'])
export class DataSource {
  @uuid() id!: string;

  /** Human-readable name shown in the source picker, e.g. "Plant-A Vibration". */
  @text({ min: 1, max: 200 }) name!: string;

  /** KQL cluster query URI, e.g. https://<cluster>.kusto.fabric.microsoft.com. */
  @text() kqlClusterUri!: string;

  /** KQL database name that holds the sensor table. */
  @text() database!: string;

  /** Source table name within the database. */
  @text() table!: string;

  /** Column holding the sample timestamp. */
  @text() timeColumn!: string;

  /** Column holding the sensor reading. */
  @text() valueColumn!: string;

  /** Optional column that distinguishes tags/signals within a single table. */
  @text({ optional: true }) tagColumn?: string;

  /** Default sampling rate (Hz) used to convert "pattern length in seconds" -> m. */
  @decimal({ min: 0 }) defaultSampleRateHz!: number;

  /** System user id (claims.sub) of the registering data engineer. */
  @text() createdBy!: string;

  @date() createdAt!: Date;

  /** Signals (tags) discovered/registered under this source. */
  @many(() => Signal) signals?: Signal[];
}
