/**
 * Evidence & investigation bridge — the non-React seam that lets the agent's
 * evidence tools (`capture_evidence`, `list_investigations`,
 * `set_active_investigation`) reach app state that lives in React (the page
 * capture root, the active-investigation preference).
 *
 * Mirrors the `uiControl` bus: `App.tsx` registers live handlers here in an
 * effect, and the tool dispatcher (which runs OUTSIDE React) reads them
 * imperatively from `foundryClient.runToolCall`. Module-level singletons are
 * deliberate — the tool layer has no React tree to read a context from.
 *
 * SAFETY: the tools that use these handlers are `readOnly:false` (capture / set)
 * or read-only (list), and the write ones are refused by `policy.checkToolPolicy`
 * unless the user enabled actions/control. The bridge itself grants no authority.
 */

/** A lightweight reference to an investigation (id + display name). */
export interface ActiveInvestigationRef {
  id: string;
  name: string;
}

/** Outcome of an agent-driven page capture, kept small for the tool result. */
export interface AgentEvidenceResult {
  ok: boolean;
  evidenceId?: string;
  pageName?: string;
  chartCount?: number;
  /** Populated when the capture itself failed. */
  error?: string;
}

/** Capture the CURRENT page into `investigationId`, returning a compact result. */
export type EvidenceCaptureFn = (opts: {
  investigationId: string;
  annotation?: string;
}) => Promise<AgentEvidenceResult>;

/** Read/activate the app-wide active-investigation preference. */
export interface ActiveInvestigationAccessor {
  get(): ActiveInvestigationRef | null;
  set(ref: ActiveInvestigationRef): void;
}

let evidenceCapture: EvidenceCaptureFn | null = null;
let activeInvestigationAccessor: ActiveInvestigationAccessor | null = null;

/** Register (or clear) the current-page evidence-capture handler. */
export function setEvidenceCapture(fn: EvidenceCaptureFn | null): void {
  evidenceCapture = fn;
}

export function getEvidenceCapture(): EvidenceCaptureFn | null {
  return evidenceCapture;
}

/** Register (or clear) the active-investigation accessor. */
export function setActiveInvestigationAccessor(
  accessor: ActiveInvestigationAccessor | null,
): void {
  activeInvestigationAccessor = accessor;
}

export function getActiveInvestigationAccessor(): ActiveInvestigationAccessor | null {
  return activeInvestigationAccessor;
}

/** Test-only: reset the bridge registries. */
export function __resetEvidenceBridgeForTests(): void {
  evidenceCapture = null;
  activeInvestigationAccessor = null;
}
