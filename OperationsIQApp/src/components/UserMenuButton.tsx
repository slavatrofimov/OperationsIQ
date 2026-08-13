import {
  Avatar,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Button,
  Body1Strong,
  Caption1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { SignOut24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  trigger: {
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    padding: 0,
    display: 'inline-flex',
    borderRadius: '50%',
  },
  surface: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    minWidth: '220px',
  },
  identity: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  meta: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  email: { wordBreak: 'break-all' },
});

export interface UserMenuButtonProps {
  /** Signed-in user's email, when known. */
  email?: string;
  onSignOut: () => void;
}

/**
 * Compact signed-in indicator: a circular avatar in the header. Clicking it
 * opens a small popover showing the user's identity and a Sign out button,
 * replacing the previous "Signed in" text + inline Sign out button.
 */
export function UserMenuButton({ email, onSignOut }: UserMenuButtonProps) {
  const styles = useStyles();
  const name = email ?? 'Signed in';

  return (
    <Popover positioning="below-end" withArrow>
      <PopoverTrigger disableButtonEnhancement>
        <button className={styles.trigger} aria-label="Account" title={name}>
          <Avatar name={name} color="colorful" size={32} />
        </button>
      </PopoverTrigger>
      <PopoverSurface>
        <div className={styles.surface}>
          <div className={styles.identity}>
            <Avatar name={name} color="colorful" size={40} />
            <div className={styles.meta}>
              <Body1Strong>Signed in</Body1Strong>
              {email && <Caption1 className={styles.email}>{email}</Caption1>}
            </div>
          </div>
          <Button appearance="secondary" icon={<SignOut24Regular />} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
