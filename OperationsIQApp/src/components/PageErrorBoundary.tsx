import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { formatErrorDetails, shouldResetErrorBoundary } from './pageErrorBoundaryUtil';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalXL,
    maxWidth: '680px',
  },
  details: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    maxHeight: '180px',
    overflowY: 'auto',
  },
  actions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
  },
});

function PageErrorFallback(props: {
  resetKey: string;
  error: unknown;
  componentStack: string | null;
  onReset: () => void;
}): JSX.Element {
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const details = formatErrorDetails({
    resetKey: props.resetKey,
    error: props.error,
    componentStack: props.componentStack,
  });

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked (permissions / non-secure context); the text is
      // still visible above for manual selection, so there is nothing to recover.
    }
  };

  return (
    <div className={styles.root} role="alert">
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>This page hit an error</MessageBarTitle>
          The rest of the app is still available. Retry this page, or switch to
          another view from the navigation.
        </MessageBarBody>
      </MessageBar>
      <Text className={styles.details}>{details}</Text>
      <div className={styles.actions}>
        <Button appearance="primary" onClick={props.onReset}>
          Try again
        </Button>
        <Button onClick={copy}>{copied ? 'Copied' : 'Copy error details'}</Button>
      </div>
    </div>
  );
}

interface Props {
  /** Page + active-profile key; a change clears a caught error (see util). */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Page-level error boundary. Isolates a render/lifecycle crash to the current
 * page so the app shell (navigation, header, profile selector) stays mounted and
 * the user can recover — retry the page, switch views, or copy diagnostics —
 * instead of the whole SPA unmounting to a blank screen. Resets automatically
 * when the user navigates to a different page or switches the active profile.
 */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the React component stack for the diagnostic copy affordance, and log
    // for anyone watching the console during an incident.
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('Page render error:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (shouldResetErrorBoundary(prev.resetKey, this.props.resetKey, this.state.error !== null)) {
      this.setState({ error: null, componentStack: null });
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <PageErrorFallback
          resetKey={this.props.resetKey}
          error={this.state.error}
          componentStack={this.state.componentStack}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}
