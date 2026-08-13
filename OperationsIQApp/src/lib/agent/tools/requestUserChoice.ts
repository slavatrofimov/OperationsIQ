/**
 * `request_user_choice` — present the user with clickable buttons to confirm an
 * action or pick one of several options, instead of only asking in prose.
 *
 * READ-ONLY: this tool changes no app/user/remote state — it only renders a
 * question in the chat UI. It is therefore allowed in every session (it does not
 * need the side-effect grant), and is itself the confirmation seam that the
 * gated write / UI-control tools ask the user to pass through first.
 *
 * NON-BLOCKING: the tool publishes the request to the interaction bus and returns
 * right away. It does NOT await the click — the user's selection arrives as their
 * NEXT chat turn (the buttons are sugar for typing the answer). This keeps the
 * model's turn loop simple and avoids holding a response chain open (and tripping
 * the per-tool / per-turn timeouts) while a human deliberates.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import {
  newInteractionId,
  requestInteraction,
  type InteractionOption,
  type InteractionOptionStyle,
} from '../interaction';

/** One option as the model supplies it (snake_case JSON, mirrored to InteractionOption). */
interface RawOption {
  label: string;
  value?: string;
  description?: string;
  style?: InteractionOptionStyle;
}

export interface RequestUserChoiceArgs {
  prompt: string;
  options: RawOption[];
  allow_multiple?: boolean;
}

const VALID_STYLES: ReadonlySet<string> = new Set(['primary', 'default', 'danger']);

export const requestUserChoiceTool: AgentTool<RequestUserChoiceArgs> = {
  name: 'request_user_choice',
  readOnly: true,
  description:
    'Ask the user to confirm an action or pick an option by showing clickable buttons in the chat, ' +
    'instead of asking in prose and hoping they type the right thing. Use it whenever you would ' +
    'otherwise ask "Shall I proceed?" (give an Approve option, and usually a Cancel option) or ' +
    '"Which of these?" (give one option per choice). Does NOT change anything and needs no ' +
    'permissions — it only presents the question. The buttons exist ONLY when you call this tool: ' +
    'never fake them by writing the options as a prose list ("pick one below: 1) … 2) …") or by ' +
    'labelling a message "(one-click choice)" without invoking it, and do not duplicate the options ' +
    'in the message body — pass them here. The user\'s selection arrives as their next ' +
    'message, so after calling this, briefly state the question and then WAIT for their reply; do ' +
    'not assume an answer or act until it comes back.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'The question shown above the buttons (e.g. "Save this derived metric?").',
      },
      options: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        description:
          'The choices, one button each. For a yes/no confirmation give an approve option ' +
          '(style "primary") and usually a cancel option (style "default").',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 80, description: 'Button text.' },
            value: {
              type: 'string',
              maxLength: 200,
              description:
                'Optional text sent back as the user\'s reply when picked; defaults to the label.',
            },
            description: {
              type: 'string',
              maxLength: 200,
              description: 'Optional one-line explanation shown under the label.',
            },
            style: {
              type: 'string',
              enum: ['primary', 'default', 'danger'],
              description: 'Visual emphasis; use "primary" for the recommended/confirm action.',
            },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      allow_multiple: {
        type: 'boolean',
        description:
          'When true, the user can tick several options and submit them together (choice lists only).',
      },
    },
    required: ['prompt', 'options'],
    additionalProperties: false,
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const prompt = (args.prompt ?? '').trim();
    if (!prompt) return toolError('bad_args', 'A non-empty prompt is required.');

    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options: InteractionOption[] = [];
    for (const o of rawOptions) {
      const label = (o?.label ?? '').trim();
      if (!label) continue;
      const style = o?.style && VALID_STYLES.has(o.style) ? o.style : undefined;
      options.push({
        label,
        value: o?.value?.trim() || undefined,
        description: o?.description?.trim() || undefined,
        style,
      });
    }
    if (options.length === 0) {
      return toolError('bad_args', 'At least one option with a non-empty label is required.');
    }

    const allowMultiple = !!args.allow_multiple && options.length > 1;
    // A single option is a bare "acknowledge"; two-or-more without allow_multiple
    // is pick-one. Either way it is a "confirm" when it reads like a yes/no and a
    // "choice" otherwise — but the panel renders both the same, so we classify
    // purely on option count for a clean, predictable UI contract.
    const kind: 'confirm' | 'choice' = options.length <= 2 && !allowMultiple ? 'confirm' : 'choice';

    const delivered = requestInteraction({
      id: newInteractionId(),
      kind,
      prompt,
      options,
      allowMultiple,
    });

    if (!delivered) {
      return toolError(
        'unavailable',
        'No chat UI is available to show the buttons right now. Ask the question in text instead.',
      );
    }

    const labels = options.map((o) => `"${o.label}"`).join(', ');
    return {
      ok: true,
      summary:
        `Showed the user ${options.length} clickable ${allowMultiple ? 'multi-select ' : ''}` +
        `option(s): ${labels}. Their selection will arrive as their next message — ` +
        `state the question briefly, then wait for their reply.`,
      data: { presented: options.map((o) => o.label), allowMultiple, kind },
    };
  },
};
