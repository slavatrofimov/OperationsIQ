import type { ReactNode } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(360px, 560px) 1fr',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    // Stack the list on top of the detail on narrow viewports.
    '@media (max-width: 900px)': {
      gridTemplateColumns: '1fr',
    },
  },
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minWidth: 0 },
  heading: { color: tokens.colorNeutralForeground2 },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
});

/**
 * Responsive master-detail scaffold for reviewing found patterns: a list pane on the
 * left drives a detail pane on the right. On narrow viewports the two panes stack
 * (list on top, detail below) so the layout stays usable on small screens.
 */
export function PatternMasterDetail({
  listTitle,
  detailTitle,
  list,
  detail,
}: {
  listTitle: string;
  detailTitle?: string;
  list: ReactNode;
  detail: ReactNode;
}) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.pane}>
        <Text weight="semibold" className={styles.heading}>
          {listTitle}
        </Text>
        {list}
      </div>
      <div className={styles.detail}>
        {detailTitle && (
          <Text weight="semibold" className={styles.heading}>
            {detailTitle}
          </Text>
        )}
        {detail}
      </div>
    </div>
  );
}
