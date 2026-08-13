import {
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { getLowMemoryGuidance, isLowMemoryError } from '../lib/lowMemory';

const useStyles = makeStyles({
  body: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalS,
  },
  intro: { color: tokens.colorNeutralForeground2 },
  group: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  groupTitle: { color: tokens.colorNeutralForeground1 },
  list: {
    marginTop: 0,
    marginBottom: 0,
    paddingInlineStart: tokens.spacingHorizontalXL,
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
  },
  details: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  summary: { cursor: 'pointer' },
  detailText: {
    display: 'block',
    marginTop: tokens.spacingVerticalXS,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
  },
});

export interface ErrorMessageBarProps {
  /** The error message to display. When empty/nullish the component renders nothing. */
  error?: string | null;
  /**
   * Optional text rendered before the error in the plain fallback (e.g.
   * `"Failed to load results: "`). Ignored when the rich low-memory guidance is
   * shown, but still scanned for the low-memory markers.
   */
  prefix?: string;
  className?: string;
}

/**
 * Shared error banner. Renders as an error `MessageBar` everywhere in the app.
 *
 * When the message describes a low-memory / resource-exhaustion condition
 * (`E_LOW_MEMORY_CONDITION` and friends), it swaps the raw engine text for a
 * positive, grouped set of remediation strategies so the user can recalibrate
 * and keep going. For every other error it renders exactly like the plain
 * `<MessageBar intent="error"><MessageBarBody>…</MessageBarBody></MessageBar>`
 * it replaces, so behaviour is unchanged outside the low-memory case.
 */
export function ErrorMessageBar({ error, prefix, className }: ErrorMessageBarProps) {
  const styles = useStyles();
  if (!error) return null;

  const fullText = prefix ? `${prefix}${error}` : error;

  if (!isLowMemoryError(fullText)) {
    return (
      <MessageBar intent="error" className={className}>
        <MessageBarBody>{fullText}</MessageBarBody>
      </MessageBar>
    );
  }

  const guidance = getLowMemoryGuidance();
  return (
    <MessageBar intent="error" layout="multiline" className={className}>
      <MessageBarBody className={styles.body}>
        <MessageBarTitle>{guidance.title}</MessageBarTitle>
        <span className={styles.intro}>{guidance.intro}</span>
        {guidance.groups.map((group) => (
          <div key={group.title} className={styles.group}>
            <Text weight="semibold" className={styles.groupTitle}>
              {group.title}
            </Text>
            <ul className={styles.list}>
              {group.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            {group.link && (
              <Link href={group.link.url} target="_blank" rel="noreferrer">
                {group.link.text}
              </Link>
            )}
          </div>
        ))}
        <details className={styles.details}>
          <summary className={styles.summary}>Technical details</summary>
          <code className={styles.detailText}>{fullText}</code>
        </details>
      </MessageBarBody>
    </MessageBar>
  );
}
