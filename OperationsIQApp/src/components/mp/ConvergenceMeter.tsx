import { ProgressBar, Text, Button, makeStyles, tokens } from '@fluentui/react-components';
import { DismissCircleRegular } from '@fluentui/react-icons';
import { convergenceText } from '../../lib/mp/signal';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  stopButton: {
    color: tokens.colorPaletteRedForeground1,
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    ':hover': {
      color: tokens.colorPaletteRedForeground1,
      border: `1px solid ${tokens.colorPaletteRedBorderActive}`,
      backgroundColor: tokens.colorPaletteRedBackground1,
    },
    ':hover:active': {
      color: tokens.colorPaletteRedForeground1,
      border: `1px solid ${tokens.colorPaletteRedBorderActive}`,
      backgroundColor: tokens.colorPaletteRedBackground2,
    },
  },
});

/**
 * Anytime convergence meter + stop-early control (design spec §7.2). Shows the best-so-far
 * quality climbing toward exact so a long job still feels interactive.
 */
export function ConvergenceMeter({
  quality,
  running,
  onStop,
}: {
  quality: number;
  running: boolean;
  onStop?: () => void;
}) {
  const styles = useStyles();
  const { pct, label } = convergenceText(quality);
  return (
    <div className={styles.root}>
      <ProgressBar value={pct / 100} thickness="medium" />
      <div className={styles.row}>
        <Text size={200}>
          {label} — {pct}%
        </Text>
        {running && onStop && (
          <Button
            size="small"
            appearance="outline"
            icon={<DismissCircleRegular />}
            className={styles.stopButton}
            onClick={onStop}
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}
