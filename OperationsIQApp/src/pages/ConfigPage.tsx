/**
 * ConfigPage: full-page form for creating or editing a Connection Profile.
 * Supports Fabric workspace/Eventhouse discovery, KQL query editing with
 * preview, and terminology label overrides. On save, persists to the Rayfin
 * backend via connectionProfile helpers.
 */

import { useCallback, useState, Fragment } from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Divider,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Spinner,
  SpinButton,
  Switch,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle24Regular, Warning24Regular, DismissCircle24Regular } from '@fluentui/react-icons';
import type { ConnectionProfile, ProfileLabels } from '../lib/connectionProfile';
import { PageIntro } from '../components/PageIntro';
import {
  saveProfile,
  updateProfile,
  profileToKqlOpts,
  DEFAULT_HIERARCHY_QUERY,
  DEFAULT_METADATA_QUERY,
  DEFAULT_EVENTS_QUERY,
  DEFAULT_TIMESERIES_QUERY,
  DEFAULT_LABELS,
  DEFAULT_SIGNAL_ID_DELIMITER,
  MAX_SIGNAL_ID_DELIMITER_LENGTH,
  DEFAULT_WIDE_TIMESERIES_QUERY,
} from '../lib/connectionProfile';
import {
  validateProfileComponents,
  validateWideTimeseries,
  type ValidationResult,
  type ComponentCheck,
  type WideValidationResult,
} from '../lib/eventhouseValidation';
import { CANONICAL_SPECS, WIDE_TIMESERIES_SPEC } from '../lib/canonicalModel';
import { KqlQueryBuilder } from '../components/KqlQueryBuilder';
import {
  listFabricWorkspaces,
  listEventhouses,
  listKqlDatabaseItems,
  type FabricWorkspace,
  type FabricEventhouse,
  type FabricKqlDatabase,
} from '../lib/fabricDiscovery';
import { queryRows } from '../lib/eventhouse';
import { EXPLAINERS } from '../lib/explainers';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    maxWidth: '860px',
    padding: tokens.spacingVerticalL,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  sectionTitle: {
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: tokens.spacingVerticalS,
  },
  grid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
  },
  row: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  footer: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM,
  },
  testResult: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  labelGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
    alignItems: 'center',
  },
  checkList: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    alignItems: 'start',
  },
  layoutToggle: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  exampleGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: tokens.spacingHorizontalL,
    marginTop: tokens.spacingVerticalS,
  },
  exampleCard: {
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: tokens.fontSizeBase200,
    overflowX: 'auto',
  },
  codeTable: {
    borderCollapse: 'collapse',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke2}`,
      padding: `2px ${tokens.spacingHorizontalXS}`,
      textAlign: 'left',
    },
  },
});

const LABEL_FIELDS: { key: keyof ProfileLabels; label: string }[] = [
  { key: 'entityLabel', label: 'Entity (e.g. "Asset", "Patient")' },
  { key: 'metricIdLabel', label: 'Signal ID (e.g. "Tag", "Sensor")' },
  { key: 'unitOfMeasureLabel', label: 'Unit of Measure label' },
  { key: 'samplingFrequencyLabel', label: 'Sampling Frequency label' },
  { key: 'level1Label', label: 'Level 1 label' },
  { key: 'level2Label', label: 'Level 2 label' },
  { key: 'level3Label', label: 'Level 3 label' },
  { key: 'level4Label', label: 'Level 4 label' },
  { key: 'level5Label', label: 'Level 5 label' },
  { key: 'level6Label', label: 'Level 6 label' },
  { key: 'level7Label', label: 'Level 7 label' },
  { key: 'level8Label', label: 'Level 8 label' },
  { key: 'level9Label', label: 'Level 9 label' },
  { key: 'level10Label', label: 'Level 10 label' },
];

/** Per-check status icon for the validation results list. */
function CheckIcon({ status }: { status: ComponentCheck['status'] }) {
  if (status === 'pass') {
    return <CheckmarkCircle24Regular color={tokens.colorStatusSuccessForeground1} />;
  }
  if (status === 'warn') {
    return <Warning24Regular color={tokens.colorStatusWarningForeground1} />;
  }
  return <DismissCircle24Regular color={tokens.colorStatusDangerForeground1} />;
}

/** MessageBar intent for the overall validation summary. */
function validationSummaryIntent(result: ValidationResult): 'success' | 'warning' | 'error' {
  if (!result.ok) return 'error';
  if (result.checks.some((c) => c.status === 'warn')) return 'warning';
  return 'success';
}

/** One-line human summary of a validation run. */
function validationSummaryText(result: ValidationResult): string {
  const failed = result.checks.filter((c) => c.status === 'fail').length;
  const warned = result.checks.filter((c) => c.status === 'warn').length;
  if (!result.ok) {
    return `${failed} required component${failed === 1 ? '' : 's'} missing. Fix these before using this profile.`;
  }
  if (warned > 0) {
    return `All required components present. ${warned} optional component${warned === 1 ? '' : 's'} absent (those features degrade gracefully).`;
  }
  return 'All components present. This database is ready for the app.';
}

export interface ConfigPageProps {
  /** When provided, load this profile for editing. If absent, create new. */
  profile?: ConnectionProfile | null;
  onSaved: (profile: ConnectionProfile) => void;
  onCancel: () => void;
}

/** Full-page connection profile editor. */
export function ConfigPage({ profile, onSaved, onCancel }: ConfigPageProps) {
  const styles = useStyles();
  // Editing an existing profile PATCHes its backend row; with no profile we are
  // creating a new one, pre-filled from the DEFAULT_* canonical starter queries.
  const isEditing = !!profile;

  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [queryUri, setQueryUri] = useState(profile?.eventhouseQueryUri ?? '');
  const [dbName, setDbName] = useState(profile?.databaseName ?? '');
  const [dbItemId, setDbItemId] = useState(profile?.kqlDatabaseId ?? '');
  const [hierarchyQuery, setHierarchyQuery] = useState(
    profile?.hierarchyQuery ?? DEFAULT_HIERARCHY_QUERY,
  );
  const [metadataQuery, setMetadataQuery] = useState(
    profile?.metadataQuery ?? DEFAULT_METADATA_QUERY,
  );
  const [eventsQuery, setEventsQuery] = useState(profile?.eventsQuery ?? DEFAULT_EVENTS_QUERY);
  const [timeseriesQuery, setTimeseriesQuery] = useState(
    profile?.timeseriesQuery ?? DEFAULT_TIMESERIES_QUERY,
  );
  const [timeseriesIsWide, setTimeseriesIsWide] = useState<boolean>(
    profile?.timeseriesIsWide ?? false,
  );
  const [signalIdDelimiter, setSignalIdDelimiter] = useState<string>(
    profile?.signalIdDelimiter ?? DEFAULT_SIGNAL_ID_DELIMITER,
  );
  const [labels, setLabels] = useState<ProfileLabels>({ ...DEFAULT_LABELS, ...profile?.labels });
  // Show as many level-label rows as the edited profile actually customises, so
  // levels 5-10 aren't hidden (and silently uneditable) when editing.
  const [numLevels, setNumLevels] = useState(() => {
    if (!profile) return 4;
    for (let n = 10; n >= 1; n--) {
      const key = `level${n}Label` as keyof ProfileLabels;
      const val = profile.labels?.[key];
      if (val && val !== DEFAULT_LABELS[key]) return n;
    }
    return 4;
  });

  const [discLoading, setDiscLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<FabricWorkspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<string>(profile?.fabricWorkspaceId ?? '');
  const [eventhouses, setEventhouses] = useState<FabricEventhouse[]>([]);
  const [ehLoading, setEhLoading] = useState(false);
  const [selectedEh, setSelectedEh] = useState<string>(profile?.eventhouseId ?? '');
  const [databases, setDatabases] = useState<FabricKqlDatabase[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [discError, setDiscError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [testMsg, setTestMsg] = useState('');

  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [wideValidating, setWideValidating] = useState(false);
  const [wideValidation, setWideValidation] = useState<WideValidationResult | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleDiscover = useCallback(async () => {
    setDiscLoading(true);
    setDiscError(null);
    setWorkspaces([]);
    setEventhouses([]);
    setDatabases([]);
    try {
      // Interactive: prompts for account + consent to the Fabric read scopes on
      // first use. Must run from this click handler so the popup is not blocked.
      const ws = await listFabricWorkspaces({ interactive: true });
      if (ws.length === 0) throw new Error('No Fabric workspaces are accessible to this account. Confirm you have access to at least one workspace, or enter the Eventhouse endpoint manually below.');
      setWorkspaces(ws);
    } catch (e) {
      setDiscError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscLoading(false);
    }
  }, []);

  const handleWorkspaceChange = useCallback(async (wsId: string) => {
    setSelectedWs(wsId);
    setEventhouses([]);
    setSelectedEh('');
    setDatabases([]);
    setDbItemId('');
    setDiscError(null);
    if (!wsId) return;
    setEhLoading(true);
    try {
      const ehs = await listEventhouses(wsId, { interactive: true });
      setEventhouses(ehs);
      if (ehs.length === 0) {
        setDiscError('No Eventhouses found in this workspace. Pick another workspace or enter the endpoint manually below.');
      }
    } catch (e) {
      setDiscError(e instanceof Error ? e.message : String(e));
    } finally {
      setEhLoading(false);
    }
  }, []);

  const handleEventhouseChange = useCallback(async (ehId: string) => {
    setSelectedEh(ehId);
    setDatabases([]);
    setDbName('');
    setDbItemId('');
    const eh = eventhouses.find((e) => e.id === ehId);
    if (!eh) return;
    setQueryUri(eh.queryServiceUri);
    setDbLoading(true);
    try {
      const dbs = await listKqlDatabaseItems(selectedWs, ehId);
      setDatabases(dbs);
      if (dbs.length === 1) {
        setDbName(dbs[0].displayName);
        setDbItemId(dbs[0].id);
      }
      if (dbs.length === 0) {
        setDiscError('No databases found for this Eventhouse. Enter the database name manually below.');
      }
    } catch (e) {
      setDiscError(e instanceof Error ? e.message : String(e));
    } finally {
      setDbLoading(false);
    }
  }, [eventhouses, selectedWs]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestOk(null);
    setTestMsg('');
    try {
      if (!queryUri.trim()) throw new Error('Eventhouse Query URI is required.');
      if (!dbName.trim()) throw new Error('Database name is required.');
      const rows = await queryRows<{ ConnectionTest: number }>(
        'print ConnectionTest = 1',
        { queryUri: queryUri.trim(), db: dbName.trim() },
      );
      setTestOk(true);
      setTestMsg(
        rows[0]?.ConnectionTest === 1
          ? 'Connected. Query endpoint responded successfully.'
          : 'Connected, but the test query returned an unexpected response.',
      );
    } catch (e) {
      setTestOk(false);
      setTestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, [queryUri, dbName]);

  // Validate that the selected database has the components the profile needs
  // (canonical queries resolve, required result tables present). Read-only.
  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidation(null);
    setValidationError(null);
    try {
      if (!queryUri.trim()) throw new Error('Eventhouse Query URI is required.');
      if (!dbName.trim()) throw new Error('Database name is required.');
      const result = await validateProfileComponents({
        queryUri: queryUri.trim(),
        db: dbName.trim(),
        profileId: profile?.id,
        hierarchyQuery,
        metadataQuery,
        eventsQuery,
        timeseriesQuery,
      });
      setValidation(result);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      setValidating(false);
    }
  }, [queryUri, dbName, profile, hierarchyQuery, metadataQuery, eventsQuery, timeseriesQuery]);

  // Toggle between narrow and wide time-series layouts. Swap in the matching
  // starter query only when the editor still holds the other layout's default,
  // so we never clobber a query the user has customised.
  const handleWideToggle = useCallback((checked: boolean) => {
    setTimeseriesIsWide(checked);
    setWideValidation(null);
    setTimeseriesQuery((q) => {
      const t = q.trim();
      if (checked && t === DEFAULT_TIMESERIES_QUERY.trim()) return DEFAULT_WIDE_TIMESERIES_QUERY;
      if (!checked && t === DEFAULT_WIDE_TIMESERIES_QUERY.trim()) return DEFAULT_TIMESERIES_QUERY;
      return q;
    });
  }, []);

  // Validate a wide base query's schema (read-only `getschema` probe): fixed
  // columns present + >= 2 numeric value columns + no delimiter collisions.
  const handleValidateWide = useCallback(async () => {
    setWideValidating(true);
    setWideValidation(null);
    try {
      if (!queryUri.trim()) throw new Error('Eventhouse Query URI is required.');
      if (!dbName.trim()) throw new Error('Database name is required.');
      const result = await validateWideTimeseries({
        queryUri: queryUri.trim(),
        db: dbName.trim(),
        baseQuery: timeseriesQuery,
        delimiter: signalIdDelimiter || DEFAULT_SIGNAL_ID_DELIMITER,
      });
      setWideValidation(result);
    } catch (e) {
      setWideValidation({
        status: 'fail',
        ok: false,
        valueColumns: [],
        collisions: [],
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWideValidating(false);
    }
  }, [queryUri, dbName, timeseriesQuery, signalIdDelimiter]);

  // Save
  const handleSave = useCallback(async () => {
    if (!name.trim()) { setSaveError('Profile name is required.'); return; }
    if (!queryUri.trim()) { setSaveError('Eventhouse Query URI is required.'); return; }
    if (!dbName.trim()) { setSaveError('Database name is required.'); return; }
    if (timeseriesIsWide && signalIdDelimiter.length === 0) {
      setSaveError('Signal Id Delimiter is required for wide time-series profiles (at least one character).');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const data = {
        name: name.trim(),
        description: description.trim() || undefined,
        eventhouseQueryUri: queryUri.trim().replace(/\/+$/, ''),
        databaseName: dbName.trim(),
        fabricWorkspaceId: selectedWs || undefined,
        eventhouseId: selectedEh || undefined,
        kqlDatabaseId: dbItemId || undefined,
        hierarchyQuery,
        metadataQuery,
        eventsQuery,
        timeseriesQuery,
        timeseriesIsWide,
        signalIdDelimiter: timeseriesIsWide
          ? (signalIdDelimiter || DEFAULT_SIGNAL_ID_DELIMITER)
          : undefined,
        labels,
      };
      if (isEditing && profile) {
        await updateProfile(profile.id, data);
        onSaved({ ...profile, ...data });
      } else {
        const id = await saveProfile(data);
        onSaved({ ...data, id, userId: '', createdAt: new Date() });
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [name, description, queryUri, dbName, selectedWs, selectedEh, dbItemId, hierarchyQuery, metadataQuery, eventsQuery, timeseriesQuery, timeseriesIsWide, signalIdDelimiter, labels, isEditing, profile, onSaved]);

  const kqlOpts = profileToKqlOpts({
    id: '', userId: '', name, eventhouseQueryUri: queryUri, databaseName: dbName,
    hierarchyQuery, metadataQuery, eventsQuery, timeseriesQuery, labels, createdAt: new Date(),
  });

  const setLabel = (key: keyof ProfileLabels, val: string) =>
    setLabels((prev) => ({ ...prev, [key]: val }));

  // Visible level-label fields
  const levelLabelFields = LABEL_FIELDS.filter((f) => {
    const match = f.key.match(/^level(\d+)Label$/);
    if (!match) return true;
    return Number(match[1]) <= numLevels;
  });

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text size={600} weight="semibold">
          {isEditing ? 'Edit Connection' : 'Configure Connection'}
        </Text>
      </div>

      <PageIntro
        title="Connections"
        overview={EXPLAINERS.config.overview}
        interpretation={EXPLAINERS.config.interpretation}
      />

      {/* Profile name */}
      <Field label="Profile Name" required>
        <Input
          value={name}
          onChange={(_, d) => setName(d.value)}
          placeholder="e.g. Contoso Manufacturing"
          style={{ maxWidth: 400 }}
        />
      </Field>

      {/* Profile description — free-text context surfaced to the Operations Advisor */}
      <Field
        label="Description"
        hint="Optional. Briefly describe what this data represents (site, process, domain). Shared with the Operations Advisor to improve its situational awareness."
      >
        <Textarea
          value={description}
          onChange={(_, d) => setDescription(d.value)}
          placeholder="e.g. Contoso's Detroit stamping plant — press-line hydraulics, motor currents, and temperatures sampled at 1s."
          resize="vertical"
          style={{ maxWidth: 600 }}
        />
      </Field>

      <Accordion multiple collapsible>
        {/* Section: Eventhouse Connection */}
        <AccordionItem value="connection">
          <AccordionHeader>Eventhouse Connection</AccordionHeader>
          <AccordionPanel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              {/* Fabric discovery */}
              <div className={styles.row}>
                <Button
                  appearance="secondary"
                  onClick={handleDiscover}
                  disabled={discLoading}
                  icon={discLoading ? <Spinner size="tiny" /> : undefined}
                >
                  Discover from Fabric
                </Button>
              </div>
              {discError && (
                <MessageBar intent="warning">
                  <MessageBarBody>{discError}</MessageBarBody>
                </MessageBar>
              )}
              {workspaces.length > 0 && (
                <div className={styles.grid2}>
                  <Field label="Workspace">
                    <Dropdown
                      placeholder="Select workspace…"
                      value={workspaces.find((w) => w.id === selectedWs)?.displayName ?? ''}
                      selectedOptions={selectedWs ? [selectedWs] : []}
                      onOptionSelect={(_, d) => handleWorkspaceChange(d.optionValue as string)}
                    >
                      {workspaces.map((ws) => (
                        <Option key={ws.id} value={ws.id}>{ws.displayName}</Option>
                      ))}
                    </Dropdown>
                  </Field>
                  {selectedWs && (
                    <Field
                      label="Eventhouse"
                      validationState={ehLoading ? 'none' : undefined}
                      validationMessage={ehLoading ? 'Loading Eventhouses…' : undefined}
                    >
                      <Dropdown
                        placeholder={ehLoading ? 'Loading…' : 'Select Eventhouse…'}
                        disabled={ehLoading || eventhouses.length === 0}
                        value={eventhouses.find((e) => e.id === selectedEh)?.displayName ?? ''}
                        selectedOptions={selectedEh ? [selectedEh] : []}
                        onOptionSelect={(_, d) => handleEventhouseChange(d.optionValue as string)}
                      >
                        {eventhouses.map((eh) => (
                          <Option key={eh.id} value={eh.id}>{eh.displayName}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                  )}
                  {selectedEh && (
                    <Field
                      label="Database"
                      validationState={dbLoading ? 'none' : undefined}
                      validationMessage={dbLoading ? 'Loading databases…' : undefined}
                    >
                      <Dropdown
                        placeholder={dbLoading ? 'Loading…' : 'Select database…'}
                        disabled={dbLoading || databases.length === 0}
                        value={dbName}
                        selectedOptions={dbItemId ? [dbItemId] : []}
                        onOptionSelect={(_, d) => {
                          const item = databases.find((db) => db.id === d.optionValue);
                          if (item) {
                            setDbName(item.displayName);
                            setDbItemId(item.id);
                          }
                        }}
                      >
                        {databases.map((db) => (
                          <Option key={db.id} value={db.id}>{db.displayName}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                  )}
                </div>
              )}

              <Divider>Manual override</Divider>

              <div className={styles.grid2}>
                <Field label="Query URI" required>
                  <Input
                    value={queryUri}
                    onChange={(_, d) => {
                      setQueryUri(d.value);
                      // Manual edit breaks the discovery link: the captured Fabric
                      // ids no longer correspond, so drop them (no runtime fallback).
                      setSelectedWs('');
                      setSelectedEh('');
                      setDbItemId('');
                    }}
                    placeholder="https://…"
                  />
                </Field>
                <Field label="Database Name" required>
                  <Input
                    value={dbName}
                    onChange={(_, d) => {
                      setDbName(d.value);
                      // Manual edit breaks the discovery link: the captured KQL
                      // database id no longer corresponds, so drop it.
                      setDbItemId('');
                    }}
                    placeholder="e.g. ContosoMfg"
                  />
                </Field>
              </div>

              {/* Test connection */}
              <div className={styles.row}>
                <Button
                  appearance="secondary"
                  onClick={handleTest}
                  disabled={testing || !queryUri.trim()}
                  icon={testing ? <Spinner size="tiny" /> : undefined}
                >
                  Test Connection
                </Button>
                {testOk === true && (
                  <div className={styles.testResult}>
                    <CheckmarkCircle24Regular color={tokens.colorStatusSuccessForeground1} />
                    <Text>{testMsg}</Text>
                  </div>
                )}
                {testOk === false && (
                  <MessageBar intent="error">
                    <MessageBarBody>{testMsg}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </div>
          </AccordionPanel>
        </AccordionItem>

        {/* Section: Query Configuration */}
        <AccordionItem value="queries">
          <AccordionHeader>Query Configuration</AccordionHeader>
          <AccordionPanel>
            <Accordion multiple collapsible>
              {(
                [
                  { key: 'hierarchy' as const, query: hierarchyQuery, onChange: setHierarchyQuery },
                  { key: 'metadata' as const, query: metadataQuery, onChange: setMetadataQuery },
                  { key: 'events' as const, query: eventsQuery, onChange: setEventsQuery },
                ] as const
              ).map(({ key, query, onChange }) => (
                <AccordionItem key={key} value={key}>
                  <AccordionHeader>{CANONICAL_SPECS[key].label}</AccordionHeader>
                  <AccordionPanel>
                    <KqlQueryBuilder
                      query={query}
                      onChange={onChange as (kql: string) => void}
                      spec={CANONICAL_SPECS[key]}
                      profileOpts={kqlOpts}
                    />
                  </AccordionPanel>
                </AccordionItem>
              ))}

              {/* Time series: narrow/wide toggle drives which editor is shown. */}
              <AccordionItem value="timeseries">
                <AccordionHeader>Time Series</AccordionHeader>
                <AccordionPanel>
                  <div className={styles.layoutToggle}>
                    <Switch
                      checked={timeseriesIsWide}
                      onChange={(_e, d) => handleWideToggle(d.checked)}
                      label={
                        timeseriesIsWide
                          ? 'Wide layout: one row per timestamp, multiple value columns'
                          : 'Narrow layout: one row per (signal, timestamp) sample'
                      }
                    />
                    <Text size={200}>
                      Choose how your source time-series table is shaped. In a <b>narrow</b> table each
                      row is a single sample identified by a <code>SignalId</code>. In a <b>wide</b> table
                      each row carries many measurements at one timestamp, one per value column — the app
                      unpivots it to the narrow shape at query time.
                    </Text>
                    <div className={styles.exampleGrid}>
                      <div className={styles.exampleCard}>
                        <Text size={200} weight="semibold">Narrow</Text>
                        <table className={styles.codeTable}>
                          <thead>
                            <tr><th>SignalId</th><th>Timestamp</th><th>Value</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Pump7-Temp</td><td>08:00</td><td>72.4</td></tr>
                            <tr><td>Pump7-Press</td><td>08:00</td><td>13.1</td></tr>
                            <tr><td>Pump7-Temp</td><td>08:01</td><td>72.6</td></tr>
                          </tbody>
                        </table>
                      </div>
                      <div className={styles.exampleCard}>
                        <Text size={200} weight="semibold">Wide</Text>
                        <table className={styles.codeTable}>
                          <thead>
                            <tr><th>SignalIdPrefix</th><th>Timestamp</th><th>Temp</th><th>Press</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Pump7</td><td>08:00</td><td>72.4</td><td>13.1</td></tr>
                            <tr><td>Pump7</td><td>08:01</td><td>72.6</td><td>13.0</td></tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  {timeseriesIsWide ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Emit exactly <code>SignalIdPrefix</code> (string) and <code>Timestamp</code>{' '}
                          (datetime), plus at least two real value columns with any names. The canonical
                          signal id is <code>SignalIdPrefix&nbsp;+&nbsp;delimiter&nbsp;+&nbsp;column name</code>,
                          so your Hierarchy and Metadata queries must emit matching{' '}
                          <code>SignalId</code> values.
                        </MessageBarBody>
                      </MessageBar>
                      <Field
                        label="Signal Id Delimiter"
                        required
                        validationState={signalIdDelimiter.length === 0 ? 'error' : 'none'}
                        validationMessage={
                          signalIdDelimiter.length === 0
                            ? 'Enter at least one character.'
                            : undefined
                        }
                        hint={`1 to ${MAX_SIGNAL_ID_DELIMITER_LENGTH} characters (default "${DEFAULT_SIGNAL_ID_DELIMITER}"). Pick a delimiter that never appears in a SignalIdPrefix or a value-column name, or the signal id split will be ambiguous.`}
                      >
                        <Input
                          value={signalIdDelimiter}
                          onChange={(_e, d) =>
                            setSignalIdDelimiter(d.value.slice(0, MAX_SIGNAL_ID_DELIMITER_LENGTH))
                          }
                          maxLength={MAX_SIGNAL_ID_DELIMITER_LENGTH}
                          style={{ maxWidth: '120px' }}
                        />
                      </Field>
                      <KqlQueryBuilder
                        query={timeseriesQuery}
                        onChange={setTimeseriesQuery}
                        spec={WIDE_TIMESERIES_SPEC}
                        profileOpts={kqlOpts}
                      />
                      <div>
                        <Button
                          appearance="secondary"
                          onClick={handleValidateWide}
                          disabled={wideValidating}
                          icon={wideValidating ? <Spinner size="tiny" /> : undefined}
                        >
                          Validate wide schema
                        </Button>
                        {wideValidation && (
                          <div style={{ marginTop: tokens.spacingVerticalS }}>
                            <MessageBar
                              intent={
                                wideValidation.status === 'pass'
                                  ? 'success'
                                  : wideValidation.status === 'warn'
                                    ? 'warning'
                                    : 'error'
                              }
                            >
                              <MessageBarBody>{wideValidation.detail}</MessageBarBody>
                            </MessageBar>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <KqlQueryBuilder
                      query={timeseriesQuery}
                      onChange={setTimeseriesQuery}
                      spec={CANONICAL_SPECS.timeseries}
                      profileOpts={kqlOpts}
                    />
                  )}
                </AccordionPanel>
              </AccordionItem>
            </Accordion>
          </AccordionPanel>
        </AccordionItem>

        {/* Section: Terminology */}
        <AccordionItem value="labels">
          <AccordionHeader>Terminology (optional)</AccordionHeader>
          <AccordionPanel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Field label="Number of hierarchy levels">
                <SpinButton
                  value={numLevels}
                  min={1}
                  max={10}
                  onChange={(_, d) => setNumLevels(Number(d.value ?? 4))}
                  style={{ maxWidth: 120 }}
                />
              </Field>
              <div className={styles.labelGrid}>
                {levelLabelFields.map(({ key, label }) => (
                  <Fragment key={key}>
                    <Text size={200}>{label}</Text>
                    <Input
                      value={labels[key]}
                      onChange={(_, d) => setLabel(key, d.value)}
                      placeholder={DEFAULT_LABELS[key]}
                      style={{ maxWidth: 260 }}
                    />
                  </Fragment>
                ))}
              </div>
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>

      {/* Component validation: confirm the selected database is app-ready. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
        <div className={styles.row}>
          <Button
            appearance="secondary"
            onClick={handleValidate}
            disabled={validating || !queryUri.trim() || !dbName.trim()}
            icon={validating ? <Spinner size="tiny" /> : undefined}
          >
            Validate components
          </Button>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            Read-only check that the canonical queries resolve and the required
            result tables exist on the selected database.
          </Text>
        </div>
        {validationError && (
          <MessageBar intent="error">
            <MessageBarBody>{validationError}</MessageBarBody>
          </MessageBar>
        )}
        {validation && (
          <>
            <MessageBar intent={validationSummaryIntent(validation)}>
              <MessageBarBody>{validationSummaryText(validation)}</MessageBarBody>
            </MessageBar>
            <div className={styles.checkList}>
              {validation.checks.map((c) => (
                <Fragment key={`${c.category}:${c.name}`}>
                  <CheckIcon status={c.status} />
                  <div>
                    <Text size={200} weight="semibold">{c.name}</Text>
                    {c.detail && (
                      <Text size={100} block style={{ color: tokens.colorNeutralForeground3 }}>
                        {c.status === 'warn' ? 'Optional — ' : ''}
                        {c.detail}
                      </Text>
                    )}
                  </div>
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>

      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>{saveError}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.footer}>
        <Button
          appearance="primary"
          onClick={handleSave}
          disabled={saving}
          icon={saving ? <Spinner size="tiny" /> : undefined}
        >
          {isEditing ? 'Save Changes' : 'Save'}
        </Button>
        <Button appearance="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
