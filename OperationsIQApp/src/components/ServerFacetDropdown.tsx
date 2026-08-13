import { useMemo, useState } from 'react';
import {
  Combobox,
  Option,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ConnectionProfile } from '../lib/connectionProfile';
import type { CatalogFilter } from '../lib/catalog';
import { useCatalogFacetValues } from '../hooks/useCatalogFacetValues';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

const useStyles = makeStyles({
  facet: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '190px',
    minWidth: '170px',
  },
  label: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    width: '84px',
    lineHeight: tokens.lineHeightBase200,
  },
  combobox: {
    minWidth: '90px',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  count: { color: tokens.colorNeutralForeground3 },
});

export interface ServerFacetDropdownProps {
  profile: ConnectionProfile;
  /** Facet/level key (mapped to a Catalog column server-side). */
  facetKey: string;
  /** Human label shown beside the control. */
  label: string;
  /** Currently selected values for this facet. */
  selected: string[];
  /** Called with the new selection when the user toggles values. */
  onChange: (values: string[]) => void;
  /** Context filter (other active facets) so values cross-filter sensibly. */
  context: CatalogFilter;
}

/**
 * A single server-backed facet control: a multiselect Combobox whose options are
 * the facet's distinct values, fetched on demand (and type-ahead filtered) via
 * `useCatalogFacetValues`. Values load only while the dropdown is open, so a
 * closed facet does no work. Already-selected values are always shown at the top
 * (so they remain de-selectable even if they fall outside the fetched page), and
 * the current selection count surfaces in the placeholder since the input is used
 * for the type-ahead text.
 */
export function ServerFacetDropdown({
  profile,
  facetKey,
  label,
  selected,
  onChange,
  context,
}: ServerFacetDropdownProps) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const debouncedText = useDebouncedValue(text, 250);

  const { values, loading, error } = useCatalogFacetValues({
    profile,
    facetKey,
    prefix: debouncedText,
    filter: context,
    enabled: open,
  });

  // Selected values first (always toggleable), then the fetched values that
  // aren't already selected.
  const options = useMemo(() => {
    const selSet = new Set(selected);
    const merged: Array<{ value: string; count?: number }> = selected.map((v) => ({ value: v }));
    for (const cv of values) {
      if (!selSet.has(cv.value)) merged.push({ value: cv.value, count: cv.count });
    }
    return merged;
  }, [selected, values]);

  const showEmpty = !loading && !error && options.length === 0;

  return (
    <div className={styles.facet}>
      <Caption1 className={styles.label}>{label}</Caption1>
      <Combobox
        className={styles.combobox}
        style={{ minWidth: 0 }}
        multiselect
        placeholder={selected.length ? `${selected.length} selected` : 'Any'}
        selectedOptions={selected}
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onOpenChange={(_, d) => {
          setOpen(d.open);
          if (!d.open) setText('');
        }}
        onOptionSelect={(_, d) => onChange(d.selectedOptions)}
      >
        {loading && (
          <Option key="__loading" value="__loading" disabled text="">
            Searching…
          </Option>
        )}
        {!loading && error && (
          <Option key="__error" value="__error" disabled text="">
            Couldn’t load values
          </Option>
        )}
        {showEmpty && (
          <Option key="__empty" value="__empty" disabled text="">
            No values
          </Option>
        )}
        {options.map((o) => (
          <Option key={o.value} value={o.value} text={o.value}>
            {o.value}
            {typeof o.count === 'number' ? (
              <Caption1 className={styles.count}>{` (${o.count})`}</Caption1>
            ) : (
              ''
            )}
          </Option>
        ))}
      </Combobox>
    </div>
  );
}
