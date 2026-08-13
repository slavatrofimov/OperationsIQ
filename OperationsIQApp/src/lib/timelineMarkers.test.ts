import { describe, it, expect } from 'vitest';
import { EVENT_MARKER_COLOR, rowToMarker, type TimelineRow } from './timelineMarkers';

const row = (overrides: Partial<TimelineRow> = {}): TimelineRow => ({
  EventId: 'e1',
  ScopeId: 't1',
  ScopeType: 'TagId',
  StartTimestamp: '2024-01-01T00:00:00Z',
  EndTimestamp: null,
  EventType: 'deploy',
  Title: 'Event',
  Detail: null,
  Source: 'Event',
  UserId: '',
  ...overrides,
});

describe('rowToMarker', () => {
  it('maps events with tag-name scope labels', () => {
    const marker = rowToMarker(row(), new Map([['t1', 'Tag 1']]));
    expect(marker.source).toBe('event');
    expect(marker.id).toBe('event:e1');
    expect(marker.scopeLabel).toBe('Tag 1');
    expect(marker.color).toBe(EVENT_MARKER_COLOR);
    expect(marker.timestamp.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(marker.annotationId).toBeUndefined();
    expect(marker.authorId).toBeUndefined();
  });

  it('maps non-tag scopes using the last segment of the full path as the label', () => {
    const marker = rowToMarker(
      row({ ScopeType: 'Level3', ScopeId: 'Contoso Plant 1/Assembly/Line A' }),
      new Map([['t1', 'Tag 1']]),
    );
    expect(marker.scopeLabel).toBe('Line A');
    expect(marker.scopeType).toBe('Level3');
    expect(marker.scopeId).toBe('Contoso Plant 1/Assembly/Line A');
  });

  it('maps annotations without shifting timestamps and wires author/id', () => {
    const marker = rowToMarker(
      row({
        EventId: 'a1',
        EventType: 'note',
        Title: 'Annotation',
        Detail: 'hello',
        Source: 'Annotation',
        UserId: 'u1',
        EndTimestamp: '2024-01-01T01:00:00Z',
      }),
      new Map([['t1', 'Tag 1']]),
    );
    expect(marker.source).toBe('annotation');
    expect(marker.id).toBe('annotation:a1');
    expect(marker.timestamp.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(marker.endTimestamp?.toISOString()).toBe('2024-01-01T01:00:00.000Z');
    expect(marker.annotationId).toBe('a1');
    expect(marker.authorId).toBe('u1');
  });

  it('keeps a null end timestamp null', () => {
    const marker = rowToMarker(row({ Source: 'Annotation' }), new Map());
    expect(marker.endTimestamp).toBeNull();
  });
});
