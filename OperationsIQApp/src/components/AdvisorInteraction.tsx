/**
 * Renders a pending {@link InteractionRequest} from the agent as clickable UI in
 * the Operations Advisor chat: an Approve/Cancel-style confirm, a pick-one choice
 * list, or (when `allowMultiple`) a checkbox group with a Submit button.
 *
 * Selection semantics are deliberately simple — clicking resolves the request by
 * handing the chosen text back to the panel, which sends it as the user's next
 * turn (so the transcript shows exactly what they chose). The controls disable
 * while a turn is in flight and after a selection, so a request can't be answered
 * twice.
 */

import { useState } from 'react';
import {
  Button,
  Caption1,
  Checkbox,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import type { InteractionOption, InteractionRequest } from '../lib/agent/interaction';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    alignSelf: 'flex-start',
    maxWidth: '95%',
  },
  prompt: { fontWeight: tokens.fontWeightSemibold },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  choiceButton: { justifyContent: 'flex-start', textAlign: 'left', height: 'auto' },
  // The recommended action is signalled with a brand-coloured border/label on the
  // same whitish fill as the others — not a solid blue fill — so the gray option
  // description keeps sufficient contrast (see appearanceOf).
  primaryChoice: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    color: tokens.colorNeutralForeground1,
  },
  dangerChoice: {
    border: `1px solid ${tokens.colorPaletteRedBorder2}`,
    color: tokens.colorPaletteRedForeground1,
  },
  optionBody: { display: 'flex', flexDirection: 'column', gap: '2px', paddingTop: '2px', paddingBottom: '2px' },
  optionDesc: { color: tokens.colorNeutralForeground2 },
  checkboxGroup: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  submitRow: { display: 'flex', justifyContent: 'flex-end', paddingTop: tokens.spacingVerticalXS },
});

/** The text that gets sent back when an option is picked (value ?? label). */
function replyOf(option: InteractionOption): string {
  return option.value?.trim() || option.label;
}

/**
 * Map an option's style to a Fluent Button appearance. We deliberately keep a
 * whitish (`outline`) fill for every choice — a solid `primary` (blue) fill made
 * the gray option description unreadable — and convey emphasis through an accent
 * border/label instead (see `primaryChoice` / `dangerChoice`).
 */
function appearanceOf(_style: InteractionOption['style']): 'outline' {
  return 'outline';
}

export interface AdvisorInteractionProps {
  request: InteractionRequest;
  /** Disable controls (e.g. while a turn is in flight). */
  disabled?: boolean;
  /** Called with the chosen reply text; multi-select joins picks with ", ". */
  onSelect: (reply: string) => void;
}

export function AdvisorInteraction({ request, disabled, onSelect }: AdvisorInteractionProps) {
  const styles = useStyles();
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [answered, setAnswered] = useState(false);

  const lock = disabled || answered;

  const pickSingle = (option: InteractionOption) => {
    if (lock) return;
    setAnswered(true);
    onSelect(replyOf(option));
  };

  const toggle = (i: number, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(i);
      else next.delete(i);
      return next;
    });
  };

  const submitMulti = () => {
    if (lock || checked.size === 0) return;
    const reply = request.options
      .filter((_, i) => checked.has(i))
      .map(replyOf)
      .join(', ');
    setAnswered(true);
    onSelect(reply);
  };

  return (
    <div className={styles.root} role="group" aria-label={request.prompt}>
      <Text className={styles.prompt}>{request.prompt}</Text>

      {request.allowMultiple ? (
        <>
          <div className={styles.checkboxGroup}>
            {request.options.map((o, i) => (
              <Checkbox
                key={i}
                disabled={lock}
                checked={checked.has(i)}
                onChange={(_, d) => toggle(i, !!d.checked)}
                label={
                  o.description ? (
                    <span className={styles.optionBody}>
                      <span>{o.label}</span>
                      <Caption1 className={styles.optionDesc}>{o.description}</Caption1>
                    </span>
                  ) : (
                    o.label
                  )
                }
              />
            ))}
          </div>
          <div className={styles.submitRow}>
            <Button appearance="primary" disabled={lock || checked.size === 0} onClick={submitMulti}>
              Submit
            </Button>
          </div>
        </>
      ) : (
        <div className={styles.buttons}>
          {request.options.map((o, i) => (
            <Button
              key={i}
              className={mergeClasses(
                styles.choiceButton,
                o.style === 'primary' && styles.primaryChoice,
                o.style === 'danger' && styles.dangerChoice,
              )}
              appearance={appearanceOf(o.style)}
              disabled={lock}
              onClick={() => pickSingle(o)}
            >
              {o.description ? (
                <span className={styles.optionBody}>
                  <span>{o.label}</span>
                  <Caption1 className={styles.optionDesc}>{o.description}</Caption1>
                </span>
              ) : (
                o.label
              )}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
