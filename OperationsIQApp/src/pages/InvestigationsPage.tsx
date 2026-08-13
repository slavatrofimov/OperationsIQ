import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Divider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Subtitle1,
  Subtitle2,
  Text,
  Title3,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular,
  Delete20Regular,
  Star20Filled,
  Star20Regular,
} from '@fluentui/react-icons';
import { MarkdownView } from '../components/MarkdownView';
import { PageIntro } from '../components/PageIntro';
import { useActiveInvestigation } from '../context/ActiveInvestigationContext';
import { downloadText, downloadDataUrl, fileStamp } from '../lib/export';
import { EXPLAINERS } from '../lib/explainers';
import {
  deleteEvidence,
  deleteInvestigation,
  getEvidence,
  listEvidence,
  listInvestigations,
  type Evidence,
  type EvidenceArtifact,
  type EvidenceWithArtifacts,
  type Investigation,
} from '../lib/evidence';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  layout: { display: 'flex', gap: tokens.spacingHorizontalL, alignItems: 'stretch' },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    minWidth: 0,
  },
  investigationsPanel: { width: '180px', flexGrow: 0, flexShrink: 0 },
  evidencePanel: { width: '200px', flexGrow: 0, flexShrink: 0 },
  previewPanel: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: tokens.spacingVerticalM },
  divider: { flexGrow: 0, flexShrink: 0 },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalXS,
  },
  scroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    overflowY: 'auto',
    overflowX: 'hidden',
    maxHeight: '70vh',
  },
  detail: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  item: {
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    minWidth: 0,
    overflowWrap: 'anywhere',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  itemActive: { backgroundColor: tokens.colorBrandBackground2 },
  row: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3, minWidth: 0, overflowWrap: 'anywhere' },
  emptyHint: { color: tokens.colorNeutralForeground3, padding: tokens.spacingVerticalS },
  image: {
    maxWidth: '100%',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  chartBlock: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
});

/** Group artifacts by chart ordinal so PNG + CSV of the same chart render together. */
function groupCharts(artifacts: EvidenceArtifact[]): Map<number, { png?: EvidenceArtifact; csv?: EvidenceArtifact; title: string }> {
  const map = new Map<number, { png?: EvidenceArtifact; csv?: EvidenceArtifact; title: string }>();
  for (const a of artifacts) {
    if (a.kind === 'markdown') continue;
    const entry = map.get(a.ordinal) ?? { title: a.title };
    entry.title = a.title;
    if (a.kind === 'png') entry.png = a;
    else if (a.kind === 'csv') entry.csv = a;
    map.set(a.ordinal, entry);
  }
  return map;
}

export function InvestigationsPage() {
  const styles = useStyles();
  const { active, setActive, clearActive, reconcile } = useActiveInvestigation();
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [selectedInv, setSelectedInv] = useState<Investigation | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceWithArtifacts | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInvestigations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listInvestigations();
      setInvestigations(list);
      setSelectedInv((prev) => list.find((i) => i.id === prev?.id) ?? list[0] ?? null);
      // Drop/refresh the active investigation against the latest known list.
      reconcile(list.map((i) => ({ id: i.id, name: i.name })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [reconcile]);

  useEffect(() => {
    loadInvestigations();
  }, [loadInvestigations]);

  useEffect(() => {
    if (!selectedInv) {
      setEvidence([]);
      setSelectedEvidence(null);
      return;
    }
    listEvidence(selectedInv.id)
      .then((list) => {
        setEvidence(list);
        setSelectedEvidence(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [selectedInv]);

  const openEvidence = async (id: string) => {
    setError(null);
    try {
      setSelectedEvidence(await getEvidence(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteInvestigation = async (inv: Investigation) => {
    if (!window.confirm(`Delete investigation “${inv.name}” and all its evidence?`)) return;
    setBusy('delete-inv');
    try {
      await deleteInvestigation(inv.id);
      if (active?.id === inv.id) clearActive();
      await loadInvestigations();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteEvidence = async (id: string) => {
    if (!window.confirm('Delete this evidence?')) return;
    setBusy('delete-ev');
    try {
      await deleteEvidence(id);
      if (selectedInv) setEvidence(await listEvidence(selectedInv.id));
      setSelectedEvidence(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadPng = (a: EvidenceArtifact) =>
    downloadDataUrl(`${a.title}_${fileStamp()}.png`, `data:${a.mime};base64,${a.content}`);
  const downloadCsv = (a: EvidenceArtifact, title: string) =>
    downloadText(`${title}_${fileStamp()}.csv`, a.content);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Title3>Investigations</Title3>
        <div className={styles.spacer} />
      </div>

      <PageIntro
        title="Investigations"
        overview={EXPLAINERS.investigations.overview}
        interpretation={EXPLAINERS.investigations.interpretation}
      />

      {error && (
        <MessageBar intent="info">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {loading ? (
        <Spinner label="Loading investigations…" />
      ) : investigations.length === 0 ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>No investigations yet.</MessageBarTitle>
            Use “Add to investigation” on any analysis page to capture your first piece of evidence.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <div className={styles.layout}>
          {/* Panel 1 — Investigations */}
          <div className={`${styles.panel} ${styles.investigationsPanel}`}>
            <div className={styles.panelHeader}>
              <Subtitle2>Investigations ({investigations.length})</Subtitle2>
            </div>
            <div className={styles.scroll}>
              {investigations.map((inv) => {
                const isActive = active?.id === inv.id;
                return (
                  <div
                    key={inv.id}
                    className={`${styles.item} ${selectedInv?.id === inv.id ? styles.itemActive : ''}`}
                    onClick={() => setSelectedInv(inv)}
                  >
                    <div className={styles.row}>
                      <Body1 style={{ flex: 1 }}>{inv.name}</Body1>
                      <Tooltip
                        content={
                          isActive
                            ? 'Active — click to deactivate (stops routing new evidence here)'
                            : 'Set as active (new evidence goes here)'
                        }
                        relationship="label"
                      >
                        <ToggleButton
                          appearance={isActive ? 'primary' : 'subtle'}
                          shape="circular"
                          size="small"
                          checked={isActive}
                          icon={isActive ? <Star20Filled /> : <Star20Regular />}
                          aria-pressed={isActive}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isActive) clearActive();
                            else setActive({ id: inv.id, name: inv.name });
                          }}
                        >
                          {isActive ? 'Active' : 'Set active'}
                        </ToggleButton>
                      </Tooltip>
                      <Tooltip content="Delete investigation" relationship="label">
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<Delete20Regular />}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteInvestigation(inv);
                          }}
                        />
                      </Tooltip>
                    </div>
                    {inv.description && <Caption1 className={styles.meta}>{inv.description}</Caption1>}
                  </div>
                );
              })}
            </div>
          </div>

          <Divider vertical className={styles.divider} style={{ alignSelf: 'stretch' }} />

          {/* Panel 2 — Evidence list for the selected investigation */}
          <div className={`${styles.panel} ${styles.evidencePanel}`}>
            {selectedInv ? (
              <>
                <div className={styles.panelHeader}>
                  <Subtitle2>Evidence ({evidence.length})</Subtitle2>
                  {active?.id === selectedInv.id && (
                    <Badge appearance="tint" color="brand" size="small">
                      Active
                    </Badge>
                  )}
                </div>
                {evidence.length === 0 ? (
                  <Caption1 className={styles.emptyHint}>No evidence captured yet.</Caption1>
                ) : (
                  <div className={styles.scroll}>
                    {evidence.map((ev) => {
                      return (
                        <div
                          key={ev.id}
                          className={`${styles.item} ${selectedEvidence?.evidence.id === ev.id ? styles.itemActive : ''}`}
                          onClick={() => openEvidence(ev.id)}
                        >
                          <div className={styles.row}>
                            <Body1 style={{ flex: 1 }}>{ev.page_name}</Body1>
                            <Caption1 className={styles.meta}>
                              {new Date(ev.created_at).toLocaleString()}
                            </Caption1>
                          </div>
                          <div className={styles.row}>
                            <Caption1 className={styles.meta}>{ev.user_name}</Caption1>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <Caption1 className={styles.emptyHint}>Select an investigation.</Caption1>
            )}
          </div>

          <Divider vertical className={styles.divider} style={{ alignSelf: 'stretch' }} />

          {/* Panel 3 — Preview of the selected evidence */}
          <div className={`${styles.panel} ${styles.previewPanel}`}>
            {selectedInv && (
              <>
                <Subtitle1>{selectedInv.name}</Subtitle1>
                {selectedInv.description && <Body1 className={styles.meta}>{selectedInv.description}</Body1>}
              </>
            )}
            {selectedEvidence ? (
              <>
                <Divider />
                <EvidenceDetail
                  data={selectedEvidence}
                  onDelete={() => handleDeleteEvidence(selectedEvidence.evidence.id)}
                  onDownloadPng={downloadPng}
                  onDownloadCsv={downloadCsv}
                  deleting={busy === 'delete-ev'}
                />
              </>
            ) : (
              <Caption1 className={styles.emptyHint}>
                {selectedInv
                  ? 'Select a piece of evidence to preview it here.'
                  : 'Select an investigation to get started.'}
              </Caption1>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface EvidenceDetailProps {
  data: EvidenceWithArtifacts;
  onDelete: () => void;
  onDownloadPng: (a: EvidenceArtifact) => void;
  onDownloadCsv: (a: EvidenceArtifact, title: string) => void;
  deleting: boolean;
}

function EvidenceDetail({ data, onDelete, onDownloadPng, onDownloadCsv, deleting }: EvidenceDetailProps) {
  const styles = useStyles();
  const { evidence, artifacts } = data;
  const charts = groupCharts(artifacts);

  return (
    <div className={styles.detail}>
      <div className={styles.row}>
        <Subtitle1 style={{ flex: 1 }}>{evidence.page_name}</Subtitle1>
        <Button appearance="subtle" size="small" icon={<Delete20Regular />} onClick={onDelete} disabled={deleting}>
          Delete
        </Button>
      </div>
      <Caption1 className={styles.meta}>
        Captured by {evidence.user_name} on {new Date(evidence.created_at).toLocaleString()}
      </Caption1>

      {evidence.annotation && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Annotation</MessageBarTitle>
            {evidence.annotation}
          </MessageBarBody>
        </MessageBar>
      )}

      <Card>
        <MarkdownView markdown={evidence.markdown} />
      </Card>

      {charts.size > 0 && (
        <>
          <Subtitle2>Charts ({charts.size})</Subtitle2>
          {Array.from(charts.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([ordinal, chart]) => (
              <div key={ordinal} className={styles.chartBlock}>
                <div className={styles.row}>
                  <Text weight="semibold" style={{ flex: 1 }}>
                    {chart.title}
                  </Text>
                  {chart.png && (
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ArrowDownload20Regular />}
                      onClick={() => onDownloadPng(chart.png!)}
                    >
                      PNG
                    </Button>
                  )}
                  {chart.csv && chart.csv.content && (
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<ArrowDownload20Regular />}
                      onClick={() => onDownloadCsv(chart.csv!, chart.title)}
                    >
                      CSV
                    </Button>
                  )}
                </div>
                {chart.png && (
                  <img
                    className={styles.image}
                    src={`data:${chart.png.mime};base64,${chart.png.content}`}
                    alt={chart.title}
                  />
                )}
              </div>
            ))}
        </>
      )}
    </div>
  );
}
