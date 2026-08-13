import { describe, it, expect, vi } from 'vitest';
import {
  buildMarkerPins,
  buildMarkerBands,
  buildMarkerSeries,
  markersNear,
  markersNearTooltipHtml,
  mergeAnnotationMarkers,
  createBrushEndHandler,
  truncateMarkerLabel,
  MAX_MARKER_LABEL_CHARS,
} from './annotationMarkers';
import type { TimelineMarker } from './timelineMarkers';

const marker = (overrides: Partial<TimelineMarker> = {}): TimelineMarker => ({
  source: 'annotation',
  id: 'annotation:a1',
  type: 'note',
  title: 'Test marker',
  detail: null,
  timestamp: new Date('2024-01-01T00:00:00Z'),
  endTimestamp: null,
  scopeLabel: 'Tag 1',
  color: '#123456',
  annotationId: 'a1',
  authorId: 'u1',
  ...overrides,
});

describe('buildMarkerPins / buildMarkerBands', () => {
  it('builds a pin per marker', () => {
    const pins = buildMarkerPins([marker()]);
    expect(pins).toHaveLength(1);
    expect(pins[0].xAxis).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    expect(pins[0].title).toBe('Test marker');
  });

  it('only builds bands for markers with an end timestamp', () => {
    const point = marker();
    const span = marker({ id: 'annotation:a2', endTimestamp: new Date('2024-01-02T00:00:00Z') });
    const bands = buildMarkerBands([point, span]);
    expect(bands).toHaveLength(1);
    expect(bands[0][0].xAxis).toBe(span.timestamp.getTime());
    expect(bands[0][1].xAxis).toBe(span.endTimestamp!.getTime());
  });
});

describe('buildMarkerSeries', () => {
  it('returns an empty array when there are no markers', () => {
    expect(buildMarkerSeries([])).toEqual([]);
  });

  it('returns one dataless series carrying a markLine (and markArea for spans)', () => {
    const span = marker({ endTimestamp: new Date('2024-01-02T00:00:00Z') });
    const series = buildMarkerSeries([span]) as Record<string, unknown>[];
    expect(series).toHaveLength(1);
    expect(series[0].type).toBe('line');
    expect(series[0].markLine).toBeTruthy();
    expect(series[0].markArea).toBeTruthy();
  });

  it('suppresses the markArea on-chart label so it does not double the markLine label', () => {
    const span = marker({ endTimestamp: new Date('2024-01-02T00:00:00Z') });
    const series = buildMarkerSeries([span]) as Record<string, unknown>[];
    const markArea = series[0].markArea as { label?: { show?: boolean } };
    expect(markArea.label?.show).toBe(false);
  });
});

describe('markersNear / markersNearTooltipHtml', () => {
  it('finds markers within the threshold of an axis value', () => {
    const m = marker();
    const axisMs = m.timestamp.getTime() + 500;
    expect(markersNear([m], axisMs, 1000)).toHaveLength(1);
    expect(markersNear([m], axisMs, 100)).toHaveLength(0);
  });

  it('renders an HTML fragment for nearby markers, with a separator when preceded by rows', () => {
    const m = marker();
    const html = markersNearTooltipHtml([m], m.timestamp.getTime(), 1000, true);
    expect(html).toContain('Test marker');
    expect(html).toContain('border-top');
  });

  it('renders no separator when there are no preceding rows', () => {
    const m = marker();
    const html = markersNearTooltipHtml([m], m.timestamp.getTime(), 1000, false);
    expect(html).toContain('Test marker');
    expect(html).not.toContain('border-top');
  });

  it('returns an empty string when nothing is near', () => {
    const m = marker();
    expect(markersNearTooltipHtml([m], m.timestamp.getTime() + 10_000, 100, false)).toBe('');
  });
});

describe('mergeAnnotationMarkers', () => {
  it('appends the marker series onto existing series without mutating the input', () => {
    const option = { series: [{ type: 'line', data: [] }] };
    const merged = mergeAnnotationMarkers(option, [marker()]) as { series: unknown[] };
    expect(option.series).toHaveLength(1);
    expect(merged.series).toHaveLength(2);
  });

  it('wraps an existing tooltip formatter to append nearby marker info', () => {
    const m = marker();
    const option = {
      series: [],
      tooltip: { formatter: () => 'base-html' },
    };
    const merged = mergeAnnotationMarkers(option, [m], {
      fullStart: m.timestamp.getTime() - 10_000,
      fullEnd: m.timestamp.getTime() + 10_000,
    }) as { tooltip: { formatter: (p: unknown) => string } };
    const html = merged.tooltip.formatter([{ axisValue: m.timestamp.getTime() }]);
    expect(html).toContain('base-html');
    expect(html).toContain('Test marker');
  });

  it('adds a brush + toolbox config when brushEnabled is true', () => {
    const merged = mergeAnnotationMarkers({ series: [] }, [], { brushEnabled: true }) as Record<
      string,
      unknown
    >;
    expect(merged.brush).toBeTruthy();
    expect(merged.toolbox).toBeTruthy();
  });

  it('omits brush + toolbox when brushEnabled is false/omitted', () => {
    const merged = mergeAnnotationMarkers({ series: [] }, []) as Record<string, unknown>;
    expect(merged.brush).toBeUndefined();
    expect(merged.toolbox).toBeUndefined();
  });
});

describe('truncateMarkerLabel', () => {
  it('leaves a short title intact', () => {
    expect(truncateMarkerLabel('Short')).toBe('Short');
  });

  it('leaves a title at exactly the max length intact', () => {
    const exact = 'x'.repeat(MAX_MARKER_LABEL_CHARS);
    expect(truncateMarkerLabel(exact)).toBe(exact);
  });

  it('truncates a long title to the max length with a trailing ellipsis', () => {
    const long = 'This is a very long marker title that overflows';
    const out = truncateMarkerLabel(long);
    expect(out.length).toBeLessThanOrEqual(MAX_MARKER_LABEL_CHARS);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(out).not.toBe(long);
  });

  it('honors a custom max length', () => {
    expect(truncateMarkerLabel('abcdef', 4)).toBe('abc\u2026');
  });
});

describe('buildMarkerSeries markLine label formatter', () => {
  it('truncates a long title to end with an ellipsis', () => {
    const series = buildMarkerSeries([marker()]) as Record<string, unknown>[];
    const markLine = series[0].markLine as {
      label: { formatter: (p: { data: { title?: string } }) => string };
    };
    const out = markLine.label.formatter({
      data: { title: 'This is a very long marker title that overflows' },
    });
    expect(out.endsWith('\u2026')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_MARKER_LABEL_CHARS);
  });

  it('leaves a short title untouched', () => {
    const series = buildMarkerSeries([marker()]) as Record<string, unknown>[];
    const markLine = series[0].markLine as {
      label: { formatter: (p: { data: { title?: string } }) => string };
    };
    expect(markLine.label.formatter({ data: { title: 'Short' } })).toBe('Short');
  });
});

describe('createBrushEndHandler', () => {
  it('resolves a drag (non-zero width range) to a start/end pair', () => {
    const onSelect = vi.fn();
    const handler = createBrushEndHandler(onSelect);
    handler({ areas: [{ coordRange: [1000, 5000] }] });
    expect(onSelect).toHaveBeenCalledWith(new Date(1000), new Date(5000));
  });

  it('resolves a click (zero-width range) to a point', () => {
    const onSelect = vi.fn();
    const handler = createBrushEndHandler(onSelect);
    handler({ areas: [{ coordRange: [2000, 2000] }] });
    expect(onSelect).toHaveBeenCalledWith(new Date(2000), new Date(2000));
  });

  it('ignores payloads without a resolvable coordRange', () => {
    const onSelect = vi.fn();
    const handler = createBrushEndHandler(onSelect);
    handler({ areas: [] });
    handler({});
    expect(onSelect).not.toHaveBeenCalled();
  });
});
