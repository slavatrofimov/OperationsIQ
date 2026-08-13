import { useMemo, useState } from 'react';
import {
  Field,
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Input,
  Caption1,
  Body1,
  Badge,
  Spinner,
  makeStyles,
  tokens,
  type InfoLabelProps,
} from '@fluentui/react-components';
import {
  ChevronRight16Regular,
  ChevronDown16Regular,
  Search16Regular,
  Tag16Regular,
  Folder16Regular,
} from '@fluentui/react-icons';
import type { TagInfo } from '../lib/tags';
import { buildTagTree, getHierarchyLevels, splitScopePath, tagMatches, type TreeNode } from '../lib/tagTree';
import type { AnnotationScope } from '../lib/annotations';
import { useProfile } from '../context/ProfileContext';
import { useCatalogMode } from '../context/CatalogContext';
import { useLazyHierarchy } from '../hooks/useLazyHierarchy';
import { useCatalogSearch } from '../hooks/useCatalogSearch';
import type { LazyTreeNode } from '../lib/lazyTreeState';
import { useTerminology } from '../hooks/useTerminology';
import { withInfo } from './fieldInfo';

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
  surface: { width: '420px', maxWidth: '90vw', padding: tokens.spacingVerticalM },
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  tree: {
    overflowY: 'auto',
    maxHeight: '360px',
    paddingRight: tokens.spacingHorizontalXS,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: '2px 4px',
    borderRadius: tokens.borderRadiusSmall,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
  },
  caret: {
    minWidth: '20px',
    display: 'inline-flex',
    justifyContent: 'center',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground3,
  },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  leafMeta: { color: tokens.colorNeutralForeground3 },
  empty: { padding: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 },
});

export interface ScopeSelectProps {
  label: string;
  tags: TagInfo[];
  value: AnnotationScope | null;
  onChange: (scope: AnnotationScope) => void;
  disabled?: boolean;
  info?: InfoLabelProps['info'];
}

/**
 * Hierarchy-aware scope chooser for annotations. ANY node in the tree is
 * selectable: a group node (non-leaf) becomes a `hierarchy` scope covering
 * everything beneath it, while a leaf becomes a `tag` scope. Captures the full
 * '/'-joined path so a scope like "Plant A/Factory 1" is unambiguous.
 */
export function ScopeSelect({ label, tags, value, onChange, disabled, info }: ScopeSelectProps) {
  const styles = useStyles();
  const { activeProfile } = useProfile();
  const term = useTerminology();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const levels = useMemo(() => getHierarchyLevels(activeProfile?.labels), [activeProfile]);

  // For very large catalogs the full `tags` array is not a reliable source (the
  // page passes only a resolved subset), so switch to a server-backed lazy tree
  // + server search instead of building an in-memory tree over every tag.
  const catalogMode = useCatalogMode();
  const serverBacked = catalogMode === 'large';

  const filteredTags = useMemo(() => {
    if (serverBacked) return [];
    const q = query.trim();
    if (!q) return tags;
    return tags.filter((t) => tagMatches(t, q));
  }, [serverBacked, tags, query]);

  const tree = useMemo(
    () => (serverBacked ? [] : buildTagTree(filteredTags, levels)),
    [serverBacked, filteredTags, levels],
  );
  const filtering = query.trim().length > 0;

  // Server-backed data sources (only active in large mode while the popover is
  // open). With no query we browse the lazy hierarchy; a query switches to a
  // flat, paged server search.
  const trimmedQuery = query.trim();
  const serverSearching = serverBacked && trimmedQuery.length > 0;
  const lazy = useLazyHierarchy({
    profile: activeProfile,
    levels,
    enabled: serverBacked && open && !serverSearching,
  });
  const serverSearch = useCatalogSearch({
    profile: activeProfile,
    filter: { query: trimmedQuery },
    enabled: serverSearching && open,
  });

  const selectNode = (node: TreeNode) => {
    onChange({ type: `Level${node.level + 1}`, id: node.id, label: node.label });
    setOpen(false);
  };
  const selectTag = (tag: TagInfo) => {
    onChange({
      type: 'TagId',
      id: tag.tagId,
      label: tag.tagName,
    });
    setOpen(false);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const isExpanded = (id: string) => (filtering ? true : expanded.has(id));

  const isNodeSelected = (node: TreeNode) =>
    value?.type === `Level${node.level + 1}` && value.id === node.id;
  const isTagSelected = (tag: TagInfo) => value?.type === 'TagId' && value.id === tag.tagId;

  const renderLeaf = (t: TagInfo, depth: number): JSX.Element => (
    <div
      key={t.tagId}
      className={`${styles.row} ${isTagSelected(t) ? styles.rowSelected : ''}`}
      style={{ marginLeft: 16 * (depth + 1) }}
      role="button"
      onClick={() => selectTag(t)}
    >
      <span className={styles.caret}>
        <Tag16Regular />
      </span>
      <span className={styles.label}>
        {t.tagName}{' '}
        <Caption1 className={styles.leafMeta}>
          {t.metric}
          {t.engUnits ? ` (${t.engUnits})` : ''}
        </Caption1>
      </span>
    </div>
  );

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const opened = isExpanded(node.id);
    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${isNodeSelected(node) ? styles.rowSelected : ''}`}
          style={{ marginLeft: 16 * depth }}
        >
          <span
            className={styles.caret}
            role="button"
            aria-label={opened ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(node.id);
            }}
          >
            {opened ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
          <span
            className={styles.label}
            role="button"
            onClick={() => selectNode(node)}
            title={`Scope to ${splitScopePath(node.id).join('/')}`}
          >
            <Folder16Regular style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {node.label}{' '}
            <Badge appearance="tint" size="small">
              {node.tagIds.length}
            </Badge>
          </span>
        </div>
        {opened && (
          <div>
            {node.children.map((c) => renderNode(c, depth + 1))}
            {node.tags.map((t) => renderLeaf(t, depth))}
          </div>
        )}
      </div>
    );
  };

  const displayText = value ? value.label : '';

  const selectLazyNode = (node: LazyTreeNode) => {
    onChange({ type: `Level${node.depth + 1}`, id: node.id, label: node.label });
    setOpen(false);
  };
  const isLazyNodeSelected = (node: LazyTreeNode) =>
    value?.type === `Level${node.depth + 1}` && value.id === node.id;

  // Server-backed lazy hierarchy node (large mode). The caret expands/collapses
  // (fetching children or signals on first open); clicking the label selects the
  // node as a `Level{depth+1}` scope — identical id format to the in-memory tree.
  const renderLazyNode = (node: LazyTreeNode): JSX.Element => {
    const opened = node.expanded;
    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${isLazyNodeSelected(node) ? styles.rowSelected : ''}`}
          style={{ marginLeft: 16 * node.depth }}
        >
          <span
            className={styles.caret}
            role="button"
            aria-label={opened ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              lazy.toggle(node.id);
            }}
          >
            {opened ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
          </span>
          <span
            className={styles.label}
            role="button"
            onClick={() => selectLazyNode(node)}
            title={`Scope to ${splitScopePath(node.id).join('/')}`}
          >
            <Folder16Regular style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {node.label}{' '}
            {typeof node.count === 'number' && (
              <Badge appearance="tint" size="small">
                {node.count}
              </Badge>
            )}
          </span>
        </div>
        {opened && (
          <div>
            {node.loading && <Spinner size="tiny" label="Loading…" />}
            {node.error && <Body1 className={styles.empty}>Failed to load: {node.error}</Body1>}
            {!node.isTagContainer &&
              node.childIds.map((cid) => {
                const child = lazy.state.nodes[cid];
                return child ? renderLazyNode(child) : null;
              })}
            {node.isTagContainer && (
              <>
                {node.tags.map((t) => renderLeaf(t, node.depth))}
                {node.loaded && !node.loading && node.tags.length === 0 && (
                  <Body1 className={styles.empty}>No items here.</Body1>
                )}
                {node.hasMore && !node.loading && (
                  <Button size="small" appearance="subtle" onClick={() => lazy.loadMore(node.id)}>
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

  const treeBody = serverBacked ? (
    serverSearching ? (
      // Flat, paged server search results (query active).
      <>
        {serverSearch.loading && serverSearch.rows.length === 0 && (
          <Spinner size="tiny" label="Searching…" />
        )}
        {serverSearch.error && (
          <Body1 className={styles.empty}>Failed to search: {serverSearch.error}</Body1>
        )}
        {!serverSearch.loading && !serverSearch.error && serverSearch.rows.length === 0 && (
          <Body1 className={styles.empty}>No tags match your search.</Body1>
        )}
        {serverSearch.rows.map((t) => renderLeaf(t, -1))}
        {serverSearch.hasMore && !serverSearch.loading && (
          <Button size="small" appearance="subtle" onClick={serverSearch.loadMore}>
            Load more
          </Button>
        )}
        {serverSearch.loading && serverSearch.rows.length > 0 && (
          <Spinner size="tiny" label="Loading…" />
        )}
      </>
    ) : (
      // Lazy hierarchy browse (no query).
      <>
        {lazy.state.rootLoading && <Spinner size="tiny" label="Loading…" />}
        {lazy.state.rootError && (
          <Body1 className={styles.empty}>Failed to load: {lazy.state.rootError}</Body1>
        )}
        {lazy.state.rootLoaded &&
          !lazy.state.rootLoading &&
          lazy.state.rootIds.length === 0 && (
            <Body1 className={styles.empty}>No asset hierarchy.</Body1>
          )}
        {lazy.state.rootIds.map((id) => {
          const node = lazy.state.nodes[id];
          return node ? renderLazyNode(node) : null;
        })}
      </>
    )
  ) : tree.length === 0 ? (
    <Body1 className={styles.empty}>No tags match your search.</Body1>
  ) : (
    tree.map((n) => renderNode(n, 0))
  );

  return (
    <Field label={info ? withInfo(label, info) : label}>
      <Popover open={open} onOpenChange={(_, d) => setOpen(d.open)} trapFocus positioning="below-start">
        <PopoverTrigger disableButtonEnhancement>
          <Button
            className={styles.trigger}
            disabled={disabled}
            iconPosition="after"
            icon={<ChevronDown16Regular />}
          >
            <span className={styles.triggerText}>
              {displayText || <span className={styles.placeholder}>Select a scope</span>}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverSurface className={styles.surface}>
          <div className={styles.root}>
            <Caption1 className={styles.hint}>
              Pick a single {term.metricIdLabel.toLowerCase()}, or a hierarchy node to scope the annotation to everything beneath it.
            </Caption1>
            <Input
              contentBefore={<Search16Regular />}
              placeholder={`Search ${term.metricIdLabelPlural.toLowerCase()}…`}
              value={query}
              onChange={(_, d) => setQuery(d.value)}
            />
            <div className={styles.tree}>{treeBody}</div>
          </div>
        </PopoverSurface>
      </Popover>
    </Field>
  );
}
