import {
  Badge,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Info16Regular } from '@fluentui/react-icons';
import type { Provenance } from '../lib/provenance';

const useStyles = makeStyles({
  chip: { cursor: 'pointer' },
  surface: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    maxWidth: '340px',
    padding: tokens.spacingVerticalS,
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalM },
  key: { color: tokens.colorNeutralForeground3 },
  value: { fontWeight: tokens.fontWeightSemibold, wordBreak: 'break-word', textAlign: 'right' },
  title: { fontWeight: tokens.fontWeightSemibold, marginBottom: tokens.spacingVerticalXXS },
});

function fmt(d: Date | undefined): string {
  if (!d) return '—';
  return d.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

/**
 * A compact "traceability" chip shown next to any derived result. Clicking it
 * reveals the full provenance: model + version, feature version, source window,
 * event time, and generation time. Satisfies the spec's non-negotiable
 * traceability requirement in a consistent, reusable way across every workspace.
 */
export function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  const styles = useStyles();
  const p = provenance;
  return (
    <Popover withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <Badge
          className={styles.chip}
          appearance="outline"
          color="informative"
          icon={<Info16Regular />}
          title="Result provenance"
        >
          {p.modelName}@{p.modelVersion}
        </Badge>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={styles.surface}>
          <Text className={styles.title}>Result provenance</Text>
          <div className={styles.row}>
            <Text className={styles.key}>Output</Text>
            <Text className={styles.value}>{p.outputType}</Text>
          </div>
          {p.tagId && (
            <div className={styles.row}>
              <Text className={styles.key}>Signal</Text>
              <Text className={styles.value}>{p.tagId}</Text>
            </div>
          )}
          <div className={styles.row}>
            <Text className={styles.key}>Model</Text>
            <Text className={styles.value}>
              {p.modelName} v{p.modelVersion}
            </Text>
          </div>
          <div className={styles.row}>
            <Text className={styles.key}>Feature version</Text>
            <Text className={styles.value}>v{p.featureVersion}</Text>
          </div>
          <div className={styles.row}>
            <Text className={styles.key}>Source window</Text>
            <Text className={styles.value}>
              {fmt(p.sourceWindowStart)} → {fmt(p.sourceWindowEnd)}
            </Text>
          </div>
          <div className={styles.row}>
            <Text className={styles.key}>Event time</Text>
            <Text className={styles.value}>{fmt(p.eventTime)}</Text>
          </div>
          <div className={styles.row}>
            <Text className={styles.key}>Generated</Text>
            <Text className={styles.value}>{fmt(p.generatedAt)}</Text>
          </div>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
