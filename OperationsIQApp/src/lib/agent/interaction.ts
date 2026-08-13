/**
 * Interaction bus — the seam that lets an agent tool ask the user a structured
 * question (confirm an action, pick one of N options) and have the chat panel
 * render it as real, clickable UI instead of a prose "please reply yes/no".
 *
 * Design mirrors `uiControl.ts` (the app-control seam): a module-level singleton,
 * not React context, because the tool dispatcher (`foundryClient.runToolCall`)
 * runs OUTSIDE the React tree and has no context to read. The single mounted
 * Operations Advisor panel subscribes here; the `request_user_choice` tool
 * publishes requests here.
 *
 * IMPORTANT — non-blocking by design: publishing a request does NOT wait for the
 * user's click. The tool returns immediately (so it never trips the per-tool /
 * per-turn timeouts in `foundryClient`), and the user's selection comes back as
 * their NEXT chat turn — the button is just sugar for typing the choice. This
 * keeps the model's turn loop simple and avoids holding a Foundry response chain
 * open while a human deliberates.
 */

/** Visual emphasis for a choice button. */
export type InteractionOptionStyle = 'primary' | 'default' | 'danger';

/** One selectable option rendered as a button (or checkbox, when multi-select). */
export interface InteractionOption {
  /** Button text shown to the user (e.g. "Approve", "Forecast", "Cancel"). */
  label: string;
  /**
   * The text sent back as the user's reply when this option is picked. Defaults
   * to `label` when omitted, so the agent reads a human-meaningful answer.
   */
  value?: string;
  /** Optional secondary line under the label (e.g. what the option will do). */
  description?: string;
  /** Visual emphasis — `primary` for the recommended/confirm action. */
  style?: InteractionOptionStyle;
}

/**
 * A structured question the agent wants the user to answer by clicking. `confirm`
 * is a yes/no (typically Approve + Cancel); `choice` is a pick-one (or, with
 * `allowMultiple`, pick-several-then-submit) list.
 */
export interface InteractionRequest {
  /** Unique id per request, so the panel can key/replace a stale request. */
  id: string;
  kind: 'confirm' | 'choice';
  /** The question shown above the controls. */
  prompt: string;
  /** The options to render. At least one; `confirm` usually has 1-2. */
  options: InteractionOption[];
  /** `choice` only: let the user tick several options and submit them together. */
  allowMultiple?: boolean;
}

type Listener = (request: InteractionRequest) => void;

const listeners = new Set<Listener>();

/**
 * Subscribe to interaction requests. Returns an unsubscribe function. The panel
 * calls this on mount; multiple subscribers are supported but in practice only
 * the single mounted panel listens.
 */
export function subscribeInteraction(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether anything is currently listening — the tool uses this to fail cleanly
 *  (ok:false) when no panel can render the request (e.g. headless/tests). */
export function hasInteractionListener(): boolean {
  return listeners.size > 0;
}

/** Publish a request to every subscriber. No-op (returns false) when nobody is
 *  listening, so the caller can report the affordance is unavailable. */
export function requestInteraction(request: InteractionRequest): boolean {
  if (listeners.size === 0) return false;
  for (const l of listeners) l(request);
  return true;
}

/** Generate a reasonably-unique request id without pulling in a uuid dep. */
export function newInteractionId(): string {
  return `intx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Test-only: drop all subscribers. */
export function __resetInteractionForTests(): void {
  listeners.clear();
}
