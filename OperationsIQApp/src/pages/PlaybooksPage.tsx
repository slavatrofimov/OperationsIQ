import { useEffect, useMemo, useState } from 'react';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Dropdown,
  Input,
  Option,
  Subtitle1,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowRight24Regular, Search24Regular } from '@fluentui/react-icons';
import { useIndustry } from '../context/IndustryContext';
import {
  resolveAllPlaybooks,
  playbookMatchesQuery,
  CATEGORY_LABELS,
  CROSS_INDUSTRY_FUNCTIONS,
  type Playbook,
  type TemplateCategory,
} from '../lib/playbooks';
import { INDUSTRIES, industryLabel, type IndustryKey } from '../lib/industries';
import { PAGE_LABELS } from '../lib/personas';
import { operationsAdvisorConfigReady } from '../lib/env';
import { PageIntro } from '../components/PageIntro';
import { EXPLAINERS } from '../lib/explainers';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  filters: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'flex-end' },
  filterField: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  filterDropdown: { minWidth: '200px' },
  searchInput: { minWidth: '260px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  card: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalL },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  metaRow: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  spacer: { flex: 1 },
  steps: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  step: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start' },
  stepNum: {
    flexShrink: 0,
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
});

export interface PlaybooksPageProps {
  /** Hand the selected playbook off to the Operations Advisor for guidance. */
  onStart: (playbook: Playbook) => void;
}

type IndustryFilter = IndustryKey | 'all';
type CategoryFilter = TemplateCategory | 'all';

/**
 * Playbooks launcher (functional spec §Playbooks). Presents
 * expert-authored, industry-specific operational playbooks — each an
 * implementation of a reusable template — as cards with a plain-language
 * rationale and ordered steps. Playbooks are filtered by industry (selected
 * here), operational category, and a free-text keyword search. Clicking "Start"
 * hands the playbook's rationale and steps to the Operations Advisor, which
 * guides the user through the analysis.
 */
export function PlaybooksPage({ onStart }: PlaybooksPageProps) {
  const styles = useStyles();
  const { industry, setIndustry } = useIndustry();

  const [industryFilter, setIndustryFilter] = useState<IndustryFilter>(industry);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [functionFilter, setFunctionFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const advisorReady = operationsAdvisorConfigReady();

  // Keep the page's industry filter in sync with the header/app industry.
  useEffect(() => {
    setIndustryFilter(industry);
    setFunctionFilter('all');
  }, [industry]);

  const all = useMemo(() => resolveAllPlaybooks(), []);

  // Categories present in the current industry view (for the category filter),
  // sorted alphabetically by label for easier navigation.
  const availableCategories = useMemo(() => {
    const pool = industryFilter === 'all' ? all : all.filter((w) => w.industry === industryFilter);
    const set = new Set<TemplateCategory>();
    for (const w of pool) set.add(w.category);
    return [...set].sort((a, b) => CATEGORY_LABELS[a].localeCompare(CATEGORY_LABELS[b]));
  }, [all, industryFilter]);

  // Business functions present in the Cross-Industry view (for the sub-filter),
  // sorted alphabetically for easier navigation.
  const availableFunctions = useMemo(() => {
    const present = new Set(
      all.filter((w) => w.industry === 'cross_industry').map((w) => w.domain),
    );
    return CROSS_INDUSTRY_FUNCTIONS.filter((f) => present.has(f)).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [all]);

  // Industry options for the selector, sorted alphabetically by label.
  const industryOptions = useMemo(
    () => [...INDUSTRIES].sort((a, b) => a.label.localeCompare(b.label)),
    [],
  );

  const filtered = useMemo(() => {
    return all.filter((w) => {
      if (industryFilter !== 'all' && w.industry !== industryFilter) return false;
      if (categoryFilter !== 'all' && w.category !== categoryFilter) return false;
      if (
        industryFilter === 'cross_industry' &&
        functionFilter !== 'all' &&
        w.domain !== functionFilter
      )
        return false;
      if (!playbookMatchesQuery(w, query)) return false;
      return true;
    });
  }, [all, industryFilter, categoryFilter, functionFilter, query]);

  const captureSummary = useMemo<CaptureContextSummary>(
    () => ({
      sections: [
        {
          title: 'Filters',
          fields: [
            {
              label: 'Industry',
              value: industryFilter === 'all' ? 'All industries' : industryLabel(industryFilter),
            },
            {
              label: 'Category',
              value: categoryFilter === 'all' ? 'All categories' : CATEGORY_LABELS[categoryFilter],
            },
            ...(industryFilter === 'cross_industry'
              ? [
                  {
                    label: 'Business function',
                    value: functionFilter === 'all' ? 'All functions' : functionFilter,
                  },
                ]
              : []),
            ...(query.trim() ? [{ label: 'Search', value: query.trim() }] : []),
            { label: 'Playbooks shown', value: String(filtered.length) },
          ],
        },
      ],
    }),
    [industryFilter, categoryFilter, functionFilter, query, filtered.length],
  );
  useRegisterCaptureContext(captureSummary);

  // Selecting a concrete industry also persists it as the app's active industry
  // (the selector lives here now, since industry only matters to
  // playbooks). "All industries" is a page-local view that leaves it unchanged.
  const handleIndustrySelect = (value: IndustryFilter) => {
    setIndustryFilter(value);
    setFunctionFilter('all');
    if (value !== 'all') setIndustry(value);
  };

  const renderCard = (w: Playbook) => {
    return (
      <Card key={w.id} className={styles.card}>
        <div className={styles.cardHead}>
          <Subtitle2>{w.title}</Subtitle2>
          <div className={styles.spacer} />
        </div>
        <div className={styles.metaRow}>
          <Badge appearance="outline" color="informative">
            {industryLabel(w.industry)}
          </Badge>
          <Badge appearance="outline" color="subtle">
            {w.domain}
          </Badge>
          <Badge appearance="outline" color="subtle">
            {CATEGORY_LABELS[w.category]}
          </Badge>
        </div>
        <Caption1>{w.summary}</Caption1>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          {w.whyItMatters}
        </Text>

        {expanded === w.id && (
          <div className={styles.steps}>
            {w.steps.map((s, i) => (
              <div key={i} className={styles.step}>
                <span className={styles.stepNum}>{i + 1}</span>
                <div>
                  <Text weight="semibold">{s.title}</Text>
                  <br />
                  <Caption1>
                    {s.detail} <em>({PAGE_LABELS[s.page]})</em>
                  </Caption1>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className={styles.cardHead}>
          <Button
            appearance="subtle"
            size="small"
            onClick={() => setExpanded(expanded === w.id ? null : w.id)}
          >
            {expanded === w.id ? 'Hide steps' : 'Show steps'}
          </Button>
          <div className={styles.spacer} />
          <Button
            appearance="primary"
            size="small"
            icon={<ArrowRight24Regular />}
            iconPosition="after"
            disabled={!advisorReady}
            title={
              advisorReady
                ? undefined
                : 'The Operations Advisor is not configured in this environment.'
            }
            onClick={() => onStart(w)}
          >
            Start
          </Button>
        </div>
      </Card>
    );
  };

  return (
    <div className={styles.root}>
      <Subtitle1>Playbooks</Subtitle1>
      <PageIntro
        title="Playbooks"
        overview={EXPLAINERS.playbooks.overview}
        interpretation={EXPLAINERS.playbooks.interpretation}
      />

      <div className={styles.filters}>
        <div className={styles.filterField}>
          <Caption1>Search</Caption1>
          <Input
            className={styles.searchInput}
            size="small"
            value={query}
            placeholder="Search playbooks by keyword"
            contentBefore={<Search24Regular />}
            onChange={(_, d) => setQuery(d.value)}
            aria-label="Search playbooks"
          />
        </div>
        <div className={styles.filterField}>
          <Caption1>Industry</Caption1>
          <Dropdown
            className={styles.filterDropdown}
            size="small"
            value={industryFilter === 'all' ? 'All industries' : industryLabel(industryFilter)}
            selectedOptions={[industryFilter]}
            onOptionSelect={(_, d) =>
              d.optionValue && handleIndustrySelect(d.optionValue as IndustryFilter)
            }
            aria-label="Industry filter"
          >
            <Option value="all" text="All industries">
              All industries
            </Option>
            {industryOptions.map((i) => (
              <Option key={i.key} value={i.key} text={i.label}>
                {i.label}
              </Option>
            ))}
          </Dropdown>
        </div>
        <div className={styles.filterField}>
          <Caption1>Category</Caption1>
          <Dropdown
            className={styles.filterDropdown}
            size="small"
            value={categoryFilter === 'all' ? 'All categories' : CATEGORY_LABELS[categoryFilter]}
            selectedOptions={[categoryFilter]}
            onOptionSelect={(_, d) => d.optionValue && setCategoryFilter(d.optionValue as CategoryFilter)}
            aria-label="Category filter"
          >
            <Option value="all" text="All categories">
              All categories
            </Option>
            {availableCategories.map((c) => (
              <Option key={c} value={c} text={CATEGORY_LABELS[c]}>
                {CATEGORY_LABELS[c]}
              </Option>
            ))}
          </Dropdown>
        </div>
        {industryFilter === 'cross_industry' && availableFunctions.length > 0 && (
          <div className={styles.filterField}>
            <Caption1>Business function</Caption1>
            <Dropdown
              className={styles.filterDropdown}
              size="small"
              value={functionFilter === 'all' ? 'All functions' : functionFilter}
              selectedOptions={[functionFilter]}
              onOptionSelect={(_, d) => d.optionValue && setFunctionFilter(d.optionValue)}
              aria-label="Business function filter"
            >
              <Option value="all" text="All functions">
                All functions
              </Option>
              {availableFunctions.map((f) => (
                <Option key={f} value={f} text={f}>
                  {f}
                </Option>
              ))}
            </Dropdown>
          </div>
        )}
      </div>

      {filtered.length > 0 && (
        <>
          <Subtitle2>Playbooks</Subtitle2>
          <div className={styles.grid}>{filtered.map((w) => renderCard(w))}</div>
        </>
      )}

      {filtered.length === 0 && (
        <Body1>
          No playbooks match the current filters. Try a different industry, category, or search
          term.
        </Body1>
      )}
    </div>
  );
}
