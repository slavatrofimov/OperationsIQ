import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorMessageBar } from '../components/ErrorMessageBar';
import {
  Body1,
  Button,
  Caption1,
  Card,
  Badge,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Link,
  Spinner,
  Subtitle1,
  Text,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowClockwise24Regular, Delete24Regular, Open16Regular } from '@fluentui/react-icons';
import {
  listActivatorAlerts,
  deleteActivatorAlert,
  type ActivatorAlert,
} from '../lib/activatorAlerts';
import { frequencyLabelFor } from '../lib/activator/frequency';
import { PageIntro } from '../components/PageIntro';
import { useProfile } from '../context/ProfileContext';
import type { PageKey } from '../lib/pages';
import type { NavPreset } from '../lib/personas';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: 0 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  emptyCard: {
    padding: tokens.spacingVerticalXXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    alignItems: 'center',
    textAlign: 'center',
  },
  alertCard: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  alertHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  title: { flex: 1, minWidth: 0 },
  meta: { color: tokens.colorNeutralForeground3 },
  tags: { color: tokens.colorNeutralForeground2 },
  guide: {
    padding: tokens.spacingVerticalL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  guideGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: tokens.spacingHorizontalL,
  },
  guideCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalL,
    alignItems: 'flex-start',
  },
  guideCardBody: { color: tokens.colorNeutralForeground2 },
  guideCardSpacer: { flex: 1 },
});

/**
 * Activator Alerts: lists the app-side POINTERS to Fabric Activator (Reflex)
 * alerts created from similarity searches. Each row deep-links to the Activator
 * in Fabric. Deleting a row removes ONLY the app pointer — the Fabric Activator
 * item, its rule, and its schedule are left running untouched.
 */
export function ActivatorAlertsPage({
  onNavigate,
}: {
  onNavigate: (page: PageKey, preset?: NavPreset) => void;
}) {
  const styles = useStyles();
  const toasterId = useId('activator-alerts-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const { activeProfile } = useProfile();

  const [alerts, setAlerts] = useState<ActivatorAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ActivatorAlert | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Only show alerts that belong to the active connection profile, so alerts
  // created against other profiles don't leak into this view. Alerts stamp the
  // profile NAME at create time (activatorAlerts.connectionProfileName).
  const visibleAlerts = useMemo(
    () =>
      activeProfile
        ? alerts.filter((a) => a.connectionProfileName === activeProfile.name)
        : alerts,
    [alerts, activeProfile],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAlerts(await listActivatorAlerts());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteActivatorAlert(pendingDelete.id);
      setAlerts((prev) => prev.filter((a) => a.id !== pendingDelete.id));
      dispatchToast(
        <Toast>
          <ToastTitle>Pointer removed (the Fabric Activator was left untouched)</ToastTitle>
        </Toast>,
        { intent: 'success', timeout: 4000 },
      );
      setPendingDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, dispatchToast]);

  return (
    <div className={styles.root}>
      <Toaster toasterId={toasterId} />
      <div className={styles.toolbar}>
        <Subtitle1>Activator Alerts</Subtitle1>
        <div className={styles.spacer} />
        <Button
          appearance="subtle"
          icon={<ArrowClockwise24Regular />}
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <ErrorMessageBar error={error} />
      )}

      <PageIntro
        title="Activator Alerts"
        overview="Activator Alerts let Fabric watch your signals for you and notify you when a pattern of interest reappears. Set one up from a similarity search or a multi-signal anomaly detection, then manage the app-side pointers to those alerts here."
        interpretation="Each row below points to a Fabric Activator (Reflex) that runs on a schedule. Use the two workflows below to decide how to create your next alert."
      />

      <div className={styles.guide}>
        <Subtitle1>Set up an Activator Alert</Subtitle1>
        <div className={styles.guideGrid}>
          <Card className={styles.guideCard}>
            <Text weight="semibold">Detect unusual patterns and multi-signal anomalies</Text>
            <Body1 className={styles.guideCardBody}>
              Surface behavior you don't have to describe in advance. Scan a single signal for unusual
              repeated shapes with SAX discords, or run a multivariate detector to catch joint anomalies
              that only show up when several signals move together. Then create an alert so Fabric emails
              you when a new unusual pattern or coordinated anomaly appears.
            </Body1>
            <div className={styles.guideCardSpacer} />
            <Button appearance="primary" onClick={() => onNavigate('discover')}>
              Open Anomalies
            </Button>
          </Card>
          <Card className={styles.guideCard}>
            <Text weight="semibold">Search for known patterns</Text>
            <Body1 className={styles.guideCardBody}>
              If you already know what an interesting or problematic time-series shape looks like, use
              Similarity search to find where that shape recurs across your signals — then create an
              Activator Alert so Fabric notifies you whenever it reappears.
            </Body1>
            <div className={styles.guideCardSpacer} />
            <Button appearance="primary" onClick={() => onNavigate('similarity')}>
              Open Similarity search
            </Button>
          </Card>
          <Card className={styles.guideCard}>
            <Text weight="semibold">Discover unknown patterns</Text>
            <Body1 className={styles.guideCardBody}>
              To surface patterns you don't yet know about, use Deep discovery in the Patterns menu to
              mine recurring motifs, anomalies, and regime changes. Save the ones that matter, use a
              saved pattern as a similarity query, and create an alert that fires when it re-emerges.
            </Body1>
            <div className={styles.guideCardSpacer} />
            <Button appearance="primary" onClick={() => onNavigate('patterns', { patternsTab: 'library' })}>
              Open Saved patterns
            </Button>
          </Card>
        </div>
      </div>

      {loading ? (
        <Card className={styles.emptyCard}>
          <Spinner size="small" label="Loading alerts…" />
        </Card>
      ) : visibleAlerts.length === 0 ? (
        <Card className={styles.emptyCard}>
          <Body1>No Activator Alerts yet</Body1>
          <Caption1>
            Run a similarity search or a multi-signal anomaly detection and choose “Create an alert”
            to schedule it in Fabric. The alerts you create will be listed here.
          </Caption1>
        </Card>
      ) : (
        visibleAlerts.map((a) => (
          <Card key={a.id} className={styles.alertCard}>
            <div className={styles.alertHeader}>
              <Badge
                appearance="tint"
                color={a.searchParams?.mode === 'anomaly' ? 'danger' : 'brand'}
              >
                {a.searchParams?.mode === 'anomaly' ? 'Anomaly' : 'Similarity'}
              </Badge>
              <div className={styles.title}>
                <Text weight="semibold">{a.displayName}</Text>
              </div>
              <Link href={a.webUrl} target="_blank" rel="noreferrer">
                Open in Fabric <Open16Regular />
              </Link>
              <Button
                appearance="subtle"
                icon={<Delete24Regular />}
                aria-label={`Delete pointer for ${a.displayName}`}
                onClick={() => setPendingDelete(a)}
              >
                Delete
              </Button>
            </div>
            <Caption1 className={styles.meta}>
              {a.connectionProfileName} · {frequencyLabelFor(a.frequency)} ·{' '}
              {a.createdAt.toLocaleString()}
            </Caption1>
            {a.tags.length > 0 && (
              <Caption1 className={styles.tags}>Signals: {a.tags.join(', ')}</Caption1>
            )}
          </Card>
        ))
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(_, d) => !d.open && !deleting && setPendingDelete(null)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete alert pointer?</DialogTitle>
            <DialogContent>
              <Text>
                This removes only the app-side pointer to{' '}
                <strong>{pendingDelete?.displayName}</strong>. The Fabric Activator item, its rule,
                and its schedule are <strong>not</strong> deleted and will keep running. To stop the
                alert, open it in Fabric and disable or delete the rule there.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPendingDelete(null)} disabled={deleting}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? <Spinner size="tiny" /> : 'Delete pointer'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
