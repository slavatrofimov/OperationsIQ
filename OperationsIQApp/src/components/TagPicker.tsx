import { useState } from 'react';
import {
  Field,
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  makeStyles,
  tokens,
  type InfoLabelProps,
} from '@fluentui/react-components';
import { ChevronDown16Regular } from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { withInfo } from './fieldInfo';
import { AdvancedTagSearch } from './AdvancedTagSearch';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTerminology } from '../hooks/useTerminology';

const useStyles = makeStyles({
  trigger: {
    width: '100%',
    justifyContent: 'space-between',
    fontWeight: tokens.fontWeightRegular,
  },
  triggerText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
    flex: 1,
  },
  placeholder: { color: tokens.colorNeutralForeground4 },
  surface: {
    width: '420px',
    maxWidth: '90vw',
    padding: tokens.spacingVerticalM,
  },
});

export interface TagPickerProps {
  /**
   * Field label. When omitted, the active connection's terminology is used
   * (its signal/metric-id label, pluralized for multiselect) so the entity is
   * named consistently everywhere. Pass an explicit label only for role-specific
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
 * Advanced, hierarchy-aware tag chooser. Renders a compact trigger (matching the
 * old dropdown footprint) that opens the reusable {@link AdvancedTagSearch} panel
 * in a popover: free-text search, facet filters and single/multi select. The
 * value contract is a `string[]` of tag ids, identical to the legacy TagSelect.
 */
export function TagPicker({
  label,
  tags,
  selected,
  onChange,
  multiselect = false,
  disabled,
  maxSelected,
  info,
}: TagPickerProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const labeler = useTagLabeler();
  const term = useTerminology();

  const entityLabel = label ?? (multiselect ? term.metricIdLabelPlural : term.metricIdLabel);
  const nameById = new Map(tags.map((t) => [t.tagId, t.tagName]));
  const displayText = selected.map((id) => labeler(id, nameById.get(id))).join(', ');
  const placeholder = multiselect
    ? `Select ${term.metricIdLabelPlural.toLowerCase()}`
    : `Select a ${term.metricIdLabel.toLowerCase()}`;

  return (
    <Field label={info ? withInfo(entityLabel, info) : entityLabel}>
      <Popover
        open={open}
        onOpenChange={(_, d) => setOpen(d.open)}
        trapFocus
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Button
            className={styles.trigger}
            disabled={disabled}
            iconPosition="after"
            icon={<ChevronDown16Regular />}
          >
            <span className={styles.triggerText}>
              {displayText || <span className={styles.placeholder}>{placeholder}</span>}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverSurface className={styles.surface}>
          <AdvancedTagSearch
            tags={tags}
            selected={selected}
            onChange={onChange}
            multiselect={multiselect}
            maxSelected={maxSelected}
            onCommitSingle={() => setOpen(false)}
          />
        </PopoverSurface>
      </Popover>
    </Field>
  );
}
