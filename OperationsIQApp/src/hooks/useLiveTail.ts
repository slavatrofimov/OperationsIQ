/**
 * Hook for managing auto-refresh polling in live-tail mode.
 * - When enabled: calls onTick every intervalMs with a sliding [now - windowMs, now] window.
 * - When disabled: stops polling.
 * - Implements backpressure: skips a tick if the previous one hasn't completed.
 * - Provides a countdown timer and manual refresh trigger.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

export interface LiveTailOptions {
  /** Whether live-tail is currently active. */
  enabled: boolean;
  /** Trailing window duration in ms (default: 15 * 60 * 1000 = 15 min). */
  windowMs: number;
  /** Polling interval in ms (default: 5000 = 5s, min: 2000 = 2s). */
  intervalMs: number;
  /** Called on each tick to fetch new data. Receives [start, end] time window. */
  onTick: (start: Date, end: Date) => Promise<void>;
}

export interface LiveTailState {
  /** Seconds until next refresh. */
  countdown: number;
  /** Whether a fetch is in progress. */
  isFetching: boolean;
  /** Force an immediate refresh. */
  refreshNow: () => void;
}

const MIN_INTERVAL_MS = 2000; // Minimum 2s to avoid hammering Eventhouse

/**
 * Hook that manages auto-refresh polling for live-tail mode.
 * - When enabled: calls onTick every intervalMs with a sliding window [now - windowMs, now].
 * - When disabled: stops polling.
 * - Cleans up on unmount.
 * - Skips a tick if the previous one hasn't completed (backpressure).
 */
export function useLiveTail(options: LiveTailOptions): LiveTailState {
  const { enabled, windowMs, intervalMs, onTick } = options;
  const [countdown, setCountdown] = useState(0);
  const [isFetching, setIsFetching] = useState(false);
  
  // Use refs to avoid recreating intervals when callbacks change
  const isFetchingRef = useRef(false);
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  // Enforce minimum interval
  const safeIntervalMs = Math.max(MIN_INTERVAL_MS, intervalMs);

  const executeTick = useCallback(async () => {
    // Backpressure: skip if the current tick is still running.
    if (isFetchingRef.current) {
      console.log('[useLiveTail] Skipping tick - previous fetch still in progress');
      return;
    }

    const now = new Date();
    const start = new Date(now.getTime() - windowMs);
    
    isFetchingRef.current = true;
    setIsFetching(true);
    
    try {
      await onTickRef.current(start, now);
    } catch (err) {
      console.error('[useLiveTail] Tick failed:', err);
    } finally {
      isFetchingRef.current = false;
      setIsFetching(false);
    }
  }, [windowMs]);

  const refreshNow = useCallback(() => {
    if (!enabled) return;
    setCountdown(safeIntervalMs / 1000);
    executeTick().catch(() => undefined);
  }, [enabled, safeIntervalMs, executeTick]);

  // Main polling loop
  useEffect(() => {
    if (!enabled) {
      setCountdown(0);
      return;
    }

    // Execute first tick immediately
    executeTick().catch(() => undefined);
    setCountdown(safeIntervalMs / 1000);

    // Set up polling interval
    const pollTimer = setInterval(() => {
      executeTick().catch(() => undefined);
      setCountdown(safeIntervalMs / 1000);
    }, safeIntervalMs);

    return () => {
      clearInterval(pollTimer);
    };
  }, [enabled, safeIntervalMs, executeTick]);

  // Countdown timer (updates every 1s)
  useEffect(() => {
    if (!enabled || countdown <= 0) return;

    const countdownTimer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => {
      clearInterval(countdownTimer);
    };
  }, [enabled, countdown]);

  return {
    countdown,
    isFetching,
    refreshNow,
  };
}