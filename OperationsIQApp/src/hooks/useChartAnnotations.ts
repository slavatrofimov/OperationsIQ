import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TagInfo } from '../lib/tags';
import type { HierarchyLevel } from '../lib/tagTree';
import type { AnnotationDialogInitial } from '../components/AnnotationDialog';
import type { EChartHandle } from '../components/EChart';
import { loadTimeline, deleteAnnotation, type AnnotationScope } from '../lib/annotations';
import {
  distinctMarkerTypes,
  markerTypeKey,
  type TimelineMarker,
  type MarkerTypeGroup,
} from '../lib/timelineMarkers';
import { getFabricAccountId } from '../lib/rayfinClient';
import { fromChartMs } from '../lib/timezone';

/** A real-UTC time range, e.g. the full extent of the current chart. */
export interface AnnotationRange {
  start: Date;
  end: Date;
}

export interface UseChartAnnotationsOptions {
  /** Full tag catalog, for the scope selector inside the annotation dialog. */
  tags: TagInfo[];
  /** Active hierarchy level accessors matching the current connection profile. */
  levels: readonly HierarchyLevel[];
  /** Currently selected tag id(s) that scope which markers are loaded. */
  tagIds: string[];
  /** Full time extent (real UTC) markers are loaded/scoped for. */
  range: AnnotationRange | null;
  /** Master visibility toggle for markers (mirrors Explore's "show events" setting). */
  showMarkers?: boolean;
  /**
   * Active query-timezone offset (minutes), for pages whose chart plots in a
   * shifted "chart space" (wall clock encoded as UTC ticks) rather than raw
   * real UTC. Defaults to 0, which is correct for pages that plot raw timestamps.
   */
  offsetMinutes?: number;
  /**
   * When true, suppresses arming the ECharts brush cursor even while
   * `selecting` is true (e.g. Explore's overview chart while it's rendered
   * as a table instead of a chart, where there's no ECharts instance to arm).
   */
  suppressBrushArming?: boolean;
}

export interface UseChartAnnotationsResult {
  /** All unified markers (Events UNION Annotations), time-ordered. */
  allMarkers: TimelineMarker[];
  /** Markers to render on the chart: gated by `showMarkers`, minus hidden ids/types. */
  chartMarkers: TimelineMarker[];
  /** Distinct (source, type) groups present, for building filter toggles. */
  markerTypeGroups: MarkerTypeGroup[];
  hiddenMarkerIds: Set<string>;
  hiddenTypes: Set<string>;
  toggleMarker: (id: string, visible: boolean) => void;
  toggleAllMarkers: (visible: boolean) => void;
  toggleMarkerType: (key: string, visible: boolean) => void;

  /** Signed-in user id, or undefined when not signed in (gates authoring). */
  currentUserId?: string;

  /**
   * Ref to pass to the page's `ChartFrame`/`EChart`/`LiveChart` (`chartRef` prop).
   * The hook uses it to arm/disarm the ECharts brush cursor whenever `selecting`
   * changes, so callers no longer need to manage that dispatch themselves.
   */
  chartRef: RefObject<EChartHandle | null>;

  /** True while the chart is armed for a visual brush/click annotation pick. */
  selecting: boolean;
  /** Arm brush-selection mode (call from an "Annotate" toolbar button). */
  beginSelecting: () => void;
  /** Disarm brush-selection mode without opening the dialog. */
  cancelSelecting: () => void;
  /**
   * ECharts `brushEnd` handler: pass the raw event params straight through
   * (e.g. `onEvents={{ brushEnd: onBrushEndEvent }}`). Resolves point vs. span
   * and opens the create dialog seeded from the selection.
   */
  onBrushEndEvent: (params: unknown) => void;
  /**
   * Same resolution, for components (like `GlobalOverviewChart`) whose
   * `onBrushEnd` prop already hands back chart-space `Date`s directly.
   */
  handleBrushEndDates: (chartStart: Date, chartEnd: Date) => void;

  /** Open the create dialog directly (no chart interaction), e.g. as a fallback in table view. */
  openCreate: (start: Date, end: Date | null) => void;
  /** Open the edit dialog for an existing annotation marker (no-op for event markers). */
  openEdit: (marker: TimelineMarker) => void;
  /** Delete an annotation marker (author-only; enforced server-side too). */
  handleDeleteAnnotation: (marker: TimelineMarker) => Promise<void>;

  dialogOpen: boolean;
  dialogMode: 'create' | 'edit';
  dialogInitial: AnnotationDialogInitial | null;
  closeDialog: () => void;
  /** Re-fetch timeline markers for the current scope (also passed as the dialog's `onSaved`). */
  reload: () => void;

  /** Surfaced load/delete errors, for an inline MessageBar. */
  error: string | null;
  clearError: () => void;
}

/**
 * Reusable annotation orchestration hook: loads the unified timeline markers for
 * the given tag(s)/range, tracks per-marker/type visibility, and drives the
 * shared `AnnotationDialog` plus a brush-to-annotate flow. Originally embedded
 * in `ExplorePage`; factored out so any page can instrument a chart with the
 * same capability.
 */
export function useChartAnnotations({
  tags,
  levels,
  tagIds,
  range,
  showMarkers = true,
  offsetMinutes = 0,
  suppressBrushArming = false,
}: UseChartAnnotationsOptions): UseChartAnnotationsResult {
  const tagById = useMemo(() => new Map(tags.map((t) => [t.tagId, t])), [tags]);
  const nameById = useMemo(() => new Map(tags.map((t) => [t.tagId, t.tagName])), [tags]);

  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [hiddenMarkerIds, setHiddenMarkerIds] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<EChartHandle | null>(null);

  useEffect(() => {
    const chart = chartRef.current?.getInstance();
    if (!chart) return;
    if (selecting && !suppressBrushArming) {
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      });
    } else {
      chart.dispatchAction({ type: 'brush', areas: [] });
      chart.dispatchAction({ type: 'takeGlobalCursor' });
    }
  }, [selecting, suppressBrushArming]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [dialogInitial, setDialogInitial] = useState<AnnotationDialogInitial | null>(null);

  const refresh = useCallback(async () => {
    const tagInfos = tagIds.map((id) => tagById.get(id)).filter((t): t is TagInfo => !!t);
    if (tagInfos.length === 0 || !range) {
      setMarkers([]);
      return;
    }
    try {
      setMarkers(await loadTimeline(tagInfos, levels, range, nameById));
    } catch (e) {
      console.warn('[useChartAnnotations] Failed to load timeline markers:', e);
      setMarkers([]);
    }
  }, [tagIds, tagById, levels, range, nameById]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const allMarkers = markers;
  const markerTypeGroups = useMemo(() => distinctMarkerTypes(allMarkers), [allMarkers]);

  const chartMarkers = useMemo(
    () =>
      showMarkers
        ? allMarkers.filter(
            (m) => !hiddenMarkerIds.has(m.id) && !hiddenTypes.has(markerTypeKey(m.source, m.type)),
          )
        : [],
    [showMarkers, allMarkers, hiddenMarkerIds, hiddenTypes],
  );

  const toggleMarker = useCallback((id: string, visible: boolean) => {
    setHiddenMarkerIds((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllMarkers = useCallback(
    (visible: boolean) => {
      setHiddenMarkerIds((prev) => {
        const next = new Set(prev);
        for (const m of allMarkers) {
          if (visible) next.delete(m.id);
          else next.add(m.id);
        }
        return next;
      });
    },
    [allMarkers],
  );

  const toggleMarkerType = useCallback((key: string, visible: boolean) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const currentUserId = getFabricAccountId() ?? undefined;

  const buildDefaultScope = useCallback((): AnnotationScope | null => {
    const firstTagId = tagIds[0];
    if (!firstTagId) return null;
    const t = tagById.get(firstTagId);
    if (!t) return null;
    return { type: 'TagId', id: t.tagId, label: t.tagName };
  }, [tagIds, tagById]);

  const openCreate = useCallback(
    (start: Date, end: Date | null) => {
      setError(null);
      setDialogMode('create');
      setDialogInitial({ start, end, scope: buildDefaultScope() });
      setDialogOpen(true);
    },
    [buildDefaultScope],
  );

  const beginSelecting = useCallback(() => {
    setError(null);
    setSelecting(true);
  }, []);

  const cancelSelecting = useCallback(() => setSelecting(false), []);

  const handleBrushEndDates = useCallback(
    (chartStart: Date, chartEnd: Date) => {
      setSelecting(false);
      const start = new Date(fromChartMs(chartStart.getTime(), offsetMinutes));
      const end = new Date(fromChartMs(chartEnd.getTime(), offsetMinutes));
      const isPoint = end.getTime() - start.getTime() < 1000;
      openCreate(start, isPoint ? null : end);
    },
    [offsetMinutes, openCreate],
  );

  const onBrushEndEvent = useCallback(
    (params: unknown) => {
      const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas;
      const coordRange = areas?.[0]?.coordRange;
      if (!coordRange || coordRange.length !== 2) return;
      const [chartStartMs, chartEndMs] = coordRange;
      if (chartStartMs == null || chartEndMs == null || chartEndMs < chartStartMs) return;
      handleBrushEndDates(new Date(chartStartMs), new Date(chartEndMs));
    },
    [handleBrushEndDates],
  );

  const openEdit = useCallback(
    (marker: TimelineMarker) => {
      if (marker.source !== 'annotation') return;
      const scope: AnnotationScope = {
        type: marker.scopeType!,
        id: marker.scopeId!,
        label: marker.scopeLabel,
      };
      setError(null);
      setDialogMode('edit');
      setDialogInitial({
        id: marker.annotationId,
        start: new Date(fromChartMs(marker.timestamp.getTime(), offsetMinutes)),
        end: marker.endTimestamp
          ? new Date(fromChartMs(marker.endTimestamp.getTime(), offsetMinutes))
          : null,
        scope,
        annotationType: marker.type,
        title: marker.title,
        detail: marker.detail ?? undefined,
      });
      setDialogOpen(true);
    },
    [offsetMinutes],
  );

  const handleDeleteAnnotation = useCallback(
    async (marker: TimelineMarker) => {
      if (!marker.annotationId) return;
      if (!window.confirm(`Delete annotation “${marker.title}”? This cannot be undone.`)) {
        return;
      }
      try {
        setError(null);
        await deleteAnnotation(marker.annotationId);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to delete annotation.');
      }
    },
    [refresh],
  );

  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const clearError = useCallback(() => setError(null), []);

  return {
    allMarkers,
    chartMarkers,
    markerTypeGroups,
    hiddenMarkerIds,
    hiddenTypes,
    toggleMarker,
    toggleAllMarkers,
    toggleMarkerType,
    currentUserId,
    chartRef,
    selecting,
    beginSelecting,
    cancelSelecting,
    onBrushEndEvent,
    handleBrushEndDates,
    openCreate,
    openEdit,
    handleDeleteAnnotation,
    dialogOpen,
    dialogMode,
    dialogInitial,
    closeDialog,
    reload: () => {
      refresh().catch(() => {});
    },
    error,
    clearError,
  };
}
