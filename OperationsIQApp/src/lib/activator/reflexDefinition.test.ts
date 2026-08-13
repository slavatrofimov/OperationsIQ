import { describe, it, expect } from 'vitest';
import { buildReflexDefinition, appendEntitiesToDefinition } from './reflexDefinition';

/** Deterministic GUID factory for stable assertions. */
function seqGuid() {
  let n = 0;
  return () => `guid-${n++}`;
}

function build() {
  return buildReflexDefinition({
    displayName: 'My Alert',
    description: 'a test alert',
    queryString: 'SearchSpace | take 1',
    frequencySeconds: 900,
    kqlDatabaseItemId: 'db-123',
    kqlWorkspaceId: 'ws-456',
    creatorEmail: 'user@contoso.com',
    subjectBase: 'Pattern found',
    subjectField: 'SubjectTags',
    headline: 'The condition was met',
    notes: 'These are the notes',
    contextFields: ['TagId', 'MatchStart', 'Similarity'],
    newGuid: seqGuid(),
  });
}

describe('buildReflexDefinition', () => {
  it('produces exactly four entities of the expected types', () => {
    const { entities } = build();
    expect(entities).toHaveLength(4);
    const types = entities.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['container-v1', 'kqlSource-v1', 'timeSeriesView-v1', 'timeSeriesView-v1']);
  });

  it('wires the kqlSource to the container and eventhouse item', () => {
    const { entities } = build();
    const container = entities[0] as { uniqueIdentifier: string };
    const source = entities[1] as {
      payload: {
        runSettings: { executionIntervalInSeconds: number };
        query: { queryString: string };
        eventhouseItem: { itemId: string; workspaceId: string; itemType: string };
        metadata: { querySetId: string; workspaceId: string; queryId: string };
        parentContainer: { targetUniqueIdentifier: string };
      };
    };
    expect(source.payload.runSettings.executionIntervalInSeconds).toBe(900);
    expect(source.payload.query.queryString).toBe('SearchSpace | take 1');
    expect(source.payload.eventhouseItem).toEqual({
      itemId: 'db-123',
      workspaceId: 'ws-456',
      itemType: 'KustoDatabase',
    });
    expect(source.payload.metadata.querySetId).toBe('db-123');
    expect(source.payload.metadata.workspaceId).toBe('ws-456');
    expect(source.payload.parentContainer.targetUniqueIdentifier).toBe(container.uniqueIdentifier);
  });

  it('links the Event to the source and the Rule to the Event', () => {
    const { entities } = build();
    const sourceId = (entities[1] as { uniqueIdentifier: string }).uniqueIdentifier;
    const eventId = (entities[2] as { uniqueIdentifier: string }).uniqueIdentifier;
    const eventInstance = JSON.parse(
      (entities[2] as { payload: { definition: { instance: string } } }).payload.definition.instance,
    );
    expect(eventInstance.templateId).toBe('SourceEvent');
    expect(eventInstance.steps[0].rows[0].arguments[0].value).toBe(sourceId);

    const ruleInstance = JSON.parse(
      (entities[3] as { payload: { definition: { instance: string } } }).payload.definition.instance,
    );
    expect(ruleInstance.templateId).toBe('EventTrigger');
    const fieldsStep = ruleInstance.steps.find((s: { name: string }) => s.name === 'FieldsDefaultsStep');
    expect(fieldsStep.rows[0].arguments[0].arguments[0].value).toBe(eventId);
  });

  it('uses OnEveryValue (on each event) as the condition', () => {
    const { entities } = build();
    const ruleInstance = JSON.parse(
      (entities[3] as { payload: { definition: { instance: string } } }).payload.definition.instance,
    );
    const detect = ruleInstance.steps.find((s: { name: string }) => s.name === 'EventDetectStep');
    expect(detect.rows[0].kind).toBe('OnEveryValue');
  });

  it('emails the creator with a subject that appends the tag field', () => {
    const { entities } = build();
    const ruleInstance = JSON.parse(
      (entities[3] as { payload: { definition: { instance: string } } }).payload.definition.instance,
    );
    const act = ruleInstance.steps.find((s: { name: string }) => s.name === 'ActStep');
    const args = act.rows[0].arguments as Array<{ name: string; values?: unknown[] }>;
    const sentTo = args.find((a) => a.name === 'sentTo');
    expect(sentTo!.values).toEqual([{ type: 'string', value: 'user@contoso.com' }]);

    const subject = args.find((a) => a.name === 'subject');
    expect(subject!.values![0]).toEqual({ type: 'string', value: 'Pattern found ' });
    expect(subject!.values![1]).toMatchObject({
      kind: 'EventFieldReference',
      arguments: [{ name: 'fieldName', value: 'SubjectTags' }],
    });

    const notes = args.find((a) => a.name === 'optionalMessage');
    expect(notes!.values![0]).toEqual({ type: 'string', value: 'These are the notes' });

    const context = args.find((a) => a.name === 'additionalInformation');
    expect(context!.values).toHaveLength(3);
    expect((context!.values![0] as { arguments: Array<{ value: string }> }).arguments[0].value).toBe('TagId');
  });

  it('enables the rule (shouldRun) and does not run on update', () => {
    const { entities } = build();
    const settings = (
      entities[3] as { payload: { definition: { settings: { shouldRun: boolean; shouldApplyRuleOnUpdate: boolean } } } }
    ).payload.definition.settings;
    expect(settings).toEqual({ shouldRun: true, shouldApplyRuleOnUpdate: false });
  });

  it('emits a Reflex .platform part with version 2.0 and the all-zero logicalId', () => {
    const { platform } = build();
    expect(platform).toMatchObject({
      metadata: { type: 'Reflex', displayName: 'My Alert' },
      config: { version: '2.0', logicalId: '00000000-0000-0000-0000-000000000000' },
    });
  });

  it('base64-encodes both definition parts', () => {
    const { definition } = build();
    expect(definition).not.toHaveProperty('format');
    expect(definition.parts.map((p) => p.path)).toEqual(['ReflexEntities.json', '.platform']);
    const entitiesJson = new TextDecoder().decode(
      Uint8Array.from(atob(definition.parts[0].payload), (ch) => ch.charCodeAt(0)),
    );
    expect(JSON.parse(entitiesJson)).toHaveLength(4);
  });

  it('never emits absolute datetime literals in the embedded query', () => {
    const { entities } = build();
    const q = (entities[1] as { payload: { query: { queryString: string } } }).payload.query.queryString;
    expect(q).not.toContain('datetime(');
  });
});

describe('appendEntitiesToDefinition', () => {
  it('appends new entities to an existing ReflexEntities.json part and preserves .platform', () => {
    const existingEntities = [{ uniqueIdentifier: 'existing-1', type: 'container-v1', payload: {} }];
    const platformPayload = btoa('{"metadata":{"type":"Reflex"}}');
    const existingParts = [
      {
        path: 'ReflexEntities.json',
        payload: btoa(JSON.stringify(existingEntities)),
        payloadType: 'InlineBase64',
      },
      { path: '.platform', payload: platformPayload, payloadType: 'InlineBase64' },
    ];

    const { entities } = build();
    const merged = appendEntitiesToDefinition(existingParts, entities);

    const entitiesPart = merged.parts.find((p) => p.path === 'ReflexEntities.json')!;
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(entitiesPart.payload), (ch) => ch.charCodeAt(0))),
    ) as Array<{ uniqueIdentifier: string }>;
    // 1 existing + 4 appended, existing first (non-destructive).
    expect(decoded).toHaveLength(5);
    expect(decoded[0].uniqueIdentifier).toBe('existing-1');

    // .platform is passed through untouched.
    const platformPart = merged.parts.find((p) => p.path === '.platform')!;
    expect(platformPart.payload).toBe(platformPayload);
  });
});
