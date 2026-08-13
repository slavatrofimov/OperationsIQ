import { Badge, Button, Card, ProgressBar, Text, Tooltip, makeStyles, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { AnalysisJob } from '../../lib/mp/types';
import { ConvergenceMeter } from './ConvergenceMeter';
import { describeJobStatus } from '../../lib/mp/livyStatus';
import { formatDuration } from '../../lib/mp/units';
import { jobTypeLabel } from '../../lib/mp/naming';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  empty: { color: tokens.colorNeutralForeground3 },
  jobCard: {
    cursor: 'pointer',
    userSelect: 'none',
    borderLeft: `3px solid transparent`,
    '&:hover': { background: tokens.colorNeutralBackground2Hover },
  },
  jobCardSelected: {
    cursor: 'pointer',
    userSelect: 'none',
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    background: tokens.colorBrandBackground2,
    outline: `1px solid ${tokens.colorBrandStroke1}`,
    '&:hover': { background: tokens.colorBrandBackground2Hover },
  },
  jobHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  jobTitle: { minWidth: 0, display: 'flex', flexDirection: 'column' },
  subtle: { color: tokens.colorNeutralForeground3 },
  statusDetail: { color: tokens.colorNeutralForeground3 },
  completed: { color: tokens.colorNeutralForeground3 },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexShrink: 0,
  },
  waiting: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  stuck: { color: tokens.colorStatusWarningForeground1 },
  errorText: { color: tokens.colorStatusDangerForeground1 },
});

function friendlyType(t: AnalysisJob['type']): string {
  return jobTypeLabel(t);
}

/** Parse the best-so-far quality from j.summary (not j.bestSoFar — bug fix). */
function parseQuality(j: AnalysisJob): number {
  if (j.summary) {
    try {
      const parsed = JSON.parse(j.summary) as { quality?: number };
      if (typeof parsed.quality === 'number') return parsed.quality;
    } catch {
      /* ignore */
    }
  }
  return j.progressPct / 100;
}

/** Compact relative time, e.g. "just now", "5 min ago", "2 h ago", "3 d ago". */
function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** How long the job ran: prefer computeSeconds, else finished−started/submitted. */
function runDuration(j: AnalysisJob): string | undefined {
  if (typeof j.computeSeconds === 'number' && j.computeSeconds > 0) {
    return formatDuration(j.computeSeconds);
  }
  if (!j.finishedAt) return undefined;
  const end = new Date(j.finishedAt).getTime();
  const startIso = j.startedAt ?? j.submittedAt;
  if (!startIso) return undefined;
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start) return undefined;
  return formatDuration((end - start) / 1000);
}

/** A "finished 5 min ago · ran 2 min 10 s" line for a terminal job. */
function completionSummary(j: AnalysisJob): { text: string; absolute?: string } | undefined {
  if (!j.finishedAt) return undefined;
  const dur = runDuration(j);
  const verb = j.status === 'FAILED' ? 'Failed' : j.status === 'CANCELLED' ? 'Stopped' : 'Finished';
  const text = `${verb} ${timeAgo(j.finishedAt)}${dur ? ` · ran ${dur}` : ''}`;
  const absolute = new Date(j.finishedAt).toLocaleString();
  return { text, absolute };
}

/** Job panel: run history + live status/convergence (design spec §7.5, §8). */
export function JobPanel({
  jobs,
  onCancel,
  onDelete,
  onSelect,
  selectedId,
  emptyMessage,
}: {
  jobs: AnalysisJob[];
  onCancel?: (id: string) => void;
  onDelete?: (id: string) => void;
  onSelect?: (id: string) => void;
  selectedId?: string;
  emptyMessage?: string;
}) {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      <Text weight="semibold">Your analyses</Text>
      {jobs.length === 0 && (
        <Text size={200} className={styles.empty}>
          {emptyMessage ?? 'No analyses yet — run one from the wizard.'}
        </Text>
      )}
      {jobs.map((j) => {
        const quality = parseQuality(j);
        const running = j.status === 'RUNNING';
        const selected = j.id === selectedId;
        const view = describeJobStatus(j);
        const title = j.name?.trim() || friendlyType(j.type);
        return (
          <Card
            key={j.id}
            className={selected ? styles.jobCardSelected : styles.jobCard}
            onClick={() => onSelect?.(j.id)}
          >
            <div className={styles.jobHeader}>
              <div className={styles.jobTitle}>
                <Text weight="semibold" truncate wrap={false}>
                  {title}
                </Text>
                {j.name?.trim() && (
                  <Text size={100} className={styles.subtle} truncate wrap={false}>
                    {friendlyType(j.type)}
                  </Text>
                )}
              </div>
              <div className={styles.headerActions}>
                <Badge
                  appearance="filled"
                  color={
                    view.tone === 'warning'
                      ? 'warning'
                      : view.tone === 'danger'
                        ? 'danger'
                        : view.tone === 'success'
                          ? 'success'
                          : view.tone === 'subtle'
                            ? 'subtle'
                            : view.tone === 'important'
                              ? 'important'
                              : 'informative'
                  }
                  size="small"
                >
                  {view.label}
                </Badge>
                {onDelete && (
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<DeleteRegular />}
                    aria-label="Delete analysis"
                    title="Delete this analysis and tear down its Spark session"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(j.id);
                    }}
                  />
                )}
              </div>
            </div>

            {j.status === 'QUEUED' && (
              <div className={styles.waiting}>
                <ProgressBar value={undefined} thickness="medium" />
                <Text size={100} className={view.isStuck ? styles.stuck : styles.statusDetail}>
                  {view.detail} · {view.elapsedText}
                </Text>
              </div>
            )}
            {running && (
              <>
                <ConvergenceMeter
                  quality={quality}
                  running
                  onStop={onCancel ? () => onCancel(j.id) : undefined}
                />
                <Text size={100} className={view.isStuck ? styles.stuck : styles.statusDetail}>
                  {view.detail}
                </Text>
              </>
            )}
            {j.status === 'FAILED' && (
              <Text size={200} className={styles.errorText}>
                {view.detail}
              </Text>
            )}
            {(() => {
              const done = completionSummary(j);
              if (!done) return null;
              return done.absolute ? (
                <Tooltip content={done.absolute} relationship="description">
                  <Text size={100} className={styles.completed}>
                    {done.text}
                  </Text>
                </Tooltip>
              ) : (
                <Text size={100} className={styles.completed}>
                  {done.text}
                </Text>
              );
            })()}
          </Card>
        );
      })}
    </div>
  );
}
