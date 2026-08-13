import { makeStyles, tokens, Title2, Body1 } from '@fluentui/react-components';
import type { ReactNode } from 'react';
import { AppLogo } from './AppLogo';

const useStyles = makeStyles({
  root: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    rowGap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
    flex: '1 1 auto',
  },
  logo: {
    flexShrink: 0,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
  },
  titleGroup: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
  },
  // Row that holds the scrollable page content and the docked agent pane. The
  // agent panel is a flex sibling (not an overlay), so opening it shrinks the
  // content column and the page stays fully interactive beside it.
  bodyRow: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingTop: tokens.spacingVerticalL,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalXXL,
    paddingRight: tokens.spacingHorizontalXXL,
  },
});

export interface AppShellProps {
  /** Content rendered on the right side of the header (e.g. sign-in button). */
  right?: ReactNode;
  /** Optional docked pane rendered beside the main content (e.g. agent panel). */
  aside?: ReactNode;
  children: ReactNode;
}

export function AppShell({ right, aside, children }: AppShellProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <AppLogo size={40} className={styles.logo} />
          <div className={styles.titleGroup}>
            <Title2>Operations IQ</Title2>
            <Body1 className={styles.subtitle}>
              Turn operational signals into insights, patterns, anomalies, forecasts and actions.
            </Body1>
          </div>
        </div>
        {right}
      </header>
      <div className={styles.bodyRow}>
        <main className={styles.content}>{children}</main>
        {aside}
      </div>
    </div>
  );
}
