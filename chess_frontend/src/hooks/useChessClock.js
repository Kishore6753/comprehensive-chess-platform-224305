import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * A lightweight chess clock hook: two countdown timers that tick when enabled,
 * not paused, and game isn't over.
 *
 * Design notes:
 * - We tick at a fixed 1s cadence while "running".
 * - "activeColor" determines which side's clock is decremented.
 * - We clamp at 0 and emit `flag` once, plus optional `onFlag` callback.
 */

// PUBLIC_INTERFACE
export function useChessClock({
  initialSeconds = 300,
  activeColor,
  enabled,
  paused = false,
  gameOver,
  onFlag
}) {
  /** Manage two-player countdown clocks for chess with pause/resume and flag detection. */
  const [white, setWhite] = useState(initialSeconds);
  const [black, setBlack] = useState(initialSeconds);

  // Track whether we've already reported a flag to avoid repeated callbacks.
  const flaggedRef = useRef(false);

  // Reset clock values when base time changes (configuration change).
  useEffect(() => {
    setWhite(initialSeconds);
    setBlack(initialSeconds);
    flaggedRef.current = false;
  }, [initialSeconds]);

  const flag = useMemo(() => {
    if (!enabled) return null;
    if (white === 0) return "w";
    if (black === 0) return "b";
    return null;
  }, [enabled, white, black]);

  useEffect(() => {
    if (!enabled) return;
    if (paused) return;
    if (gameOver) return;
    if (flag) return;
    if (activeColor !== "w" && activeColor !== "b") return;

    const id = window.setInterval(() => {
      if (activeColor === "w") setWhite((s) => Math.max(0, s - 1));
      if (activeColor === "b") setBlack((s) => Math.max(0, s - 1));
    }, 1000);

    return () => window.clearInterval(id);
  }, [enabled, paused, gameOver, flag, activeColor]);

  useEffect(() => {
    if (!enabled) return;
    if (!flag) return;
    if (flaggedRef.current) return;

    flaggedRef.current = true;
    if (typeof onFlag === "function") onFlag(flag);
  }, [enabled, flag, onFlag]);

  // PUBLIC_INTERFACE
  const reset = useCallback(
    (seconds = initialSeconds) => {
      /** Reset both clocks to the provided seconds (defaults to initialSeconds). */
      setWhite(seconds);
      setBlack(seconds);
      flaggedRef.current = false;
    },
    [initialSeconds]
  );

  return { white, black, flag, reset };
}
