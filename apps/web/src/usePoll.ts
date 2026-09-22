import { useCallback, useEffect, useRef, useState } from 'react';
import { failureMessage } from './api.js';

export type PollResult<T> = Readonly<{
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}>;

export type PollOptions<T> = Readonly<{
  /** Interval while the response keeps changing. */
  intervalMs: number;
  /**
   * Identifies the resource being polled. When it changes, retained data belongs to a
   * different resource and is cleared, so a new selection never shows the previous one's
   * values while its first request is in flight or if that request fails.
   */
  resetKey?: string;
  /**
   * Refetch immediately when this changes, without clearing retained data. Use it for a known
   * change to the same resource, such as the user submitting work, where waiting out an idle
   * backoff would feel broken but blanking the view would be wrong.
   */
  refreshToken?: string | number;
  /**
   * Ceiling for the idle backoff. Defaults to four times `intervalMs`, which bounds how long a
   * change made outside this tab can go unnoticed. Pass `intervalMs` to disable backoff for a
   * poll whose whole value is in how quickly it notices a change.
   */
  maxIntervalMs?: number;
  /**
   * Stop polling once this returns true for a response. Use it when the data is provably
   * final: further requests cannot return anything new.
   */
  stopWhen?: (data: T) => boolean;
}>;

const BACKOFF_FACTOR = 2;

/**
 * Poll `fetcher` on an interval.
 *
 * Three things keep this from hammering the API:
 *
 * 1. The next request is scheduled only after the previous one settles, so a slow or hanging
 *    response cannot produce overlapping in-flight requests.
 * 2. Identical consecutive responses back the interval off geometrically up to `maxIntervalMs`.
 *    Any change resets it, so the poll stays responsive while work is actually happening.
 * 3. Polling pauses entirely while the document is hidden, and fetches immediately on return.
 *
 * A failed poll keeps the last good data and surfaces the error alongside it, so the dashboard
 * degrades rather than blanking.
 */
export function usePoll<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: PollOptions<T>,
): PollResult<T> {
  const { intervalMs, resetKey = '', refreshToken = '', maxIntervalMs = intervalMs * 4, stopWhen } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Adjusting state during render is React's documented pattern for deriving state from a
  // changed prop, and avoids the extra paint that clearing inside an effect would cause.
  const lastResetKey = useRef(resetKey);
  if (lastResetKey.current !== resetKey) {
    lastResetKey.current = resetKey;
    setData(null);
    setError(null);
  }

  // These close over changing props; keep the latest without restarting the interval.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const stopWhenRef = useRef(stopWhen);
  stopWhenRef.current = stopWhen;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    let stopped = false;
    let inFlight = false;
    let delayMs = intervalMs;
    let lastSerialized: string | null = null;

    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

    function schedule(afterMs: number) {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), afterMs);
    }

    async function tick(): Promise<void> {
      // Without this, a visibility change during a pending request starts a second one, and
      // whichever resolves last wins: an older response can overwrite a newer one.
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetcherRef.current(controller.signal);
        if (!active) return;

        // Comparing the serialized response does two things: it drives the backoff, and it
        // avoids a re-render when the payload is byte-identical to the last one.
        const serialized = JSON.stringify(next);
        if (serialized === lastSerialized) {
          delayMs = Math.min(maxIntervalMs, delayMs * BACKOFF_FACTOR);
        } else {
          delayMs = intervalMs;
          lastSerialized = serialized;
          setData(next);
        }
        setError(null);
        if (stopWhenRef.current?.(next)) stopped = true;
      } catch (failure) {
        if (!active || controller.signal.aborted) return;
        setError(failureMessage(failure));
        delayMs = intervalMs;
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          if (!stopped && visible()) schedule(delayMs);
        }
      }
    }

    function onVisibilityChange() {
      if (!active || stopped) return;
      if (visible()) {
        // Returning to the tab should show current data, not a backed-off stale view. If a
        // request is already running, resetting the delay is enough: its finally reschedules.
        delayMs = intervalMs;
        if (!inFlight) schedule(0);
      } else {
        clearTimeout(timer);
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    setLoading(true);
    void tick();

    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, maxIntervalMs, resetKey, refreshToken, nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, refresh };
}
