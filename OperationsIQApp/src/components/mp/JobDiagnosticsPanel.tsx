import {
  Badge,
  Body1Strong,
  Button,
  Caption1,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';
import type { AnalysisJob } from '../../lib/mp/types';
import { describeJobStatus, humanizeStage, parseDriverLog } from '../../lib/mp/livyStatus';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalS },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    columnGap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalXS,
    alignItems: 'baseline',
  },
  key: { color: tokens.colorNeutralForeground3 },
  mono: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-all',
  },
  log: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    padding: tokens.spacingVerticalS,
    maxHeight: '220px',
    overflowY: 'auto',
    margin: 0,
  },
  stuck: { color: tokens.colorStatusWarningForeground1 },
  error: { color: tokens.colorStatusDangerForeground1, whiteSpace: 'pre-wrap' },
});

function Row({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  const styles = useStyles();
  if (!value) return null;
  return (
    <>
      <Caption1 className={styles.key}>{label}</Caption1>
      <Text size={200} className={mono ? styles.mono : undefined}>
        {value}
      </Text>
    </>
  );
}

/**
 * Troubleshooting panel for a Livy-backed analysis (design spec §8). Surfaces the Spark
 * session/statement identity, current state, elapsed time, driver-log tail and any error
 * so a stuck or failed job can actually be diagnosed instead of spinning forever.
 */
export function JobDiagnosticsPanel({ job }: { job: AnalysisJob }) {
  const styles = useStyles();
  const [showLog, setShowLog] = useState(false);
  const view = describeJobStatus(job);
  const log = parseDriverLog(job);
  const stage = humanizeStage(job.stage);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Body1Strong>Session details</Body1Strong>
        <Badge appearance="tint" color={view.tone === 'warning' ? 'warning' : view.tone === 'danger' ? 'danger' : view.tone === 'success' ? 'success' : 'informative'}>
          {view.label}
        </Badge>
      </div>

      {view.isStuck && (
        <Text size={200} className={styles.stuck}>
          {view.detail}
        </Text>
      )}

      <div className={styles.grid}>
        <Row label="Stage" value={stage} />
        <Row label="Livy state" value={job.livyState} />
        <Row label="Elapsed" value={view.isActive ? view.elapsedText : undefined} />
        <Row label="Session id" value={job.livySessionId} mono />
        <Row label="Statement id" value={job.livyStatementId} mono />
        <Row label="Spark app id" value={job.sparkAppId} mono />
        {typeof job.computeSeconds === 'number' && (
          <Row label="Compute" value={`${job.computeSeconds.toFixed(1)} s`} />
        )}
      </div>

      <Caption1 className={styles.key}>
        To view the details behind this job, visit the Monitor page in the Microsoft Fabric
        portal.
      </Caption1>

      {job.errorMessage && (
        <Text size={200} className={styles.error}>
          {job.errorMessage}
        </Text>
      )}

      {log.length > 0 && (
        <>
          <Button
            appearance="subtle"
            size="small"
            onClick={() => setShowLog((s) => !s)}
          >
            {showLog ? 'Hide driver log' : `Show driver log (${log.length} lines)`}
          </Button>
          {showLog && <pre className={styles.log}>{log.join('\n')}</pre>}
        </>
      )}

      {!job.livySessionId && !job.errorMessage && log.length === 0 && (
        <Caption1 className={styles.key}>
          No Spark session has been assigned yet. If this persists, the orchestrator may not
          have picked up the job or capacity is unavailable.
        </Caption1>
      )}
    </div>
  );
}
