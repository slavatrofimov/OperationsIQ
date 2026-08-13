import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  useRegisterCaptureContext,
  type CaptureContextSummary,
} from '../context/CaptureContext';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Card,
  Dropdown,
  Option,
  Spinner,
  Subtitle1,
  Subtitle2,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload24Regular,
  CheckmarkCircle24Regular,
  ClipboardTaskListLtr24Regular,
  Dismiss24Regular,
  Prohibited24Regular,
} from '@fluentui/react-icons';
import {
  listAlertEvents,
  acknowledgeAlert,
  suppressAlert,
  closeAlert,
  reopenAlert,
  exportEvidenceBundle,
  createWorkOrder,
  isActive,
  type AlertEventView,
  type AlertSeverity,
} from '../lib/alertCenter';
import { PageIntro } from '../components/PageIntro';
import { OutputDescription } from '../components/OutputDescription';
import { EXPLAINERS } from '../lib/explainers';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  card: { padding: tokens.spacingVerticalL },
  tableScroll: { overflowX: 'auto', maxWidth: '100%' },
  // Finding column holds a title plus tag id / free-text message; let the flex
  // cell shrink and wrap instead of overflowing into the Status column.
  findingCell: { minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  count: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center' },
});

const SEVERITY_COLOR: Record<AlertSeverity, 'informative' | 'warning' | 'danger'> = {
  info: 'informative',
  warning: 'warning',
  critical: 'danger',
};

const STATUS_COLOR: Record<string, 'brand' | 'success' | 'subtle' | 'warning'> = {
  OPEN: 'brand',
  ACK: 'warning',
  SUPPRESSED: 'subtle',
  CLOSED: 'success',
};

function fmt(d: Date | undefined): string {
  if (!d) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Findings (functional spec §Alert center): the operational queue where
 * analysts triage recorded findings — acknowledge, suppress (alarm-storm
 * control), close, and export an evidence bundle for escalation/handover.
 * Repeated firings collapse into one row with an occurrence count.
 */
export function AlertCenterPage() {
  const styles = useStyles();
  const [events, setEvents] = useState<AlertEventView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEvents(await listAlertEvents());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(
    () => (filter === 'active' ? events.filter((e) => isActive(e)) : events),
    [events, filter],
  );

  const counts = useMemo(() => {
    const active = events.filter((e) => isActive(e));
    return {
      open: active.filter((e) => e.status === 'OPEN').length,
      ack: active.filter((e) => e.status === 'ACK').length,
      critical: active.filter((e) => e.severity === 'critical').length,
    };
  }, [events]);

  const captureSummary = useMemo<CaptureContextSummary>(
    () => ({
      sections: [
        {
          title: 'Filters',
          fields: [
            { label: 'View', value: filter === 'active' ? 'Active queue' : 'All events' },
            { label: 'Events shown', value: String(visible.length) },
          ],
        },
        {
          title: 'Active summary',
          fields: [
            { label: 'Open', value: String(counts.open) },
            { label: 'Acknowledged', value: String(counts.ack) },
            { label: 'Critical', value: String(counts.critical) },
          ],
        },
      ],
    }),
    [filter, visible.length, counts],
  );
  useRegisterCaptureContext(captureSummary);

  const runAction = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusyId(id);
      try {
        await fn();
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Subtitle1>Diagnostic Findings</Subtitle1>
        <div className={styles.count}>
          <Badge appearance="tint" color="brand">
            {counts.open} open
          </Badge>
          <Badge appearance="tint" color="warning">
            {counts.ack} acknowledged
          </Badge>
          <Badge appearance="tint" color="danger">
            {counts.critical} critical
          </Badge>
        </div>
        <div className={styles.spacer} />
        <Dropdown
          value={filter === 'active' ? 'Active queue' : 'All events'}
          selectedOptions={[filter]}
          onOptionSelect={(_, d) => setFilter((d.optionValue as 'active' | 'all') ?? 'active')}
        >
          <Option value="active">Active queue</Option>
          <Option value="all">All events</Option>
        </Dropdown>
        <Button appearance="secondary" onClick={() => void reload()} disabled={loading}>
          Refresh
        </Button>
      </div>

      <PageIntro
        title="Diagnostic Findings"
        overview={EXPLAINERS.alerts.overview}
        interpretation={EXPLAINERS.alerts.interpretation}
        technical={EXPLAINERS.alerts.technical}
      />

      <OutputDescription label="Findings summary">
        {EXPLAINERS.alerts.outputs!.summary}
      </OutputDescription>

      {error && (
        <ErrorMessageBar error={error} />
      )}

      <Card className={styles.card}>
        {loading ? (
          <Spinner label="Loading findings\u2026" />
        ) : visible.length === 0 ? (
          <Body1>
            {filter === 'active'
              ? 'No active findings. The queue is clear.'
              : 'No findings yet. Findings recorded from Monitor or Control chart will appear here.'}
          </Body1>
        ) : (
          <>
            <OutputDescription label="Findings queue">
              {EXPLAINERS.alerts.outputs!.queue}
            </OutputDescription>
            <div className={styles.tableScroll}>
            <Table size="small">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Severity</TableHeaderCell>
                  <TableHeaderCell>Finding</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Count</TableHeaderCell>
                  <TableHeaderCell>Last seen</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Badge appearance="filled" color={SEVERITY_COLOR[e.severity]}>
                        {e.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className={styles.findingCell}>
                      <div>
                        <Subtitle2>{e.title}</Subtitle2>
                        <br />
                        <Caption1>
                          {e.tagId}
                          {e.message ? ` · ${e.message}` : ''}
                          {e.assignee ? ` · @${e.assignee}` : ''}
                        </Caption1>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge appearance="tint" color={STATUS_COLOR[e.status] ?? 'subtle'}>
                        {e.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Text>{e.occurrenceCount}×</Text>
                    </TableCell>
                    <TableCell>
                      <Caption1>{fmt(e.lastOccurrenceAt ?? e.updatedAt)}</Caption1>
                    </TableCell>
                    <TableCell>
                      <div className={styles.actions}>
                        {e.status === 'OPEN' && (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<CheckmarkCircle24Regular />}
                            disabled={busyId === e.id}
                            onClick={() => void runAction(e.id, () => acknowledgeAlert(e))}
                          >
                            Ack
                          </Button>
                        )}
                        {(e.status === 'OPEN' || e.status === 'ACK') && (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Prohibited24Regular />}
                            disabled={busyId === e.id}
                            onClick={() => void runAction(e.id, () => suppressAlert(e, 60))}
                          >
                            Suppress 1h
                          </Button>
                        )}
                        {e.status !== 'CLOSED' ? (
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Dismiss24Regular />}
                            disabled={busyId === e.id}
                            onClick={() => void runAction(e.id, () => closeAlert(e))}
                          >
                            Close
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            appearance="subtle"
                            disabled={busyId === e.id}
                            onClick={() => void runAction(e.id, () => reopenAlert(e))}
                          >
                            Reopen
                          </Button>
                        )}
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<ArrowDownload24Regular />}
                          onClick={() => exportEvidenceBundle(e)}
                        >
                          Evidence
                        </Button>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<ClipboardTaskListLtr24Regular />}
                          disabled={busyId === e.id}
                          onClick={() => void runAction(e.id, async () => {
                            await createWorkOrder(e);
                          })}
                        >
                          Work order
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
