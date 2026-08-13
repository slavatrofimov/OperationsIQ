/**
 * Detection + actionable guidance for Eventhouse "low memory" style failures.
 *
 * Heavy KQL analyses (MVAD anomaly detection, SAX discord / similarity
 * searches, correlation matrices, …) can exceed the memory a Fabric Eventhouse
 * node has available. Kusto surfaces this as `E_LOW_MEMORY_CONDITION`,
 * "Low memory condition", "bad allocation", or a runaway-query memory limit —
 * usually inside an HTTP 200 response, so the text bubbles up through
 * `executeKql` as a plain error string.
 *
 * Rather than showing the raw engine message (a dead-end for most users), we
 * detect the condition anywhere in the app and render a positive, glanceable
 * set of remediation strategies. Detection is intentionally *content based* so
 * it keeps working even after the error has been stringified / re-wrapped as it
 * propagates (e.g. `useAsyncAction` stores `err.message`).
 */

/** Docs: schedule a higher minimum Eventhouse capacity for heavy workloads. */
export const EVENTHOUSE_CAPACITY_DOC_URL =
  'https://learn.microsoft.com/en-us/fabric/real-time-intelligence/eventhouse-smart-capacity-control';

/**
 * Substrings (matched case-insensitively) that identify a memory / resource
 * exhaustion failure. Kept deliberately specific so ordinary errors that merely
 * mention the word "memory" don't trigger the guidance.
 */
const LOW_MEMORY_MARKERS: readonly string[] = [
  'e_low_memory_condition',
  'low memory condition',
  'low memory',
  'out of memory',
  'bad allocation',
  'memory budget', // "runaway query ... exceeded the memory budget"
  'e_runaway_query',
  'runaway query',
  'exceeded the memory',
  'memorybudgetexceeded',
];

/**
 * True when the given error text describes a low-memory / resource-exhaustion
 * condition. Accepts a string, an `Error`, or anything (safely stringified).
 */
export function isLowMemoryError(err: unknown): boolean {
  const text = errorText(err);
  if (!text) return false;
  const t = text.toLowerCase();
  return LOW_MEMORY_MARKERS.some((m) => t.includes(m));
}

/** Best-effort extraction of a human-readable message from an unknown error. */
export function errorText(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return String(err);
  } catch {
    return '';
  }
}

/** A themed group of remediation suggestions. */
export interface RemediationGroup {
  /** Short, scannable heading. */
  title: string;
  /** One-line, positive, actionable suggestions. */
  items: string[];
  /** Optional external link rendered after the items. */
  link?: { text: string; url: string };
}

/** Structured, presentation-agnostic guidance for a low-memory failure. */
export interface LowMemoryGuidance {
  /** Bold lead-in — still framed as an error, but not a dead end. */
  title: string;
  /** Reassuring, forward-looking sentence introducing the options. */
  intro: string;
  /** Grouped remediation strategies, ordered from quickest to most involved. */
  groups: RemediationGroup[];
}

/**
 * The canonical remediation guidance. Kept as data (not JSX) so it is unit
 * testable and reusable outside React (e.g. the Operations Advisor could cite
 * the same strategies).
 */
export function getLowMemoryGuidance(): LowMemoryGuidance {
  return {
    title: 'This analysis needed more memory than the Eventhouse had available',
    intro:
      'That’s not a dead end — a quick recalibration will get you moving again. Any one of these usually resolves it:',
    groups: [
      {
        title: 'Right-size this run',
        items: [
          'Shorten the time range — analyzing 2 weeks instead of 6 months dramatically cuts the work.',
          'Use a coarser granularity or fewer data points — for example 15-minute bins instead of 30-second — whenever that resolution still answers your question.',
          'Evaluate fewer signals at once — focus on the 10 most critical rather than all 25.',
          'Lower advanced limits such as Candidate limit or PAA size to reduce peak memory.',
        ],
      },
      {
        title: 'Divide and conquer',
        items: [
          'Split a long period into smaller consecutive windows and review them in turn.',
          'Split a large signal set into smaller groups and combine the findings.',
        ],
      },
      {
        title: 'Switch to a lighter method',
        items: [
          'Many analyses here use far less memory — you can keep exploring with another method even before resizing your cluster.',
          'For large-scale pattern searches, use Deep Discovery in the Patterns menu, which runs distributed Spark jobs built for large volumes of data.',
        ],
      },
      {
        title: 'Give the Eventhouse more headroom',
        items: [
          'Heavy queries running at the same time compete for memory — re-running in a moment, or running one analysis at a time, often clears a transient shortage.',
          'Schedule a higher minimum capacity to support larger workloads when you need them.',
        ],
        link: {
          text: 'Set up smart capacity control',
          url: EVENTHOUSE_CAPACITY_DOC_URL,
        },
      },
    ],
  };
}
