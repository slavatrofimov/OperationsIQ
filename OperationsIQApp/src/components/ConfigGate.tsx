import {
  FluentProvider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  Title2,
  makeStyles,
  tokens,
  webLightTheme,
} from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacingHorizontalXXL,
    boxSizing: 'border-box',
  },
  card: {
    maxWidth: '640px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
  },
  list: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
  },
});

export interface ConfigGateProps {
  /** The `VITE_*` variable names that are required but missing. */
  missing: string[];
}

/**
 * Startup gate shown when required configuration is missing. Rendered by
 * `main.tsx` instead of `<App />` so a misconfiguration surfaces as a single,
 * clear message rather than deferred MSAL / Eventhouse / Rayfin failures.
 */
export function ConfigGate({ missing }: ConfigGateProps) {
  const styles = useStyles();
  return (
    <FluentProvider theme={webLightTheme}>
      <div className={styles.root}>
        <div className={styles.card}>
          <Title2>Configuration incomplete</Title2>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Operations IQ cannot start</MessageBarTitle>
              The following required environment {missing.length === 1 ? 'variable is' : 'variables are'}{' '}
              missing or empty. Set {missing.length === 1 ? 'it' : 'them'} in your{' '}
              <span className={styles.code}>.env.local</span> (see{' '}
              <span className={styles.code}>.env.example</span>) and reload.
            </MessageBarBody>
          </MessageBar>
          <ul className={styles.list}>
            {missing.map((name) => (
              <li key={name}>
                <Text className={styles.code}>{name}</Text>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </FluentProvider>
  );
}
