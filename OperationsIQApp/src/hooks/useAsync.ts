import { useCallback, useRef, useState } from 'react';

export interface AsyncState<T> {
  loading: boolean;
  error?: string;
  data?: T;
}

/**
 * Run an async function on demand and track loading/error/data. Stale results
 * from superseded calls are ignored (last-call-wins), so rapid re-runs (e.g.
 * changing filters) never flash an out-of-order result.
 */
export function useAsyncAction<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): readonly [AsyncState<T>, (...args: A) => Promise<T>] {
  const [state, setState] = useState<AsyncState<T>>({ loading: false });
  const callId = useRef(0);

  const run = useCallback(
    async (...args: A): Promise<T> => {
      const id = ++callId.current;
      setState((prev) => ({ ...prev, loading: true, error: undefined }));
      try {
        const data = await fn(...args);
        if (callId.current === id) setState({ loading: false, data });
        return data;
      } catch (e) {
        if (callId.current === id) {
          setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
        }
        throw e;
      }
    },
    [fn],
  );

  return [state, run] as const;
}
