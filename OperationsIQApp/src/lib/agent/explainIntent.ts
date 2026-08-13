/**
 * Intent detection for "explain what I'm looking at" style prompts.
 *
 * Extracted from the panel so it is a pure, dependency-free function that can be
 * unit-tested without mounting the React tree. When a typed question clearly
 * references the current view, the panel auto-attaches a snapshot of the screen.
 *
 * Kept deliberately NARROW — an explain-verb plus a reference to the current
 * view — so it does not hijack generic questions like "explain motifs".
 */

const EXPLAIN_VERB =
  /\b(explain|analy[sz]e|interpret|describe|summar[iy][sz]e|break\s?down|walk me through|make sense of|what(?:'s| is| are| am i)?)\b/i;
const SCREEN_REF =
  /\b(this (?:screen|page|chart|graph|plot|view|result|data)|these (?:results|charts|graphs)|(?:the )?(?:screen|page|chart|graph|plot|view)|on(?: the| my)? screen|looking at|what i(?:'m| am)? ?(?:looking at|seeing)|seeing here|in front of me|right here|shown here|displayed)\b/i;

export function looksLikeExplainScreen(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return EXPLAIN_VERB.test(t) && SCREEN_REF.test(t);
}
