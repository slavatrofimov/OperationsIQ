import { annotationTypeColor } from './annotationTypes';
import { decodePathSegment } from './tagTree';

/** Shared color for Eventhouse-sourced events (single hue, distinct from types). */
export const EVENT_MARKER_COLOR = '#8764b8';

/** Origin of a timeline marker. */
export type MarkerSource = 'event' | 'annotation';

/**
 * A single timeline marker unifying an Eventhouse Event and an app Annotation so
 * the overview chart, the list, and the type filters all operate on one list.
 */
export interface TimelineMarker {
  source: MarkerSource;
  /** Unique across sources (prefixed by source). */
  id: string;
  /** EventType or annotation_type. */
  type: string;
  title: string;
  detail?: string | null;
  timestamp: Date;
  /** Null/undefined for a point marker. */
  endTimestamp?: Date | null;
  /** Friendly scope/tag label for the list. */
  scopeLabel: string;
  scopeType?: string;
  scopeId?: string;
  /** Marker color (event hue, or per-annotation-type color). */
  color: string;
  /** Present for annotations — enables edit/delete + author checks. */
  annotationId?: string;
  authorId?: string;
}

export interface TimelineRow {
  EventId: string;
  ScopeId: string;
  ScopeType: string;
  StartTimestamp: string | number | Date;
  EndTimestamp: string | number | Date | null;
  EventType: string;
  Title: string;
  Detail: string | null;
  Source: string;
  UserId: string;
}

/** Convert a canonical events-query row into a unified timeline marker. */
export function rowToMarker(r: TimelineRow, nameById: Map<string, string>): TimelineMarker {
  const source: MarkerSource = r.Source === 'Annotation' ? 'annotation' : 'event';
  return {
    source,
    id: `${source}:${r.EventId}`,
    type: r.EventType,
    title: r.Title,
    detail: r.Detail ?? null,
    timestamp: new Date(r.StartTimestamp),
    endTimestamp: r.EndTimestamp ? new Date(r.EndTimestamp) : null,
    scopeType: r.ScopeType,
    scopeId: r.ScopeId,
    scopeLabel:
      r.ScopeType === 'TagId'
        ? (nameById.get(r.ScopeId) ?? r.ScopeId)
        : (decodePathSegment(r.ScopeId.split('/').pop() || r.ScopeId)),
    color: source === 'annotation' ? annotationTypeColor(r.EventType) : EVENT_MARKER_COLOR,
    annotationId: source === 'annotation' ? r.EventId : undefined,
    authorId: r.UserId || undefined,
  };
}

/** A distinct (source, type) combination present in a marker set. */
export interface MarkerTypeGroup {
  key: string;
  source: MarkerSource;
  type: string;
  color: string;
  count: number;
}

/** Stable filter key for a marker's (source, type). */
export function markerTypeKey(source: MarkerSource, type: string): string {
  return `${source}:${type}`;
}

/**
 * Enumerate the distinct (source, type) groups present, with counts and colors,
 * for building the type-filter control. Events first, then annotations; each
 * group alphabetized by type.
 */
export function distinctMarkerTypes(markers: TimelineMarker[]): MarkerTypeGroup[] {
  const byKey = new Map<string, MarkerTypeGroup>();
  for (const m of markers) {
    const key = markerTypeKey(m.source, m.type);
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, { key, source: m.source, type: m.type, color: m.color, count: 1 });
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'event' ? -1 : 1;
    return a.type.localeCompare(b.type);
  });
}
