/**
 * ProfileSelector: full-screen dialog shown when no active Connection Profile
 * is selected. Lists existing profiles (MRU order) and lets the user connect,
 * edit, delete, or create new profiles.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Text,
  Caption1,
  Badge,
  Divider,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  Add24Regular,
  Delete24Regular,
  Edit24Regular,
  Search16Regular,
  PlugConnected24Regular,
  ErrorCircle24Regular,
  ArrowClockwise16Regular,
} from '@fluentui/react-icons';
import type { ConnectionProfile } from '../lib/connectionProfile';

const useStyles = makeStyles({
  surface: {
    maxWidth: '720px',
    width: '100%',
    padding: tokens.spacingVerticalXL,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: tokens.spacingVerticalL,
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  searchRow: {
    marginBottom: tokens.spacingVerticalM,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    maxHeight: '420px',
    overflowY: 'auto',
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM}`,
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  cardName: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardMeta: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
    flexShrink: 0,
  },
  empty: {
    padding: tokens.spacingVerticalXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalM,
  },
});

export interface ProfileSelectorProps {
  profiles: ConnectionProfile[];
  isLoading?: boolean;
  /** Set when the last profile load failed after retries. When present (and no
   * profiles are available) the selector shows an error + retry state instead of
   * the "no connections configured" empty state, since a failed load is not the
   * same as the user genuinely having zero profiles. */
  error?: string | null;
  onSelect: (profile: ConnectionProfile) => void;
  onEdit: (profile: ConnectionProfile) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  /** Re-attempt loading the profile list (used by the error state). */
  onRetry?: () => void;
}

/** Full-screen modal for selecting and managing Connection Profiles. */
export function ProfileSelector({
  profiles,
  isLoading,
  error,
  onSelect,
  onEdit,
  onCreate,
  onDelete,
  onRetry,
}: ProfileSelectorProps) {
  const styles = useStyles();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.eventhouseQueryUri.toLowerCase().includes(q) ||
        p.databaseName.toLowerCase().includes(q),
    );
  }, [profiles, search]);

  return (
    <Dialog open modalType="alert">
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>
            <div className={styles.header}>
              <Text size={500} weight="semibold">
                Select a data connection
              </Text>
              <Button appearance="primary" icon={<Add24Regular />} onClick={onCreate}>
                New Connection
              </Button>
            </div>
          </DialogTitle>
          <DialogContent>
            {isLoading ? (
              <Spinner label="Loading connections…" />
            ) : error && profiles.length === 0 ? (
              <div className={styles.empty}>
                <ErrorCircle24Regular
                  style={{ fontSize: 48, color: tokens.colorPaletteRedForeground1 }}
                />
                <Text>Couldn't load your connections.</Text>
                <Caption1 className={styles.cardMeta} style={{ whiteSpace: 'normal', maxWidth: 480 }}>
                  {error}
                </Caption1>
                {onRetry && (
                  <Button
                    appearance="primary"
                    icon={<ArrowClockwise16Regular />}
                    onClick={onRetry}
                  >
                    Retry
                  </Button>
                )}
              </div>
            ) : (
              <>
                {profiles.length > 0 && (
                  <div className={styles.searchRow}>
                    <Input
                      contentBefore={<Search16Regular />}
                      placeholder="Search connections…"
                      value={search}
                      onChange={(_, d) => setSearch(d.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                )}
                {filtered.length === 0 ? (
                  <div className={styles.empty}>
                    {profiles.length === 0 ? (
                      <>
                        <PlugConnected24Regular style={{ fontSize: 48, color: tokens.colorNeutralForeground3 }} />
                        <Text>No connections configured yet.</Text>
                        <Button appearance="primary" onClick={onCreate}>
                          Create your first connection
                        </Button>
                      </>
                    ) : (
                      <Text>No connections match your search.</Text>
                    )}
                  </div>
                ) : (
                  <div className={styles.list}>
                    {filtered.map((profile, i) => (
                      <div key={profile.id}>
                        {i > 0 && <Divider />}
                        <div className={styles.card}>
                          <div className={styles.cardInfo}>
                            <Text className={styles.cardName}>{profile.name}</Text>
                            <Caption1 className={styles.cardMeta}>
                              {profile.eventhouseQueryUri}
                            </Caption1>
                            <Caption1 className={styles.cardMeta}>
                              Database: <strong>{profile.databaseName}</strong>
                              {profile.lastUsedAt && (
                                <>
                                  {' · '}
                                  <Badge appearance="tint" color="informative" size="small">
                                    Last used {profile.lastUsedAt.toLocaleDateString()}
                                  </Badge>
                                </>
                              )}
                            </Caption1>
                          </div>
                          <div className={styles.cardActions}>
                            <Button
                              appearance="primary"
                              size="small"
                              onClick={() => onSelect(profile)}
                            >
                              Connect
                            </Button>
                            <Button
                              appearance="subtle"
                              size="small"
                              icon={<Edit24Regular />}
                              title="Edit"
                              onClick={() => onEdit(profile)}
                            />
                            <Button
                              appearance="subtle"
                              size="small"
                              icon={<Delete24Regular />}
                              title="Delete"
                              onClick={() => onDelete(profile.id)}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
