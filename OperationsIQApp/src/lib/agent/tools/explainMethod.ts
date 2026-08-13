/**
 * `explain_method` — a curated glossary of the app's analytical methods/terms.
 *
 * Grounds the Operations Advisor's teaching in a single shared vocabulary (SAX, discord,
 * motif, forecast band, Granger causality, control chart, SAX-VSM, anomaly)
 * instead of improvising definitions. Read-only; pure lookup over `glossary.ts`.
 */

import type { AgentTool, ToolContext, ToolResult } from '../types';
import { lookupMethod, listMethods } from '../glossary';

export interface ExplainMethodArgs {
  /** Method/term to explain. Omit to list the available terms. */
  term?: string;
}

export const explainMethodTool: AgentTool<ExplainMethodArgs> = {
  name: 'explain_method',
  readOnly: true,
  description:
    'Look up a grounded definition of an analytical method or term the app uses (e.g. SAX, discord, ' +
    'motif, forecast band, Granger causality, control chart, SAX-VSM, anomaly): what it is, when to ' +
    'use it, and caveats. Omit `term` to list available terms. Prefer these definitions over ad-hoc ' +
    'explanations so teaching stays consistent. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      term: { type: 'string', description: 'Method or term to explain; omit to list all.' },
    },
  },
  async run(args, _ctx: ToolContext): Promise<ToolResult> {
    const term = (args.term ?? '').trim();
    if (!term) {
      const methods = listMethods();
      return {
        ok: true,
        summary: `${methods.length} terms available: ${methods.map((m) => m.title).join(', ')}.`,
        data: { terms: methods },
      };
    }
    const hit = lookupMethod(term);
    if (!hit) {
      const methods = listMethods();
      return {
        ok: true,
        summary: `No glossary entry for "${term}". Known terms: ${methods.map((m) => m.title).join(', ')}.`,
        data: { term, found: false, knownTerms: methods.map((m) => m.term) },
      };
    }
    return {
      ok: true,
      summary: `${hit.title}: ${hit.definition}`,
      data: {
        term: hit.term,
        title: hit.title,
        aliases: hit.aliases,
        definition: hit.definition,
        whenToUse: hit.whenToUse,
        caveats: hit.caveats,
        relatedTools: hit.relatedTools,
        found: true,
      },
    };
  },
};
