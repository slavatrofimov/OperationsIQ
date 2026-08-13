import { useMemo, useState } from 'react';
import {
  Badge,
  Caption1,
  Subtitle2,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular, InfoRegular, LightbulbRegular } from '@fluentui/react-icons';
import type { AnalysisJob } from '../../lib/mp/types';
import { jobTypeLabel } from '../../lib/mp/naming';
import { methodologyFor } from '../../lib/mp/methodology';
import {
  runDurationLabel,
  runParameters,
  runResultCount,
  shortRunId,
  runDateLabel,
} from '../../lib/mp/runHistory';
import { describeJobStatus } from '../../lib/mp/livyStatus';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  idRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  runId: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground3 },
  algo: { color: tokens.colorNeutralForeground3 },
  statRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalS,
  },
  stat: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '96px' },
  statLabel: { color: tokens.colorNeutralForeground3 },
  statValue: { fontWeight: tokens.fontWeightSemibold },
  method: { color: tokens.colorNeutralForeground2 },
  callout: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  calloutLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: tokens.colorBrandForeground1,
    alignSelf: 'flex-start',
  },
  paramGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalL,
    rowGap: tokens.spacingVerticalS,
  },
  param: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  paramLabelRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground3,
  },
  paramValue: { wordBreak: 'break-word' },
  info: { fontSize: '12px', color: tokens.colorNeutralForeground3, cursor: 'help' },
  metrics: { display: 'flex', flexDirection: 'column', gap: '2px' },
  metricRow: { display: 'flex', gap: tokens.spacingHorizontalXS },
  metricLabel: { fontWeight: tokens.fontWeightSemibold, flexShrink: 0 },
});

type BadgeColor = 'warning' | 'danger' | 'success' | 'subtle' | 'important' | 'informative';

function badgeColorFor(tone: ReturnType<typeof describeJobStatus>['tone']): BadgeColor {
  switch (tone) {
    case 'warning':
    case 'danger':
    case 'success':
    case 'subtle':
    case 'important':
      return tone;
    default:
      return 'informative';
  }
}

export interface RunMethodologyPanelProps {
  job: AnalysisJob;
  /** Maps a signal id to a friendly display name. */
  labelFor?: (signalId: string) => string;
  /** Optional plain-language "what is this?" explainer, shown as a callout in the header. */
  explainTitle?: string;
  explainText?: string;
}

/**
 * Run detail header: the "comprehensive details about the search job" surface. Shows the
 * run identity, execution stats (status, duration, patterns found), the plain-language
 * methodology for this analysis type, how to interpret the results, and — on demand — the
 * full parameter set. Consistent across every pattern-search type (progressive disclosure).
 */
export function RunMethodologyPanel({
  job,
  labelFor = (id) => id,
  explainTitle,
  explainText,
}: RunMethodologyPanelProps) {
  const styles = useStyles();
  const [showParams, setShowParams] = useState(false);

  const method = methodologyFor(job.type);
  const statusView = describeJobStatus(job);
  const params = useMemo(() => runParameters(job, labelFor), [job, labelFor]);
  const duration = runDurationLabel(job);
  const count = runResultCount(job);

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <div className={styles.titleBlock}>
          <Subtitle2>{job.name?.trim() || jobTypeLabel(job.type)}</Subtitle2>
          <div className={styles.idRow}>
            <Tooltip content={job.id} relationship="description" withArrow>
              <Caption1 className={styles.runId}>{shortRunId(job.id)}</Caption1>
            </Tooltip>
            <Caption1 className={styles.algo}>· {jobTypeLabel(job.type)}</Caption1>
          </div>
          <Caption1 className={styles.algo}>{method.algorithm}</Caption1>
        </div>
        <Badge appearance="filled" color={badgeColorFor(statusView.tone)}>
          {statusView.label}
        </Badge>
      </div>

      <div className={styles.statRow}>
        <div className={styles.stat}>
          <Caption1 className={styles.statLabel}>Run</Caption1>
          <Text className={styles.statValue} size={200}>
            {runDateLabel(job)}
          </Text>
        </div>
        <div className={styles.stat}>
          <Caption1 className={styles.statLabel}>Duration</Caption1>
          <Text className={styles.statValue} size={200}>
            {duration ?? (statusView.elapsedText || '—')}
          </Text>
        </div>
        <div className={styles.stat}>
          <Caption1 className={styles.statLabel}>Patterns found</Caption1>
          <Text className={styles.statValue} size={200}>
            {count ? `${count.count}${count.approximate ? '+' : ''}` : '—'}
          </Text>
        </div>
      </div>

      <Text size={300} className={styles.method}>
        {method.method}
      </Text>

      {explainText && (
        <div className={styles.callout}>
          <div className={styles.calloutLabel}>
            <LightbulbRegular />
            <Caption1>{explainTitle ?? 'What is this?'}</Caption1>
          </div>
          <Text size={200}>{explainText}</Text>
        </div>
      )}

      <div className={styles.callout}>
        <div className={styles.calloutLabel}>
          <InfoRegular />
          <Caption1>How to read these results</Caption1>
        </div>
        <Text size={200}>{method.interpretation}</Text>
        {method.metrics.length > 0 && (
          <div className={styles.metrics}>
            {method.metrics.map((m) => (
              <div key={m.label} className={styles.metricRow}>
                <Text size={200} className={styles.metricLabel}>
                  {m.label}:
                </Text>
                <Text size={200}>{m.meaning}</Text>
              </div>
            ))}
          </div>
        )}
      </div>

      {params.length > 0 && (
        <>
          <button
            type="button"
            className={styles.toggle}
            onClick={() => setShowParams((v) => !v)}
            aria-expanded={showParams}
          >
            {showParams ? <ChevronDownRegular /> : <ChevronRightRegular />}
            <Caption1>{showParams ? 'Hide parameters' : 'Show parameters'}</Caption1>
          </button>
          {showParams && (
            <div className={styles.paramGrid}>
              {params.map((p) => (
                <div key={p.label} className={styles.param}>
                  <div className={styles.paramLabelRow}>
                    <Caption1>{p.label}</Caption1>
                    {p.hint && (
                      <Tooltip content={p.hint} relationship="description" withArrow>
                        <InfoRegular className={styles.info} aria-label={`About ${p.label}`} />
                      </Tooltip>
                    )}
                  </div>
                  <Text size={200} className={styles.paramValue}>
                    {p.value}
                  </Text>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
