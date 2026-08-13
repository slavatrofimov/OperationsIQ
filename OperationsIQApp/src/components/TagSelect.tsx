import type { InfoLabelProps } from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { TagPicker } from './TagPicker';

export interface TagSelectProps {
  /**
   * Field label. When omitted, the active connection's terminology label is
   * used (see {@link TagPicker}). Pass an explicit label only for role-specific
   * pickers (e.g. "Target", "Feature").
   */
  label?: string;
  tags: TagInfo[];
  /** Selected tag ids. For single-select, an array of length 0 or 1. */
  selected: string[];
  onChange: (ids: string[]) => void;
  multiselect?: boolean;
  disabled?: boolean;
  /** Optional cap on the number of selected tags (multiselect only). */
  maxSelected?: number;
  /** Optional explanatory popover shown via an info button next to the label. */
  info?: InfoLabelProps['info'];
}

/**
 * Hierarchy-aware tag chooser backed by TagMetadata. Single or multi select.
 *
 * Thin backward-compatible wrapper over {@link TagPicker}: every existing call
 * site keeps the same `string[]` of tag ids contract but now gets the advanced
 * tag search experience (free-text search + facet filters + hierarchy tree).
 */
export function TagSelect(props: TagSelectProps) {
  return <TagPicker {...props} />;
}
