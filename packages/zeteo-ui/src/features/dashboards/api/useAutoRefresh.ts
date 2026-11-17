import { useEffect, useRef } from "react";

interface Options {
  /** The interval; null for none. */
  seconds: number | null;
  /** Off while false (signed out, not loaded yet). */
  enabled?: boolean;
  /** Changing it restarts the timer (the viewer's time range). */
  restartKey?: unknown;
  /** True while a run the caller started is going: a tick then waits for the next one. */
  running?: boolean;
  /** What one tick does: reload the dashboard and run its panels. */
  onTick: () => void;
  /** No ticks while the tab is hidden; one catch-up refresh when it shows again. */
  pauseWhenHidden?: boolean;
}

/**
 * Calls `onTick` every `seconds` while enabled. A tick is skipped while a run
 * is going (never cutting it). With `pauseWhenHidden`, a background tab runs
 * nothing, and when it becomes visible again one refresh follows at once if a
 * whole interval has passed since the last one; the timer then goes on.
 */
export const useAutoRefresh = ({
  seconds,
  enabled = true,
  restartKey,
  running = false,
  onTick,
  pauseWhenHidden = false,
}: Options) => {
  const busy = useRef(running);
  busy.current = running;
  const tick = useRef(onTick);
  tick.current = onTick;

  useEffect(() => {
    if (!enabled || seconds === null) return;
    const interval = seconds * 1000;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastRun = Date.now();
    const hidden = () =>
      pauseWhenHidden && document.visibilityState === "hidden";
    const fire = () => {
      lastRun = Date.now();
      if (busy.current) return;
      tick.current();
    };
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => {
        if (!hidden()) fire();
      }, interval);
    };
    const onVisibility = () => {
      if (!pauseWhenHidden) return;
      if (hidden()) {
        clearInterval(timer);
        timer = undefined;
        return;
      }
      if (Date.now() - lastRun >= interval) fire();
      start();
    };
    if (!hidden()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [seconds, enabled, restartKey, pauseWhenHidden]);
};
