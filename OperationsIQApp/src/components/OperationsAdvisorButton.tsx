/**
 * Header entry point for the Operations Advisor: a toggle button that opens
 * or closes the docked agent panel. The panel itself is rendered by the app
 * shell as a side-by-side pane (see App.tsx / AppShell) so page content resizes
 * beside it and stays fully interactive rather than being overlaid.
 *
 * The button hides itself entirely when the advisor is not configured
 * (see env.operationsAdvisorConfigReady), so the feature is fully optional.
 */

import { Button } from '@fluentui/react-components';
import { Sparkle24Regular } from '@fluentui/react-icons';
import { operationsAdvisorConfigReady } from '../lib/env';

export interface OperationsAdvisorButtonProps {
  open: boolean;
  onToggle: () => void;
}

export function OperationsAdvisorButton({ open, onToggle }: OperationsAdvisorButtonProps) {
  // Feature flag: no config, no button.
  if (!operationsAdvisorConfigReady()) return null;

  return (
    <Button
      appearance={open ? 'primary' : 'secondary'}
      icon={<Sparkle24Regular />}
      onClick={onToggle}
      aria-pressed={open}
    >
      Operations Advisor
    </Button>
  );
}
