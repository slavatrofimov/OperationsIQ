import { useMemo } from 'react';
import { Body1, Caption1, makeStyles, tokens } from '@fluentui/react-components';
import type { TagInfo } from '../lib/tags';
import { AdvancedTagSearch } from './AdvancedTagSearch';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTerminology } from '../hooks/useTerminology';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  selectedSummary: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  label: { color: tokens.colorNeutralForeground3 },
  names: { wordBreak: 'break-word' },
});

export interface TagBrowserProps {
  tags: TagInfo[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

/**
 * Inline, groupable asset tree with free-text search, facet filters and
 * multi-select for tags. Thin wrapper over the shared {@link AdvancedTagSearch}
 * panel so the embedded ExplorePage browser and the popover TagPicker offer the
 * exact same advanced search experience.
 *
 * Because the tree can be long and collapsed, it's easy to lose track of what's
 * currently selected. So — mirroring the comma-delimited value the popover
 * {@link TagPicker} shows on its trigger — we surface an always-visible summary
 * of the selected tag names above the tree.
 */
export function TagBrowser({ tags, selected, onChange }: TagBrowserProps) {
  const styles = useStyles();
  const labeler = useTagLabeler();
  const term = useTerminology();

  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);
  const selectedNames = useMemo(
    () => selected.map((id) => labeler(id, nameById.get(id))),
    [selected, labeler, nameById],
  );

  return (
    <div className={styles.root}>
      {selected.length > 0 && (
        <div className={styles.selectedSummary}>
          <Caption1 className={styles.label}>
            Selected {term.metricIdLabelPlural.toLowerCase()} ({selected.length})
          </Caption1>
          <Body1 className={styles.names}>{selectedNames.join(', ')}</Body1>
        </div>
      )}
      <AdvancedTagSearch tags={tags} selected={selected} onChange={onChange} multiselect />
    </div>
  );
}
