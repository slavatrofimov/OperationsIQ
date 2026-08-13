import { describe, it, expect, beforeEach } from 'vitest';
import {
  describeCurrentPageTool,
  readCurrentResultsTool,
  navigateToPageTool,
  setPageParamsTool,
  runCurrentPageTool,
  uiControlTools,
} from './uiControlTools';
import {
  __resetUiControlForTests,
  setActiveController,
  setNavigator,
  setScreenCapture,
  type PageControllerHandle,
  type ParamField,
  type RunSnapshot,
  type SetParamsResult,
} from '../uiControl';
import type { ToolContext } from '../types';

const ctx = { tags: [] } as unknown as ToolContext;

function fields(): ParamField[] {
  return [
    { name: 'tags', label: 'Tag', type: 'tags', current: [], required: true },
    { name: 'horizon', label: 'Horizon', type: 'integer', current: 48, min: 1, max: 2000 },
  ];
}

describe('uiControlTools', () => {
  beforeEach(() => __resetUiControlForTests());

  it('exposes 5 tools; describe/read are read-only, mutators are not', () => {
    expect(uiControlTools).toHaveLength(5);
    expect(describeCurrentPageTool.readOnly).toBe(true);
    expect(readCurrentResultsTool.readOnly).toBe(true);
    expect(navigateToPageTool.readOnly).toBe(false);
    expect(setPageParamsTool.readOnly).toBe(false);
    expect(runCurrentPageTool.readOnly).toBe(false);
  });

  describe('describe_current_page', () => {
    it('reports the active page fields and available pages', async () => {
      setNavigator({
        navigate: () => true,
        pages: () => [
          { key: 'forecast', label: 'Forecast' },
          { key: 'monitor', label: 'Monitor' },
        ],
        current: () => 'forecast',
      });
      setActiveController(makeCtrl());
      const res = await describeCurrentPageTool.run({}, ctx);
      expect(res.ok).toBe(true);
      const data = res.data as { controllable: boolean; fields: unknown[]; availablePages: unknown[] };
      expect(data.controllable).toBe(true);
      expect(data.fields).toHaveLength(2);
      expect(data.availablePages).toHaveLength(2);
    });

    it('handles a page with no controller gracefully', async () => {
      setNavigator({
        navigate: () => true,
        pages: () => [{ key: 'alerts', label: 'Alerts' }],
        current: () => 'alerts',
      });
      const res = await describeCurrentPageTool.run({}, ctx);
      expect(res.ok).toBe(true);
      expect((res.data as { controllable: boolean }).controllable).toBe(false);
    });
  });

  describe('set_page_params', () => {
    it('applies a patch through the controller', async () => {
      let applied: Record<string, unknown> = {};
      setActiveController(
        makeCtrl({
          setParams: (patch): SetParamsResult => {
            applied = patch;
            return { ok: true, applied: Object.keys(patch), errors: [] };
          },
        }),
      );
      const res = await setPageParamsTool.run({ params: { horizon: 96 } }, ctx);
      expect(res.ok).toBe(true);
      expect(applied).toEqual({ horizon: 96 });
    });

    it('rejects when there is no controllable page', async () => {
      const res = await setPageParamsTool.run({ params: { horizon: 96 } }, ctx);
      expect(res.ok).toBe(false);
    });

    it('surfaces controller-reported errors', async () => {
      setActiveController(
        makeCtrl({
          setParams: (): SetParamsResult => ({ ok: false, applied: [], errors: ['bad horizon'] }),
        }),
      );
      const res = await setPageParamsTool.run({ params: { horizon: -1 } }, ctx);
      expect(res.ok).toBe(false);
      expect((res.data as { errors: string[] }).errors).toContain('bad horizon');
    });
  });

  describe('navigate_to_page', () => {
    it('rejects an unknown page', async () => {
      setNavigator({
        navigate: () => true,
        pages: () => [{ key: 'forecast', label: 'Forecast' }],
        current: () => 'forecast',
      });
      const res = await navigateToPageTool.run({ page: 'nope' }, ctx);
      expect(res.ok).toBe(false);
    });

    it('navigates and returns the destination controller state', async () => {
      let current: 'forecast' | 'monitor' = 'forecast';
      setNavigator({
        navigate: (p) => {
          current = p as 'forecast' | 'monitor';
          if (current === 'monitor') setActiveController(makeCtrl({ pageKey: 'monitor', title: 'Monitor' }));
          return true;
        },
        pages: () => [
          { key: 'forecast', label: 'Forecast' },
          { key: 'monitor', label: 'Monitor' },
        ],
        current: () => current,
      });
      setActiveController(makeCtrl());
      const res = await navigateToPageTool.run({ page: 'monitor' }, ctx);
      expect(res.ok).toBe(true);
      expect((res.data as { page: string }).page).toBe('monitor');
    });
  });

  describe('run_current_page', () => {
    it('refuses when the page cannot run', async () => {
      setActiveController(makeCtrl({ canRun: () => false }));
      const res = await runCurrentPageTool.run({}, ctx);
      expect(res.ok).toBe(false);
    });

    it('runs and reports success when a fresh result arrives', async () => {
      let gen = 0;
      let ran = false;
      const snap = (): RunSnapshot => ({
        phase: ran ? 'done' : 'idle',
        generation: gen,
        hasResult: ran,
      });
      setActiveController(
        makeCtrl({
          canRun: () => true,
          run: () => {
            ran = true;
            gen = 1;
          },
          getRunSnapshot: snap,
        }),
      );
      setScreenCapture(() => ({ pageName: 'Forecast', markdown: '## Result\nvalue 42' }));
      const res = await runCurrentPageTool.run({}, ctx);
      expect(res.ok).toBe(true);
      expect((res.data as { hasResult: boolean }).hasResult).toBe(true);
    });

    it('reports a run error', async () => {
      let gen = 0;
      setActiveController(
        makeCtrl({
          canRun: () => true,
          run: () => {
            gen = 1;
          },
          getRunSnapshot: (): RunSnapshot => ({
            phase: gen > 0 ? 'error' : 'idle',
            generation: gen,
            hasResult: false,
            message: 'query failed',
          }),
        }),
      );
      const res = await runCurrentPageTool.run({}, ctx);
      expect(res.ok).toBe(false);
    });
  });

  describe('read_current_results', () => {
    it('returns captured screen content', async () => {
      setActiveController(
        makeCtrl({
          getRunSnapshot: (): RunSnapshot => ({ phase: 'done', generation: 1, hasResult: true }),
        }),
      );
      setScreenCapture(() => ({ pageName: 'Forecast', markdown: '# Forecast\nresult' }));
      const res = await readCurrentResultsTool.run({}, ctx);
      expect(res.ok).toBe(true);
      expect((res.data as { content: string }).content).toContain('Forecast');
    });

    it('explains when nothing is rendered yet', async () => {
      setActiveController(
        makeCtrl({
          getRunSnapshot: (): RunSnapshot => ({ phase: 'idle', generation: 0, hasResult: false }),
        }),
      );
      const res = await readCurrentResultsTool.run({}, ctx);
      expect(res.ok).toBe(true);
      expect((res.data as { hasResult: boolean }).hasResult).toBe(false);
    });
  });
});

function makeCtrl(overrides: Partial<PageControllerHandle> = {}): PageControllerHandle {
  return {
    pageKey: 'forecast',
    title: 'Forecast',
    getFields: fields,
    setParams: () => ({ ok: true, applied: [], errors: [] }),
    canRun: () => true,
    run: () => {},
    getRunSnapshot: (): RunSnapshot => ({ phase: 'idle', generation: 0, hasResult: false }),
    ...overrides,
  };
}
