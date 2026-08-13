import {
  Popover,
  PopoverTrigger,
  PopoverSurface,
  ToggleButton,
  Switch,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CommentMultiple24Regular } from '@fluentui/react-icons';
import type { UseChartAnnotationsResult } from '../hooks/useChartAnnotations';
import { TimelineTable } from './TimelineTable';

const useStyles = makeStyles({
  surface: {
    width: '920px',
    maxWidth: '92vw',
    padding: tokens.spacingVerticalM,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  empty: { color: tokens.colorNeutralForeground3 },
});

export interface TimelineMarkersButtonProps {
  /** The `useChartAnnotations` hook result, feeding the popover's list and switch. */
  annot: UseChartAnnotationsResult;
  /** Whether markers are currently drawn on the chart. */
  showOnChart: boolean;
  /** Flip the "Show on chart" opt-in. */
  onToggleShowOnChart: (v: boolean) => void;
}

/**
 * Reusable `ChartFrame` toolbar control: surfaces the in-scope events &
 * annotations on demand via a popover, instead of always drawing them on the
 * chart. Drop this next to a page's "Annotate" toggle. The chart stays clean
 * by default; flipping "Show on chart" opts back into the previous behavior.
 */
export function TimelineMarkersButton({
  annot,
  showOnChart,
  onToggleShowOnChart,
}: TimelineMarkersButtonProps) {
  const styles = useStyles();
  const count = annot.allMarkers.length;

  return (
    <Popover trapFocus positioning="below-end">
      <PopoverTrigger disableButtonEnhancement>
        <ToggleButton
          appearance="subtle"
          size="small"
          icon={<CommentMultiple24Regular />}
          title="Events & annotations in the current range"
        >
          {`${count} in scope`}
        </ToggleButton>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        <Switch
          label="Show on chart"
          checked={showOnChart}
          onChange={(_, d) => onToggleShowOnChart(d.checked)}
        />
        {count === 0 ? (
          <Caption1 className={styles.empty}>No events or annotations in this range.</Caption1>
        ) : (
          <TimelineTable
            markers={annot.allMarkers}
            hiddenIds={annot.hiddenMarkerIds}
            typeGroups={annot.markerTypeGroups}
            hiddenTypes={annot.hiddenTypes}
            onToggle={annot.toggleMarker}
            onToggleAll={annot.toggleAllMarkers}
            onToggleType={annot.toggleMarkerType}
            currentUserId={annot.currentUserId}
            onEdit={annot.openEdit}
            onDelete={annot.handleDeleteAnnotation}
          />
        )}
      </PopoverSurface>
    </Popover>
  );
}
