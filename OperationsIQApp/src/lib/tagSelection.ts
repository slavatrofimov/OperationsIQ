/**
 * Shared rules for the app-wide multi-select tag cap.
 *
 * The limit is *inclusive*: a limit of N means the user can select exactly N
 * tags (the Nth selection is allowed; only the N+1th is rejected). Committing a
 * selection that shrinks the current one is always allowed, even when the
 * current selection already exceeds the cap (e.g. after the limit was lowered in
 * Settings), so the user can never get stuck unable to deselect.
 */

/**
 * Whether committing a selection of `nextSize` tags is allowed, given the
 * `currentSize` of the existing selection and the effective `limit`.
 *
 * - No limit (`undefined`) → always allowed.
 * - Growing to `<= limit` → allowed (the limit is inclusive).
 * - Growing beyond `limit` → rejected.
 * - Shrinking (`nextSize <= currentSize`) → always allowed, even over the cap.
 */
export function isSelectionWithinLimit(
  nextSize: number,
  currentSize: number,
  limit: number | undefined,
): boolean {
  if (typeof limit !== 'number') return true;
  return nextSize <= limit || nextSize <= currentSize;
}
