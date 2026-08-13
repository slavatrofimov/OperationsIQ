/**
 * Single source of truth for annotation types. The Type drop-down in the
 * annotation overlay, the timeline markers, the legend, and the type filters all
 * read from here so adding or renaming a type is a one-line change.
 *
 * To make types user-configurable in the future, replace ANNOTATION_TYPES with a
 * loader that merges these defaults with a persisted list; every consumer already
 * goes through {@link annotationTypeColor} / {@link isKnownAnnotationType}.
 */

export interface AnnotationTypeDef {
  /** Stored value (also the dropdown option value). */
  value: string;
  /** Display label. */
  label: string;
  /** Marker/legend color (hex). */
  color: string;
}

/** Ordered list of supported annotation types. Edit freely to add/rename. */
export const ANNOTATION_TYPES: readonly AnnotationTypeDef[] = [
  { value: 'Maintenance', label: 'Maintenance', color: '#2563eb' },
  { value: 'Inspection', label: 'Inspection', color: '#0891b2' },
  { value: 'Incident', label: 'Incident', color: '#dc2626' },
  { value: 'Downtime', label: 'Downtime', color: '#b45309' },
  { value: 'Configuration Change', label: 'Configuration Change', color: '#7c3aed' },
  { value: 'Quality Issue', label: 'Quality Issue', color: '#db2777' },
  { value: 'Observation', label: 'Observation', color: '#16a34a' },
  { value: 'Note', label: 'Note', color: '#6b7280' },
];

/** Default type used when none is chosen. */
export const DEFAULT_ANNOTATION_TYPE = ANNOTATION_TYPES[0].value;

/** Fallback color for annotations whose type is not in the known list. */
export const UNKNOWN_ANNOTATION_COLOR = '#6b7280';

const TYPE_BY_VALUE = new Map(ANNOTATION_TYPES.map((t) => [t.value, t]));

/** Resolve a type's marker color, falling back for unknown/legacy values. */
export function annotationTypeColor(type: string | undefined | null): string {
  if (!type) return UNKNOWN_ANNOTATION_COLOR;
  return TYPE_BY_VALUE.get(type)?.color ?? UNKNOWN_ANNOTATION_COLOR;
}

/** True when the value matches a configured annotation type. */
export function isKnownAnnotationType(type: string): boolean {
  return TYPE_BY_VALUE.has(type);
}
