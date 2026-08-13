/**
 * usePageController — the hook a page calls to expose itself to the Time Series
 * Operations Advisor's UI-control tools. It registers a live controller into the
 * `uiControl` bus (see `lib/agent/uiControl.ts`) so the agent can read the
 * page's inputs, set them, and run its analysis.
 *
 * A page passes its CURRENT state each render (fields, setParams, canRun, run,
 * and the loading/error/hasResult derived from its `useAsyncAction` state). The
 * hook keeps the registered handle pointing at the latest closures via a ref, so
 * the agent (which executes outside React) always observes live values. It also
 * maintains a `generation` counter that ticks once per completed run, letting
 * `run_current_page` detect that a fresh result arrived.
 *
 * Cheap boilerplate: use the `pf` field builders to declare each input.
 */
import { useEffect, useRef } from 'react';
import type { PageKey } from '../lib/pages';
import {
  clearActiveController,
  setActiveController,
  type ParamField,
  type PageControllerHandle,
  type RunSnapshot,
  type SetParamsResult,
} from '../lib/agent/uiControl';

export type { ParamField, SetParamsResult } from '../lib/agent/uiControl';

export interface PageControllerConfig {
  pageKey: PageKey;
  /** Human page name (e.g. "Forecast"). */
  title: string;
  /** Controllable inputs + current values (recompute each render). */
  fields: ParamField[];
  /** Apply a name->value patch; return which fields applied / failed. */
  setParams: (patch: Record<string, unknown>) => SetParamsResult;
  /** Whether the page can run right now. */
  canRun: boolean;
  /** Trigger the page's primary analysis. */
  run: () => void;
  /** From the page's useAsyncAction state. */
  loading: boolean;
  error?: string;
  /** Whether a result is currently rendered. */
  hasResult: boolean;
}

export function usePageController(config: PageControllerConfig): void {
  // Latest closures/values, refreshed every render so the handle stays live.
  const ref = useRef(config);
  ref.current = config;

  const genRef = useRef(0);
  const prevLoadingRef = useRef(config.loading);

  // Tick the generation counter once per completed run (loading true -> false),
  // in an effect so StrictMode's double render can't double-count.
  useEffect(() => {
    if (prevLoadingRef.current && !config.loading) genRef.current += 1;
    prevLoadingRef.current = config.loading;
  }, [config.loading]);

  // A single stable handle whose methods always read the latest ref values.
  const handleRef = useRef<PageControllerHandle | null>(null);
  if (!handleRef.current) {
    handleRef.current = {
      pageKey: config.pageKey,
      title: config.title,
      getFields: () => ref.current.fields,
      setParams: (patch) => ref.current.setParams(patch),
      canRun: () => ref.current.canRun,
      run: () => {
        if (ref.current.canRun) ref.current.run();
      },
      getRunSnapshot: (): RunSnapshot => {
        const c = ref.current;
        const phase = c.loading
          ? 'running'
          : c.error
            ? 'error'
            : c.hasResult
              ? 'done'
              : 'idle';
        return {
          phase,
          generation: genRef.current,
          message: c.error,
          hasResult: c.hasResult,
        };
      },
    };
  } else {
    // Keep the (otherwise static) identity fields current if the page key/title
    // ever change for the same mount.
    handleRef.current.pageKey = config.pageKey;
    handleRef.current.title = config.title;
  }

  useEffect(() => {
    const handle = handleRef.current!;
    setActiveController(handle);
    return () => clearActiveController(handle);
    // Register once per mount; the handle reads live state via the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------------------------------------------------------------------------
// useControlledPage — declarative wrapper that assembles fields + a validating
// setParams from a list of field specs, so each page's wiring stays tiny.
// ---------------------------------------------------------------------------

/** One controllable field plus the function that applies an agent-supplied value. */
export interface ControlledField {
  field: ParamField;
  /**
   * Apply a raw (agent-supplied) value to page state. Return a human-readable
   * string to REJECT the value (it becomes a setParams error); return nothing
   * (or void) on success.
   */
  apply: (value: unknown) => string | void;
}

export interface ControlledPageConfig {
  pageKey: PageKey;
  title: string;
  fields: ControlledField[];
  canRun: boolean;
  run: () => void;
  loading: boolean;
  error?: string;
  hasResult: boolean;
}

/**
 * Higher-level convenience over {@link usePageController}: give it a list of
 * `{ field, apply }` specs and it builds the `fields` array and a `setParams`
 * that dispatches each patch entry to the matching spec (validating unknown
 * keys and surfacing per-field errors). This keeps every page's registration to
 * a short, uniform block.
 */
export function useControlledPage(config: ControlledPageConfig): void {
  const setParams = (patch: Record<string, unknown>): SetParamsResult => {
    const applied: string[] = [];
    const errors: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const spec = config.fields.find((f) => f.field.name === key);
      if (!spec) {
        errors.push(`Unknown parameter "${key}".`);
        continue;
      }
      try {
        const err = spec.apply(value);
        if (typeof err === 'string' && err) errors.push(err);
        else applied.push(key);
      } catch (e) {
        errors.push(`${key}: ${(e as Error).message}`);
      }
    }
    return { ok: errors.length === 0, applied, errors };
  };

  usePageController({
    pageKey: config.pageKey,
    title: config.title,
    fields: config.fields.map((f) => f.field),
    setParams,
    canRun: config.canRun,
    run: config.run,
    loading: config.loading,
    error: config.error,
    hasResult: config.hasResult,
  });
}

// ---------------------------------------------------------------------------
// Coercion helpers — turn loosely-typed agent values into strict page values,
// or throw a clear message the panel/agent can act on.
// ---------------------------------------------------------------------------

export const coerce = {
  number(value: unknown, opts?: { min?: number; max?: number }): number {
    const n = typeof value === 'string' ? Number(value) : (value as number);
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('expected a number');
    if (opts?.min != null && n < opts.min) throw new Error(`must be ≥ ${opts.min}`);
    if (opts?.max != null && n > opts.max) throw new Error(`must be ≤ ${opts.max}`);
    return n;
  },
  integer(value: unknown, opts?: { min?: number; max?: number }): number {
    return Math.floor(coerce.number(value, opts));
  },
  boolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('expected true or false');
  },
  string(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    return String(value);
  },
  stringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value === 'string') return value.trim() ? [value] : [];
    throw new Error('expected a string or list of strings');
  },
  enumValue(value: unknown, allowed: (string | number)[]): string | number {
    const raw = value as string | number;
    if (allowed.includes(raw)) return raw;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && allowed.includes(asNum)) return asNum;
    throw new Error(`must be one of: ${allowed.join(', ')}`);
  },
};

interface NumOpts {
  description?: string;
  min?: number;
  max?: number;
  required?: boolean;
}

export const pf = {
  tags(name: string, label: string, current: string[], opts?: { description?: string; required?: boolean }): ParamField {
    return { name, label, type: 'tags', current, description: opts?.description, required: opts?.required };
  },
  number(name: string, label: string, current: number, opts?: NumOpts): ParamField {
    return { name, label, type: 'number', current, ...opts };
  },
  integer(name: string, label: string, current: number, opts?: NumOpts): ParamField {
    return { name, label, type: 'integer', current, ...opts };
  },
  boolean(name: string, label: string, current: boolean, opts?: { description?: string }): ParamField {
    return { name, label, type: 'boolean', current, description: opts?.description };
  },
  string(name: string, label: string, current: string, opts?: { description?: string; required?: boolean }): ParamField {
    return { name, label, type: 'string', current, description: opts?.description, required: opts?.required };
  },
  enumOf(
    name: string,
    label: string,
    current: string | number,
    enumValues: { value: string | number; label: string }[],
    opts?: { description?: string },
  ): ParamField {
    return { name, label, type: 'enum', current, enumValues, description: opts?.description };
  },
  /** current is a { start, end } pair of ISO 8601 strings. */
  daterange(
    name: string,
    label: string,
    current: { start: string; end: string },
    opts?: { description?: string },
  ): ParamField {
    return { name, label, type: 'daterange', current, description: opts?.description };
  },
};
