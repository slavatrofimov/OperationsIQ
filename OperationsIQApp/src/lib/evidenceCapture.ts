/**
 * Shared "capture the current page into an investigation" routine.
 *
 * Both the manual `AddToInvestigationButton` and the agent's `capture_evidence`
 * tool need to snapshot the page the same way: a Markdown snapshot of the main
 * content and every ECharts graph as PNG + CSV. Centralizing it here keeps the
 * two entry points byte-for-byte identical, so captured evidence has the same
 * shape regardless of who initiated it.
 */

import type { PageKey } from './pages';
import type { CaptureContextSummary } from '../context/CaptureContext';
import { addEvidence, type Evidence } from './evidence';
import { capturePageCharts, capturePageMarkdown } from './pageCapture';

export interface CaptureCurrentPageOptions {
  /** The DOM element whose content should be captured (the page content root). */
  root: HTMLElement;
  /** Page key used to stamp the evidence (and restore via the deep link). */
  pageKey: PageKey;
  /** Human-friendly page name (e.g. "Explore"). */
  pageName: string;
  /** The page's published context summary (selected tags, window, settings). */
  captureContext: CaptureContextSummary | null;
  /** The investigation the evidence is filed under. */
  investigationId: string;
  /** Optional free-text note pinned to this piece of evidence. */
  annotation?: string;
}

export interface CaptureCurrentPageResult {
  evidence: Evidence;
  /** Number of charts (PNG + CSV) captured from the page. */
  chartCount: number;
}

/**
 * Capture the current page's analysis into `investigationId` as one piece of
 * Evidence (markdown + charts + deep link).
 */
export async function captureCurrentPageEvidence(
  opts: CaptureCurrentPageOptions,
): Promise<CaptureCurrentPageResult> {
  const markdown = capturePageMarkdown(opts.root, opts.pageName, opts.captureContext);
  const charts = capturePageCharts(opts.root);

  const evidence = await addEvidence({
    investigationId: opts.investigationId,
    pageKey: opts.pageKey,
    pageName: opts.pageName,
    annotation: opts.annotation?.trim() || undefined,
    markdown,
    charts,
  });

  return { evidence, chartCount: charts.length };
}
