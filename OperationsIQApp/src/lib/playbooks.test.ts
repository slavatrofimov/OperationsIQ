import { describe, it, expect } from 'vitest';

import { TEMPLATES, getTemplate } from './playbookTemplates';
import {
  DOMAIN_PLAYBOOKS,
  resolveAllPlaybooks,
  playbookMatchesQuery,
  CROSS_INDUSTRY_FUNCTIONS,
} from './playbooks';
import { PAGE_LABELS } from './personas';
import type { PageKey } from './pages';

const VALID_PAGES = new Set(Object.keys(PAGE_LABELS) as PageKey[]);

describe('playbook templates', () => {
  it('every template step targets a valid page and starts on a step page', () => {
    for (const t of TEMPLATES) {
      expect(VALID_PAGES.has(t.startPage), `${t.id} startPage`).toBe(true);
      const stepPages = new Set(t.steps.map((s) => s.page));
      expect(stepPages.has(t.startPage), `${t.id} startPage is a step`).toBe(true);
      for (const s of t.steps) {
        expect(VALID_PAGES.has(s.page), `${t.id} step page ${s.page}`).toBe(true);
      }
    }
  });

  it('template ids are unique', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('domain playbooks', () => {
  it('have unique ids and resolvable templates', () => {
    const ids = DOMAIN_PLAYBOOKS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of DOMAIN_PLAYBOOKS) {
      expect(getTemplate(w.templateId), `${w.id} -> ${w.templateId}`).toBeDefined();
    }
  });

  it('stepOverrides indices stay within the template step count', () => {
    for (const w of DOMAIN_PLAYBOOKS) {
      if (!w.stepOverrides) continue;
      const template = getTemplate(w.templateId)!;
      for (const key of Object.keys(w.stepOverrides)) {
        const idx = Number(key);
        expect(
          idx >= 0 && idx < template.steps.length,
          `${w.id} override index ${idx} out of range (template has ${template.steps.length} steps)`,
        ).toBe(true);
      }
    }
  });

  it('every resolved playbook exposes concrete steps', () => {
    const resolved = resolveAllPlaybooks();
    expect(resolved.length).toBe(DOMAIN_PLAYBOOKS.length);
    for (const w of resolved) {
      expect(w.steps.length).toBeGreaterThan(0);
      for (const s of w.steps) {
        expect(VALID_PAGES.has(s.page), `${w.id} resolved page ${s.page}`).toBe(true);
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('recently added tools are surfaced in playbooks', () => {
  it.each(['spectrum', 'processmining', 'changepoints', 'discover'] as const)(
    'the %s page appears in at least one resolved playbook',
    (page) => {
      const resolved = resolveAllPlaybooks();
      const used = resolved.some((w) => w.steps.some((s) => s.page === page));
      expect(used).toBe(true);
    },
  );
});

describe('cross-industry business playbooks', () => {
  const crossIndustry = DOMAIN_PLAYBOOKS.filter((w) => w.industry === 'cross_industry');
  const functions = new Set<string>(CROSS_INDUSTRY_FUNCTIONS);

  it('exist for the cross_industry bucket', () => {
    expect(crossIndustry.length).toBeGreaterThan(0);
  });

  it("every playbook's domain is a known business function", () => {
    for (const w of crossIndustry) {
      expect(functions.has(w.domain), `${w.id} domain ${w.domain}`).toBe(true);
    }
  });

  it('every business function has at least one playbook', () => {
    for (const fn of CROSS_INDUSTRY_FUNCTIONS) {
      const has = crossIndustry.some((w) => w.domain === fn);
      expect(has, `function ${fn} has no playbook`).toBe(true);
    }
  });

  it('all business templates resolve', () => {
    const businessTemplateIds = [
      'kpi_target_forecast',
      'kpi_anomaly_diagnosis',
      'seasonality_planning',
      'intervention_impact',
      'segment_benchmarking',
      'metric_erosion_earlywarning',
      'kpi_driver_analysis',
    ];
    for (const id of businessTemplateIds) {
      expect(getTemplate(id), `template ${id}`).toBeDefined();
    }
  });
});

describe('playbookMatchesQuery', () => {
  const sample = resolveAllPlaybooks()[0];

  it('matches everything for an empty or whitespace query', () => {
    expect(playbookMatchesQuery(sample, '')).toBe(true);
    expect(playbookMatchesQuery(sample, '   ')).toBe(true);
  });

  it('matches case-insensitively on the title', () => {
    const upper = sample.title.toUpperCase();
    expect(playbookMatchesQuery(sample, upper)).toBe(true);
  });

  it('matches on a substring of the summary', () => {
    const token = sample.summary.split(' ').find((w) => w.length > 3) ?? sample.summary;
    expect(playbookMatchesQuery(sample, token)).toBe(true);
  });

  it('matches on the industry label', () => {
    expect(playbookMatchesQuery(sample, 'oil')).toBe(true);
  });

  it('does not match an unrelated term', () => {
    expect(playbookMatchesQuery(sample, 'zzz-nonexistent-term-xyz')).toBe(false);
  });

  it('finds cross-industry playbooks by a finance keyword', () => {
    const resolved = resolveAllPlaybooks();
    const hits = resolved.filter((w) => playbookMatchesQuery(w, 'finance'));
    expect(hits.length).toBeGreaterThan(0);
  });
});
