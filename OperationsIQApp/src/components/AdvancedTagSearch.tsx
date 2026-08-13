import { useMemo, useState } from 'react';
import {
  Input,
  Checkbox,
  Radio,
  RadioGroup,
  Dropdown,
  Option,
  Button,
  Caption1,
  Body1,
  Badge,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ChevronRight16Regular,
  ChevronDown16Regular,
  Search16Regular,
} from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildTagTree, getHierarchyLevels, type TreeNode } from '../lib/tagTree';
import { getFacets, filterTags, isFilterActive, type TagFilter } from '../lib/tagSearch';
import { useProfile } from '../context/ProfileContext';
import { useCatalogMode } from '../context/CatalogContext';
import { useTagLabeler } from '../context/TagDisplayContext';
import { useTagSelectionLimit } from '../context/TagSelectionLimitContext';
import { isSelectionWithinLimit } from '../lib/tagSelection';
import { useTerminology } from '../hooks/useTerminology';
import { useCatalogSearch } from '../hooks/useCatalogSearch';
import { useLazyHierarchy } from '../hooks/useLazyHierarchy';
import type { LazyTreeNode } from '../lib/lazyTreeState';
import { VirtualList } from './VirtualList';
import { ServerFacetDropdown } from './ServerFacetDropdown';
import { getServerFacetDefs, facetContextFilter } from '../lib/catalogFacets';

/** Fixed row height (px) for the virtualized server-backed results list. */
const SERVER_ROW_HEIGHT = 28;
/** Max height (px) of the server-backed results viewport. */
const SERVER_LIST_MAX_HEIGHT = 400;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  searchRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  facetBar: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    alignItems: 'center',
  },
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
  facetLabel: {
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    width: '84px',
    lineHeight: tokens.lineHeightBase200,
  },
  facetDropdown: {
    minWidth: '90px',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
  },
  toolbar: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toolbarLeft: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  tree: {
    overflowY: 'auto',
    maxHeight: '440px',
    paddingRight: tokens.spacingHorizontalXS,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  groupRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: '1px 0',
  },
  caret: {
    minWidth: '18px',
    display: 'inline-flex',
    justifyContent: 'center',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
  },
  leafRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, padding: '0' },
  leafMeta: { color: tokens.colorNeutralForeground3 },
  empty: { padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 },
  serverRow: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
  },
  serverLabel: {
    display: 'block',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  },
  serverFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} 0`,
    minHeight: '24px',
  },
  serverCount: { color: tokens.colorNeutralForeground3 },
});

export interface AdvancedTagSearchProps {
  tags: TagInfo[];
  /** Selected tag ids. For single-select, an array of length 0 or 1. */
  selected: string[];
  onChange: (ids: string[]) => void;
  multiselect?: boolean;
  /**
   * Optional explicit cap on the number of selected tags (multiselect only).
   * When omitted, the app-wide tag-selection limit from settings is used.
   */
  maxSelected?: number;
  /** Called with the picked id in single-select mode (e.g. so a popover can close). */
  onCommitSingle?: (id: string) => void;
  /**
   * Server-backed search: query the catalog with `searchTags` (paged, debounced,
   * cancelable) and browse it via the lazy hierarchy tree instead of filtering
   * the in-memory `tags` array. When omitted, it is chosen automatically from the
   * connection's catalog size — `'large'` catalogs use the server-backed path,
   * small ones keep the instant in-memory behavior. Pass an explicit boolean only
   * to force one path (e.g. tests). In server mode the `tags` prop is used only to
   * label already-selected ids.
   */
  serverBacked?: boolean;
}

/**
 * Reusable advanced tag search: free-text search across id/name/metric/description,
 * facet filters (dynamic hierarchy levels + Metric + Engineering Units) and a
 * hierarchy-aware, multi- or single-select results tree. Shared by the popover
 * TagPicker and the inline TagBrowser so the experience is identical everywhere.
 */
export function AdvancedTagSearch({
  tags,
  selected,
  onChange,
  multiselect = false,
  maxSelected,
  onCommitSingle,
  serverBacked: serverBackedProp,
}: AdvancedTagSearchProps) {
  const styles = useStyles();
  const { activeProfile } = useProfile();
  const catalogMode = useCatalogMode();
  const labeler = useTagLabeler();
  const term = useTerminology();
  const globalLimit = useTagSelectionLimit();
  const [query, setQuery] = useState('');
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [limitError, setLimitError] = useState<string | null>(null);

  // Explicit prop wins (e.g. tests / forced modes); otherwise auto-switch to the
  // server-backed path once the size probe reports a large catalog.
  const serverBacked = serverBackedProp ?? catalogMode === 'large';

  // The effective cap for multi-select: an explicit prop overrides the app-wide
  // setting; single-select is never capped.
  const usingGlobalLimit = typeof maxSelected !== 'number';
  const effectiveLimit = multiselect
    ? (usingGlobalLimit ? globalLimit : maxSelected)
    : undefined;

  const hierarchyLevels = useMemo(
    () => getHierarchyLevels(activeProfile?.labels),
    [activeProfile],
  );

  // The in-memory facet/filter/tree pipeline is skipped entirely in server mode:
  // for a large catalog that work is exactly the O(n) main-thread cost we're
  // avoiding, and the server-backed UI never reads these. They stay memoized (and
  // active in small mode) so the legacy path is byte-for-byte unchanged.
  const facets = useMemo(
    () =>
      serverBacked
        ? []
        : getFacets(tags, hierarchyLevels, {
            unitsLabel: activeProfile?.labels?.unitOfMeasureLabel,
          }),
    [serverBacked, tags, hierarchyLevels, activeProfile],
  );

  // Server-backed facet definitions (shape only; values are fetched on demand).
  const serverFacetDefs = useMemo(
    () =>
      getServerFacetDefs(hierarchyLevels, {
        unitsLabel: activeProfile?.labels?.unitOfMeasureLabel,
      }),
    [hierarchyLevels, activeProfile],
  );

  const filter: TagFilter = useMemo(() => ({ query, selections }), [query, selections]);
  const active = isFilterActive(filter);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filteredTags = useMemo(
    () => (serverBacked ? [] : filterTags(tags, filter, facets)),
    [serverBacked, tags, filter, facets],
  );

  const tree = useMemo(
    () => (serverBacked ? [] : buildTagTree(filteredTags, hierarchyLevels)),
    [serverBacked, filteredTags, hierarchyLevels],
  );

  // Server-backed search (opt-in). Called unconditionally (hooks rule) but inert
  // unless `serverBacked` is set; free-text drives it, facet selections narrow it.
  const serverFilter = useMemo(
    () => ({ query, facetSelections: selections }),
    [query, selections],
  );
  // In server mode, an empty query with no facet selections means "browse": show
  // the lazy hierarchy tree. Any active filter switches to flat search results.
  const serverFiltersActive =
    query.trim().length > 0 || Object.values(selections).some((v) => v.length > 0);
  const serverBrowse = serverBacked && !serverFiltersActive;

  const server = useCatalogSearch({
    profile: activeProfile,
    filter: serverFilter,
    enabled: serverBacked && serverFiltersActive,
  });

  // Lazy, server-backed asset hierarchy for browsing (no query/facets active).
  const lazy = useLazyHierarchy({
    profile: activeProfile,
    levels: hierarchyLevels,
    enabled: serverBrowse,
  });

  const commitMulti = (next: Set<string>): boolean => {
    const ids = [...next];
    // Allow selections that stay within the (inclusive) cap, or that shrink the
    // current selection (e.g. deselecting) even if it was already over the cap.
    if (!isSelectionWithinLimit(ids.length, selected.length, effectiveLimit)) {
      const entity = term.metricIdLabelPlural.toLowerCase();
      setLimitError(
        usingGlobalLimit
          ? `You can select at most ${effectiveLimit} ${entity}. Narrow your selection, or raise the limit in Settings.`
          : `You can select at most ${effectiveLimit} ${entity} here. Narrow your selection.`,
      );
      return false;
    }
    setLimitError(null);
    onChange(ids);
    return true;
  };

  const toggleTag = (id: string) => {
    if (!multiselect) {
      onChange([id]);
      onCommitSingle?.(id);
      return;
    }
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commitMulti(next);
  };

  const setGroup = (node: TreeNode, checked: boolean) => {
    const next = new Set(selectedSet);
    for (const id of node.tagIds) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    commitMulti(next);
  };

  const setFacet = (key: string, values: string[]) => {
    setSelections((prev) => ({ ...prev, [key]: values }));
  };

  const clearFilters = () => {
    setQuery('');
    setSelections({});
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groupState = (node: TreeNode): boolean | 'mixed' => {
    const sel = node.tagIds.filter((id) => selectedSet.has(id)).length;
    if (sel === 0) return false;
    if (sel === node.tagIds.length) return true;
    return 'mixed';
  };

  // When filtering, auto-expand everything so matches are visible.
  const isExpanded = (id: string) => (active ? true : expanded.has(id));

  const renderLeaf = (t: TagInfo): JSX.Element => {
    const label = (
      <span>
        {labeler(t.tagId, t.tagName)}{' '}
        <Caption1 className={styles.leafMeta}>
          {t.metric}
          {t.engUnits ? ` (${t.engUnits})` : ''}
        </Caption1>
      </span>
    );
    return (
      <div key={t.tagId} className={styles.leafRow} style={{ marginLeft: 14 }}>
        <span className={styles.caret} />
        {multiselect ? (
          <Checkbox
            checked={selectedSet.has(t.tagId)}
            onChange={() => toggleTag(t.tagId)}
            label={label}
          />
        ) : (
          <Radio value={t.tagId} label={label} />
        )}
      </div>
    );
  };

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const open = isExpanded(node.id);
    const selCount = node.tagIds.filter((id) => selectedSet.has(id)).length;
    return (
      <div key={node.id} style={{ marginLeft: depth === 0 ? 0 : 14 }}>
        <div className={styles.groupRow}>
          <span
            className={styles.caret}
            onClick={() => toggleExpand(node.id)}
            role="button"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
          {multiselect ? (
            <Checkbox
              checked={groupState(node)}
              onChange={(_, d) => setGroup(node, d.checked === true)}
              label={
                <span>
                  {node.label}{' '}
                  <Badge appearance="tint" size="small">
                    {selCount}/{node.tagIds.length}
                  </Badge>
                </span>
              }
            />
          ) : (
            <span
              onClick={() => toggleExpand(node.id)}
              role="button"
              style={{ cursor: 'pointer' }}
            >
              {node.label}{' '}
              <Badge appearance="tint" size="small">
                {node.tagIds.length}
              </Badge>
            </span>
          )}
        </div>
        {open && (
          <div>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.tags.map((t) => renderLeaf(t))}
          </div>
        )}
      </div>
    );
  };

  const treeContent =
    tree.length === 0 ? (
      <Body1 className={styles.empty}>No tags match your search.</Body1>
    ) : (
      tree.map((n) => renderNode(n, 0))
    );

  // Server-backed rows are rendered at a fixed height in a virtualized list, so
  // the label is a single clipped line (name + metric/units) instead of the
  // wrapping client leaf. Long text ellipsizes rather than growing the row.
  const renderServerLeaf = (t: TagInfo): JSX.Element => {
    const label = (
      <span className={styles.serverLabel}>
        {labeler(t.tagId, t.tagName)}{' '}
        <Caption1 className={styles.leafMeta}>
          {t.metric}
          {t.engUnits ? ` (${t.engUnits})` : ''}
        </Caption1>
      </span>
    );
    return (
      <div className={styles.serverRow}>
        {multiselect ? (
          <Checkbox
            checked={selectedSet.has(t.tagId)}
            onChange={() => toggleTag(t.tagId)}
            label={label}
            style={{ minWidth: 0, width: '100%' }}
          />
        ) : (
          <Radio value={t.tagId} label={label} style={{ minWidth: 0, width: '100%' }} />
        )}
      </div>
    );
  };

  const serverEmpty = server.rows.length === 0 && !server.loading;

  const serverListBody = (
    <VirtualList
      items={server.rows}
      rowHeight={SERVER_ROW_HEIGHT}
      maxHeight={SERVER_LIST_MAX_HEIGHT}
      renderItem={(t) => renderServerLeaf(t)}
      itemKey={(t) => t.tagId}
      onNeedMore={server.loadMore}
    />
  );

  const serverRegion = serverEmpty ? (
    <Body1 className={styles.empty}>
      {server.error ? `Search failed: ${server.error}` : 'No tags match your search.'}
    </Body1>
  ) : (
    <>
      {multiselect ? (
        serverListBody
      ) : (
        <RadioGroup value={selected[0] ?? ''} onChange={(_, d) => toggleTag(d.value)}>
          {serverListBody}
        </RadioGroup>
      )}
      <div className={styles.serverFooter}>
        {server.loading ? (
          <Spinner size="tiny" label="Searching…" />
        ) : server.hasMore ? (
          <Button size="small" appearance="subtle" onClick={server.loadMore}>
            Load more
          </Button>
        ) : (
          <Caption1 className={styles.serverCount}>
            {server.rows.length} shown
          </Caption1>
        )}
      </div>
    </>
  );

  const filtersActive = serverBacked ? serverFiltersActive : active;

  // Lazy hierarchy browse tree (server mode, no active filter). Group nodes are
  // navigation-only (expand/collapse); tag-container nodes list selectable
  // signals with their own "Load more" paging.
  const renderLazyNode = (node: LazyTreeNode): JSX.Element => {
    const open = node.expanded;
    return (
      <div key={node.id} style={{ marginLeft: node.depth === 0 ? 0 : 14 }}>
        <div className={styles.groupRow}>
          <span
            className={styles.caret}
            onClick={() => lazy.toggle(node.id)}
            role="button"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
          <span
            onClick={() => lazy.toggle(node.id)}
            role="button"
            style={{ cursor: 'pointer' }}
          >
            {node.label}{' '}
            {typeof node.count === 'number' && (
              <Badge appearance="tint" size="small">
                {node.count}
              </Badge>
            )}
          </span>
        </div>
        {open && (
          <div style={{ marginLeft: 14 }}>
            {node.loading && <Spinner size="tiny" label="Loading…" />}
            {node.error && (
              <Body1 className={styles.empty}>Failed to load: {node.error}</Body1>
            )}
            {!node.isTagContainer &&
              node.childIds.map((cid) => {
                const child = lazy.state.nodes[cid];
                return child ? renderLazyNode(child) : null;
              })}
            {node.isTagContainer && (
              <>
                {node.tags.map((t) => renderLeaf(t))}
                {node.loaded && !node.loading && node.tags.length === 0 && (
                  <Body1 className={styles.empty}>No items here.</Body1>
                )}
                {node.hasMore && !node.loading && (
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => lazy.loadMore(node.id)}
                  >
                    Load more
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const lazyTreeBody = (
    <div className={styles.tree}>
      {lazy.state.rootLoading && <Spinner size="tiny" label="Loading…" />}
      {lazy.state.rootError && (
        <Body1 className={styles.empty}>Failed to load: {lazy.state.rootError}</Body1>
      )}
      {lazy.state.rootLoaded && lazy.state.rootIds.length === 0 && !lazy.state.rootLoading && (
        <Body1 className={styles.empty}>No asset hierarchy.</Body1>
      )}
      {lazy.state.rootIds.map((id) => {
        const node = lazy.state.nodes[id];
        return node ? renderLazyNode(node) : null;
      })}
    </div>
  );

  const lazyTreeRegion = multiselect ? (
    lazyTreeBody
  ) : (
    <RadioGroup value={selected[0] ?? ''} onChange={(_, d) => toggleTag(d.value)}>
      {lazyTreeBody}
    </RadioGroup>
  );

  return (
    <div className={styles.root}>
      <div className={styles.searchRow}>
        <Input
          contentBefore={<Search16Regular />}
          placeholder={`Search ${term.metricIdLabelPlural.toLowerCase()} by name, id, metric or description…`}
          value={query}
          onChange={(_, d) => setQuery(d.value)}
          style={{ flex: 1 }}
        />
      </div>

      {!serverBacked && facets.length > 0 && (
        <div className={styles.facetBar}>
          {facets.map((f) => {
            const value = selections[f.key] ?? [];
            return (
              <div key={f.key} className={styles.facet}>
                <Caption1 className={styles.facetLabel}>{f.label}</Caption1>
                <Dropdown
                  className={styles.facetDropdown}
                  style={{ minWidth: 0 }}
                  multiselect
                  selectedOptions={value}
                  value={value.join(', ')}
                  placeholder="Any"
                  onOptionSelect={(_, d) => setFacet(f.key, d.selectedOptions)}
                >
                  {f.values.map((v) => (
                    <Option key={v} value={v} text={v}>
                      {v}
                    </Option>
                  ))}
                </Dropdown>
              </div>
            );
          })}
        </div>
      )}

      {serverBacked && serverFacetDefs.length > 0 && activeProfile && (
        <div className={styles.facetBar}>
          {serverFacetDefs.map((f) => (
            <ServerFacetDropdown
              key={f.key}
              profile={activeProfile}
              facetKey={f.key}
              label={f.label}
              selected={selections[f.key] ?? []}
              onChange={(vals) => setFacet(f.key, vals)}
              context={facetContextFilter(f.key, selections)}
            />
          ))}
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <Caption1>
            {selected.length} selected
            {typeof effectiveLimit === 'number' ? ` / ${effectiveLimit}` : ''}
          </Caption1>
          {selected.length > 0 && multiselect && (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                setLimitError(null);
                onChange([]);
              }}
            >
              Clear selection
            </Button>
          )}
        </div>
        {filtersActive && (
          <Button size="small" appearance="subtle" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {limitError && (
        <MessageBar intent="warning">
          <MessageBarBody>{limitError}</MessageBarBody>
        </MessageBar>
      )}

      {serverBacked ? (
        serverBrowse ? lazyTreeRegion : serverRegion
      ) : (
        <div className={styles.tree}>
          {multiselect ? (
            treeContent
          ) : (
            <RadioGroup value={selected[0] ?? ''} onChange={(_, d) => toggleTag(d.value)}>
              {treeContent}
            </RadioGroup>
          )}
        </div>
      )}
    </div>
  );
}
