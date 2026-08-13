/**
 * Pure builder that turns a generated Activator similarity query + email
 * configuration into a Fabric Activator (Reflex) item definition, matching the
 * known-good template captured from a real Activator (KQL-source + on-each-event
 * + Email). The output is the `definition` payload accepted by the Fabric
 * `POST /workspaces/{id}/reflexes` API: two base64-encoded parts,
 * `ReflexEntities.json` and `.platform`.
 *
 * The graph is only four entities (no Object/Attribute wiring):
 *   1. container-v1
 *   2. kqlSource-v1        — the scheduled KQL data source
 *   3. timeSeriesView-v1   — Event (SourceEvent template) referencing the source
 *   4. timeSeriesView-v1   — Rule (EventTrigger template): on-each-event → email
 *
 * See activator-reference-notes.md and reflex-ReflexEntities.json for the field
 * mapping this builder reproduces.
 */

const PLATFORM_SCHEMA =
  'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json';
const ALL_ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const SOURCE_EVENT_TEMPLATE_VERSION = '1.3.0';
const EVENT_TRIGGER_TEMPLATE_VERSION = '1.3.0';

export interface ReflexDefinitionInput {
  /** Display name of the Reflex item + rule. */
  displayName: string;
  /** Optional description (container + platform metadata). */
  description?: string;

  // --- KQL source ----------------------------------------------------------
  /** The self-contained similarity KQL to run on a schedule. */
  queryString: string;
  /** Run interval in seconds (= runSettings.executionIntervalInSeconds). */
  frequencySeconds: number;
  /** KQL Database item id the query runs against (eventhouseItem.itemId / querySetId). */
  kqlDatabaseItemId: string;
  /** Workspace id that owns the KQL Database. */
  kqlWorkspaceId: string;

  // --- Email action --------------------------------------------------------
  /** Recipient — the signed-in creator's email. */
  creatorEmail: string;
  /** Base subject text the user provides (the tag summary column is appended). */
  subjectBase: string;
  /** Result column whose value is appended to the subject line. */
  subjectField: string;
  /** Headline text (user-configurable). */
  headline: string;
  /** Notes body (optionalMessage) — prefilled + editable. */
  notes: string;
  /** Result columns surfaced (fixed) in the Activator context area. */
  contextFields: string[];
  /** Message locale (defaults to en-us). */
  messageLocale?: string;

  /** GUID factory (injectable for deterministic tests). */
  newGuid?: () => string;
}

export interface ReflexDefinitionPart {
  path: string;
  payload: string;
  payloadType: 'InlineBase64';
}

export interface ReflexDefinition {
  parts: ReflexDefinitionPart[];
}

export interface BuiltReflexDefinition {
  /** The ReflexEntities.json entity array (pre-encode, for tests/inspection). */
  entities: unknown[];
  /** The .platform object (pre-encode, for tests/inspection). */
  platform: unknown;
  /** The base64-encoded definition payload for the Create Reflex API. */
  definition: ReflexDefinition;
}

/** UTF-8 safe base64 (works in the browser and in the vitest/node runtime). */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Inverse of {@link toBase64}: decode a base64 payload back to a UTF-8 string. */
function fromBase64(payload: string): string {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** One `{type:string,value}` array item (static subject/headline/notes text). */
function stringPart(value: string) {
  return { type: 'string', value };
}

/** An `EventFieldReference` that appends a result column value inline. */
function fieldReferencePart(fieldName: string) {
  return {
    kind: 'EventFieldReference',
    type: 'complex',
    arguments: [{ name: 'fieldName', type: 'string', value: fieldName }],
  };
}

/** A `NameReferencePair` naming a result column for the context area. */
function nameReferencePair(fieldName: string) {
  return {
    kind: 'NameReferencePair',
    type: 'complex',
    arguments: [
      { name: 'name', type: 'string', value: fieldName },
      {
        kind: 'EventFieldReference',
        type: 'complexReference',
        arguments: [{ name: 'fieldName', type: 'string', value: fieldName }],
        name: 'reference',
      },
    ],
  };
}

/**
 * Build the Reflex item definition (entities + platform, base64-encoded) from
 * the generated query and email configuration.
 */
export function buildReflexDefinition(input: ReflexDefinitionInput): BuiltReflexDefinition {
  const guid = input.newGuid ?? (() => crypto.randomUUID());
  const description = input.description ?? '';
  const locale = input.messageLocale ?? 'en-us';

  const containerId = guid();
  const sourceId = guid();
  const eventId = guid();
  const ruleId = guid();
  const queryId = guid();
  const sourceStepId = guid();
  const fieldsStepId = guid();
  const detectStepId = guid();
  const actStepId = guid();

  // 1. Container -----------------------------------------------------------
  const container = {
    uniqueIdentifier: containerId,
    payload: {
      name: input.displayName,
      description,
      type: 'kqlQueries',
    },
    type: 'container-v1',
  };

  // 2. KQL source ----------------------------------------------------------
  const kqlSource = {
    uniqueIdentifier: sourceId,
    payload: {
      name: `${input.displayName} event`,
      runSettings: {
        executionIntervalInSeconds: input.frequencySeconds,
      },
      query: {
        queryString: input.queryString,
      },
      eventhouseItem: {
        itemId: input.kqlDatabaseItemId,
        workspaceId: input.kqlWorkspaceId,
        itemType: 'KustoDatabase',
      },
      queryParameters: [],
      metadata: {
        workspaceId: input.kqlWorkspaceId,
        querySetId: input.kqlDatabaseItemId,
        queryId,
      },
      parentContainer: {
        targetUniqueIdentifier: containerId,
      },
    },
    type: 'kqlSource-v1',
  };

  // 3. Event (SourceEvent template) ---------------------------------------
  const eventInstance = {
    steps: [
      {
        id: sourceStepId,
        name: 'SourceEventStep',
        rows: [
          {
            arguments: [{ name: 'entityId', type: 'string', value: sourceId }],
            kind: 'SourceReference',
            name: 'SourceSelector',
          },
        ],
      },
    ],
    templateId: 'SourceEvent',
    templateVersion: SOURCE_EVENT_TEMPLATE_VERSION,
  };
  const eventView = {
    uniqueIdentifier: eventId,
    payload: {
      name: `${input.displayName} event`,
      parentContainer: { targetUniqueIdentifier: containerId },
      definition: {
        type: 'Event',
        instance: JSON.stringify(eventInstance),
      },
    },
    type: 'timeSeriesView-v1',
  };

  // 4. Rule (EventTrigger template): on-each-event → email -----------------
  const subjectValues = [stringPart(`${input.subjectBase} `), fieldReferencePart(input.subjectField)];
  const emailArguments = [
    { name: 'messageLocale', type: 'string', value: locale },
    { name: 'sentTo', type: 'array', values: [{ type: 'string', value: input.creatorEmail }] },
    { name: 'copyTo', type: 'array', values: [] },
    { name: 'bCCTo', type: 'array', values: [] },
    { name: 'subject', type: 'array', values: subjectValues },
    { name: 'headline', type: 'array', values: [stringPart(input.headline)] },
    { name: 'optionalMessage', type: 'array', values: [stringPart(input.notes)] },
    {
      name: 'additionalInformation',
      type: 'array',
      values: input.contextFields.map(nameReferencePair),
    },
  ];
  const ruleInstance = {
    templateId: 'EventTrigger',
    templateVersion: EVENT_TRIGGER_TEMPLATE_VERSION,
    steps: [
      {
        name: 'FieldsDefaultsStep',
        id: fieldsStepId,
        rows: [
          {
            name: 'EventSelector',
            kind: 'Event',
            arguments: [
              {
                kind: 'EventReference',
                type: 'complex',
                arguments: [{ name: 'entityId', type: 'string', value: eventId }],
                name: 'event',
              },
            ],
          },
        ],
      },
      {
        name: 'EventDetectStep',
        id: detectStepId,
        rows: [{ name: 'OnEveryValue', kind: 'OnEveryValue', arguments: [] }],
      },
      {
        name: 'ActStep',
        id: actStepId,
        rows: [{ name: 'EmailBinding', kind: 'EmailMessage', arguments: emailArguments }],
      },
    ],
  };
  const ruleView = {
    uniqueIdentifier: ruleId,
    payload: {
      name: input.displayName,
      parentContainer: { targetUniqueIdentifier: containerId },
      definition: {
        type: 'Rule',
        instance: JSON.stringify(ruleInstance),
        settings: {
          shouldRun: true,
          shouldApplyRuleOnUpdate: false,
        },
      },
    },
    type: 'timeSeriesView-v1',
  };

  const entities = [container, kqlSource, eventView, ruleView];

  const platform = {
    $schema: PLATFORM_SCHEMA,
    metadata: {
      type: 'Reflex',
      displayName: input.displayName,
      description,
    },
    config: {
      version: '2.0',
      logicalId: ALL_ZERO_GUID,
    },
  };

  const definition: ReflexDefinition = {
    parts: [
      {
        path: 'ReflexEntities.json',
        payload: toBase64(JSON.stringify(entities)),
        payloadType: 'InlineBase64',
      },
      {
        path: '.platform',
        payload: toBase64(JSON.stringify(platform)),
        payloadType: 'InlineBase64',
      },
    ],
  };

  return { entities, platform, definition };
}

/**
 * Append freshly-built entities to an EXISTING Reflex item's definition without
 * disturbing its current entities. Given the base64 definition parts returned by
 * getReflexDefinition, this decodes the `ReflexEntities.json` part, concatenates
 * `newEntities`, re-encodes it, and preserves every other part (notably
 * `.platform`) verbatim. Pure + non-destructive: it only ADDS entities.
 *
 * A generated alert contributes its own container + kqlSource + Event + Rule, so
 * appending them adds an independent rule alongside whatever the Activator
 * already contains.
 */
export function appendEntitiesToDefinition(
  existingParts: Array<{ path: string; payload: string; payloadType: string }>,
  newEntities: unknown[],
): ReflexDefinition {
  const parts = existingParts.map((p) => {
    if (p.path === 'ReflexEntities.json') {
      let current: unknown[] = [];
      try {
        const decoded = JSON.parse(fromBase64(p.payload));
        if (Array.isArray(decoded)) current = decoded;
      } catch {
        current = [];
      }
      const merged = [...current, ...newEntities];
      return {
        path: p.path,
        payload: toBase64(JSON.stringify(merged)),
        payloadType: 'InlineBase64' as const,
      };
    }
    return { path: p.path, payload: p.payload, payloadType: 'InlineBase64' as const };
  });
  return { parts };
}
