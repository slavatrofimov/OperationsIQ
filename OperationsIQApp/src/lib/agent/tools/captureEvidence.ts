/**
 * `capture_evidence` — WRITE. Snapshot the page the user is currently looking at
 * (its Markdown and every chart as PNG + CSV) into an investigation as one piece
 * of Evidence.
 *
 * This is how the agent preserves the result of a step while driving the app:
 * after running an analysis on the page (set_page_params -> run_current_page),
 * capture what is ON SCREEN — the same artifact the user sees — rather than
 * re-computing anything headlessly. Reuses the exact capture path as the manual
 * "Add to investigation" button via the evidence bridge.
 *
 * Gated: `readOnly:false` with `sideEffect:'write'`, so it is refused unless the
 * user enabled "Allow actions on your behalf" (`ctx.allowActions`), and it is
 * never reachable from a captured-screen turn.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { toolError } from '../types';
import { getEvidenceCapture, getActiveInvestigationAccessor } from '../evidenceBridge';

export interface CaptureEvidenceArgs {
  annotation?: string;
  investigationId?: string;
}

export const captureEvidenceTool: AgentTool<CaptureEvidenceArgs> = {
  name: 'capture_evidence',
  readOnly: false,
  sideEffect: 'write',
  description:
    'Capture the CURRENT page (its analysis and every chart as PNG + CSV) into an ' +
    'investigation as a piece of evidence. WRITE ACTION: use this after running an analysis on the page ' +
    'to preserve the on-screen result of a step — do not re-run the analysis headlessly to capture it. ' +
    'Files into the active investigation by default (start one with create_investigation, or pass ' +
    'investigationId). Add a short annotation noting what the step showed.',
  parameters: {
    type: 'object',
    properties: {
      annotation: {
        type: 'string',
        maxLength: 2000,
        description: 'Optional note describing what this step / evidence shows.',
      },
      investigationId: {
        type: 'string',
        description: 'Target investigation id; defaults to the active investigation.',
      },
    },
    additionalProperties: false,
  },
  async run(args, ctx: ToolContext): Promise<ToolResult> {
    const capture = getEvidenceCapture();
    if (!capture) {
      return toolError('unavailable', 'Evidence capture is not available right now.');
    }

    const targetId =
      args.investigationId?.trim() ||
      ctx.investigationId ||
      getActiveInvestigationAccessor()?.get()?.id;
    if (!targetId) {
      return toolError(
        'no_investigation',
        'No active investigation to capture into. Create one with create_investigation ' +
          '(or pass investigationId) first.',
      );
    }

    const result = await capture({ investigationId: targetId, annotation: args.annotation });
    if (!result.ok) {
      return toolError('capture_failed', result.error || 'Could not capture the current page.');
    }

    return {
      ok: true,
      summary:
        `Captured the ${result.pageName ?? 'current'} page` +
        `${result.chartCount ? ` with ${result.chartCount} chart(s)` : ''} as evidence.`,
      data: {
        evidenceId: result.evidenceId,
        investigationId: targetId,
        pageName: result.pageName,
        chartCount: result.chartCount ?? 0,
      },
    };
  },
};
