import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetUiControlForTests,
  setActiveController,
  clearActiveController,
  getActiveController,
  setNavigator,
  getNavigator,
  setScreenCapture,
  captureScreen,
  subscribeUiControl,
  type PageControllerHandle,
  type RunSnapshot,
} from './uiControl';

/** Build a minimal controller handle with an overridable run snapshot. */
function makeController(overrides: Partial<PageControllerHandle> = {}): PageControllerHandle {
  const snap: RunSnapshot = { phase: 'idle', generation: 0, hasResult: false };
  return {
    pageKey: 'forecast',
    title: 'Forecast',
    getFields: () => [],
    setParams: () => ({ ok: true, applied: [], errors: [] }),
    canRun: () => true,
    run: () => {},
    getRunSnapshot: () => snap,
    ...overrides,
  };
}

describe('uiControl bus', () => {
  beforeEach(() => __resetUiControlForTests());

  it('registers and returns the active controller', () => {
    const ctrl = makeController();
    setActiveController(ctrl);
    expect(getActiveController()).toBe(ctrl);
  });

  it('clearActiveController only clears when the handle matches', () => {
    const first = makeController({ pageKey: 'forecast' });
    const second = makeController({ pageKey: 'monitor' });
    setActiveController(first);
    setActiveController(second); // navigation replaced the controller

    // Stale unmount of the FIRST page must not wipe the second page's controller.
    clearActiveController(first);
    expect(getActiveController()).toBe(second);

    // Clearing the current handle does clear it.
    clearActiveController(second);
    expect(getActiveController()).toBeNull();
  });

  it('notifies subscribers when the controller changes', () => {
    let count = 0;
    const unsub = subscribeUiControl(() => {
      count += 1;
    });
    setActiveController(makeController());
    expect(count).toBe(1);
    unsub();
    setActiveController(makeController());
    expect(count).toBe(1); // no longer subscribed
  });

  it('stores and reads the navigator', () => {
    const nav = {
      navigate: () => true,
      pages: () => [{ key: 'forecast' as const, label: 'Forecast' }],
      current: () => 'forecast' as const,
    };
    setNavigator(nav);
    expect(getNavigator()).toBe(nav);
    setNavigator(null);
    expect(getNavigator()).toBeNull();
  });

  it('captureScreen returns the registered snapshot and swallows errors', () => {
    setScreenCapture(() => ({ pageName: 'Forecast', markdown: '# Forecast' }));
    expect(captureScreen()).toEqual({ pageName: 'Forecast', markdown: '# Forecast' });

    setScreenCapture(() => {
      throw new Error('boom');
    });
    expect(captureScreen()).toBeNull();

    setScreenCapture(null);
    expect(captureScreen()).toBeNull();
  });
});
