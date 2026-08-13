import { client, getFabricAccountId } from './rayfinClient';
import { getActiveProfileId } from './activeConnection';
import type { TagInfo } from './tags';
import type { HierarchyLevel } from './tagTree';
import { encodePathSegment } from './tagTree';
import { DEFAULT_ANNOTATION_TYPE } from './annotationTypes';
import { queryRows } from './eventhouse';
import { buildEventsQuery } from './kql';
import { getQueryOffsetMinutes } from './queryTimezone';
import { rowToMarker, type TimelineMarker, type TimelineRow } from './timelineMarkers';

/** A resolved scope selection produced by the ScopeSelect control. */
export interface AnnotationScope {
  type: string;
  id: string;
  /** Friendly display label (hierarchy node label or tag name). */
  label: string;
}

export interface AnnotationCreateInput {
  annotationType: string;
  title: string;
  detail?: string;
  timestamp: Date;
  /** Omit / undefined for a point annotation. */
  endTimestamp?: Date;
  scope: AnnotationScope;
}

export interface AnnotationUpdateInput {
  annotationType?: string;
  title?: string;
  detail?: string;
  timestamp?: Date;
  /** Pass `null` to clear the end (turn a span into a point). */
  endTimestamp?: Date | null;
  scope?: AnnotationScope;
}

/** An annotation row as surfaced to the UI. */
export interface AnnotationData {
  id: string;
  user_id: string;
  annotation_type: string;
  title: string;
  detail?: string;
  timestamp: Date;
  end_timestamp?: Date;
  scope_type: string;
  scope_id: string;
  created_at: Date;
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const optDate = (v: unknown): Date | undefined => (v == null ? undefined : toDate(v));

/** Normalize a raw DB row into an {@link AnnotationData}. */
function toAnnotationData(r: Record<string, unknown>): AnnotationData {
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    annotation_type: String(r.annotation_type ?? DEFAULT_ANNOTATION_TYPE),
    title: String(r.title ?? ''),
    detail: r.detail != null ? String(r.detail) : undefined,
    timestamp: toDate(r.timestamp),
    end_timestamp: optDate(r.end_timestamp),
    scope_type: String(r.scope_type ?? ''),
    scope_id: String(r.scope_id ?? ''),
    created_at: toDate(r.created_at),
  };
}

/** Create a new annotation authored by the current user. */
export async function createAnnotation(input: AnnotationCreateInput): Promise<AnnotationData> {
  const userId = getFabricAccountId();
  if (!userId) throw new Error('Sign in with Fabric before adding an annotation.');

  const result = await client.data.Annotation.create({
    user_id: userId,
    annotation_type: input.annotationType,
    title: input.title,
    detail: input.detail ?? undefined,
    timestamp: input.timestamp,
    end_timestamp: input.endTimestamp ?? undefined,
    scope_type: input.scope.type,
    scope_id: input.scope.id,
    connection_profile_id: getActiveProfileId(),
    created_at: new Date(),
  });
  return toAnnotationData(result as unknown as Record<string, unknown>);
}

/** Update an existing annotation (author-only, enforced by RLS). */
export async function updateAnnotation(
  id: string,
  updates: AnnotationUpdateInput,
): Promise<AnnotationData> {
  const patch: Record<string, unknown> = {};
  if (updates.annotationType !== undefined) patch.annotation_type = updates.annotationType;
  if (updates.title !== undefined) patch.title = updates.title;
  if (updates.detail !== undefined) patch.detail = updates.detail;
  if (updates.timestamp !== undefined) patch.timestamp = updates.timestamp;
  if (updates.endTimestamp !== undefined) {
    patch.end_timestamp = updates.endTimestamp ?? undefined;
  }
  if (updates.scope !== undefined) {
    patch.scope_type = updates.scope.type;
    patch.scope_id = updates.scope.id;
  }
  const result = await client.data.Annotation.update({ id }, patch);
  return toAnnotationData(result as unknown as Record<string, unknown>);
}

/** Delete an annotation by id (author-only, enforced by RLS). */
export async function deleteAnnotation(id: string): Promise<void> {
  await client.data.Annotation.delete({ id });
}

/** Separator between ScopeType and ScopeId in a scope key (see {@link buildScopeKeys}). */
const SCOPE_KEY_SEP = '|#|';

/** Build the (ScopeType, ScopeId) keys for the unified events query. Hierarchy
 *  scopes match on the full cumulative path so repeated level names under
 *  different parents don't collide. */
export function buildScopeKeys(tags: TagInfo[], levels: readonly HierarchyLevel[]): string[] {
  const keys = new Set<string>();
  for (const tag of tags) {
    keys.add(`TagId${SCOPE_KEY_SEP}${tag.tagId}`);
    const parts: string[] = [];
    for (let i = 0; i < levels.length; i += 1) {
      const value = levels[i].get(tag)?.trim();
      if (!value) break; // stop at first unassigned level, like buildTagTree
      parts.push(encodePathSegment(value));
      keys.add(`Level${i + 1}${SCOPE_KEY_SEP}${parts.join('/')}`);
    }
  }
  return [...keys];
}

/** The Annotation columns the timeline reader needs. */
const ANNOTATION_TIMELINE_FIELDS = [
  'id', 'user_id', 'annotation_type', 'title', 'detail',
  'timestamp', 'end_timestamp', 'scope_type', 'scope_id', 'created_at',
] as const;

/** Turn a `"<ScopeType>|#|<ScopeId>"` key into a `(scope_type AND scope_id)` DAB clause. */
function scopeKeyToFilter(key: string): { and: Array<Record<string, unknown>> } {
  const i = key.indexOf(SCOPE_KEY_SEP);
  const scopeType = i === -1 ? key : key.slice(0, i);
  const scopeId = i === -1 ? '' : key.slice(i + SCOPE_KEY_SEP.length);
  return { and: [{ scope_type: { eq: scopeType } }, { scope_id: { eq: scopeId } }] };
}

/**
 * Load app annotations for the timeline **directly from the app SQL DB** (via the
 * RayFin/DAB client), rather than through the Eventhouse. This makes annotations
 * appear immediately regardless of OneLake-mirror latency and removes the need to
 * hand-wire an `external_table("Annotations")` UNION into the profile's Events
 * query — mirroring how governed Signal Metadata is already overlaid client-side.
 *
 * **All filtering is pushed to the database** so we retrieve only in-scope rows,
 * never the whole table:
 *   - `connection_profile_id == <active profile>` (multi-profile isolation),
 *   - the `(scope_type, scope_id)` pairs for the selected tags / hierarchy nodes,
 *   - a time-window overlap identical to the Events query: `timestamp <= end` and
 *     (point → `timestamp >= start`; span → `end_timestamp >= start`).
 *
 * Returned markers are shifted by the active query offset so they land in the
 * same chart-space wall clock as Eventhouse events (whose timestamps the KQL
 * builder shifts by the same +offset). Returns `[]` when no profile is active or
 * no scope keys are supplied.
 */
export async function loadAnnotationMarkers(
  scopeKeys: string[],
  range: { start: Date; end: Date },
  nameById: Map<string, string>,
): Promise<TimelineMarker[]> {
  const profileId = getActiveProfileId();
  if (!profileId || scopeKeys.length === 0) return [];

  const rows = (await client.data.Annotation.select([...ANNOTATION_TIMELINE_FIELDS])
    .where({
      and: [
        { connection_profile_id: { eq: profileId } },
        // Time-window overlap (offsets cancel, so compare raw instants directly).
        { timestamp: { lte: range.end } },
        {
          or: [
            { end_timestamp: { isNull: true }, timestamp: { gte: range.start } },
            { end_timestamp: { gte: range.start } },
          ],
        },
        // Only the selected (scope_type, scope_id) pairs.
        { or: scopeKeys.map(scopeKeyToFilter) },
      ],
    } as never)
    .execute()) as unknown as Array<Record<string, unknown>>;

  const offsetMin = getQueryOffsetMinutes();
  const shift = (d: Date): Date => (offsetMin === 0 ? d : new Date(d.getTime() + offsetMin * 60_000));

  return rows.map((r) => {
    const start = shift(toDate(r.timestamp));
    const end = r.end_timestamp != null ? shift(toDate(r.end_timestamp)) : null;
    const row: TimelineRow = {
      EventId: String(r.id),
      ScopeId: String(r.scope_id ?? ''),
      ScopeType: String(r.scope_type ?? ''),
      StartTimestamp: start,
      EndTimestamp: end,
      EventType: String(r.annotation_type ?? DEFAULT_ANNOTATION_TYPE),
      Title: String(r.title ?? ''),
      Detail: r.detail != null ? String(r.detail) : null,
      Source: 'Annotation',
      UserId: r.user_id != null ? String(r.user_id) : '',
    };
    return rowToMarker(row, nameById);
  });
}

/**
 * Load the unified timeline for the given scoped tags and time range: Eventhouse
 * events (KQL) merged with app annotations (SQL DB, server-side filtered). Both
 * sources arrive in chart space already, so they map straight into markers with
 * no client-side re-shift. Fetched in parallel.
 *
 * Markers are de-duplicated by id so a legacy profile whose Events query still
 * UNIONs `external_table("Annotations")` doesn't double-count — the authoritative
 * SQL-sourced annotation wins over any KQL-sourced copy of the same id.
 */
export async function loadTimeline(
  tags: TagInfo[],
  levels: readonly HierarchyLevel[],
  range: { start: Date; end: Date },
  nameById: Map<string, string>,
): Promise<TimelineMarker[]> {
  if (tags.length === 0) return [];
  const keys = buildScopeKeys(tags, levels);
  if (keys.length === 0) return [];

  const [eventRows, annotationMarkers] = await Promise.all([
    queryRows<TimelineRow>(buildEventsQuery(keys, range.start, range.end)),
    loadAnnotationMarkers(keys, range, nameById),
  ]);

  const byId = new Map<string, TimelineMarker>();
  for (const row of eventRows) {
    const m = rowToMarker(row, nameById);
    byId.set(m.id, m);
  }
  for (const m of annotationMarkers) byId.set(m.id, m); // SQL annotations win over any KQL copy.

  const markers = [...byId.values()];
  markers.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return markers;
}
