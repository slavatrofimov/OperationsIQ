/**
 * Builds the hand-off prompt sent to the Operations Advisor when a user starts a
 * playbook. The hosted agent's instructions are static, so the prompt is
 * fully self-contained: it carries the playbook's rationale and its ordered,
 * industry-specific steps, and asks the advisor to guide the user through the
 * analysis — driving the app (app control is enabled on hand-off) and suggesting
 * sensible defaults or asking for specifics as needed.
 */
import { PAGE_LABELS } from '../personas';
import { industryLabel } from '../industries';
import { CATEGORY_LABELS, type Playbook } from '../playbooks';

export function buildPlaybookGuidancePrompt(playbook: Playbook): string {
  const context = `${industryLabel(playbook.industry)} · ${playbook.domain} · ${
    CATEGORY_LABELS[playbook.category]
  }`;

  const steps = playbook.steps
    .map(
      (s, i) =>
        `${i + 1}. ${s.title} — ${s.detail} (suggested page: ${PAGE_LABELS[s.page]})`,
    )
    .join('\n');

  return [
    `I'd like your help with a guided analysis: **${playbook.title}** (${context}).`,
    '',
    playbook.summary,
    '',
    `Why it matters: ${playbook.whyItMatters}`,
    '',
    'Here is the recommended sequence of steps for this analysis:',
    steps,
    '',
    'Please guide me through this analysis step by step. App control is enabled, so ' +
      'drive the app for me: open the relevant page, set sensible parameters (ask me ' +
      'for specifics such as the target signal or time window, or suggest sensible ' +
      'defaults), run each step, and explain the results as we go. You do not have to ' +
      'follow the suggested pages rigidly — use your judgement about the best page for ' +
      'each step. Start with the first step now.',
  ].join('\n');
}
