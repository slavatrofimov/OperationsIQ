/**
 * Pure helpers for {@link PageErrorBoundary}. Kept free of React / Fluent (and
 * `window`) so they are unit-testable in a plain Node environment, matching the
 * repo's pure-`.ts` test convention.
 */

/**
 * Whether the boundary should clear a caught error. It resets only when it is
 * currently showing an error AND the reset key changed (e.g. the user navigated
 * to a different page or switched the active profile) — so a fresh page gets a
 * clean render instead of staying stuck on the previous page's error.
 */
export function shouldResetErrorBoundary(
  prevKey: string,
  nextKey: string,
  hasError: boolean,
): boolean {
  return hasError && prevKey !== nextKey;
}

/**
 * Render a copy/paste-friendly diagnostic blob for a caught render error: the
 * reset key (page + profile), a timestamp, the error name/message, and the JS
 * and React component stacks when available.
 */
export function formatErrorDetails(opts: {
  resetKey: string;
  error: unknown;
  componentStack?: string | null;
  timestamp?: string;
}): string {
  const { error } = opts;
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : '';
  const lines = [
    `Location: ${opts.resetKey}`,
    `Time: ${opts.timestamp ?? new Date().toISOString()}`,
    `Error: ${name}: ${message}`,
  ];
  if (stack) lines.push('', 'Stack:', stack.trim());
  if (opts.componentStack) lines.push('', 'Component stack:', opts.componentStack.trim());
  return lines.join('\n');
}
