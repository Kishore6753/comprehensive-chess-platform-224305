import { useEffect, useMemo, useState } from "react";

/**
 * A lightweight chess clock hook: two countdown timers that tick when enabled and game isn't over.
 */

// PUBLIC_INTERFACE
export function useChessClock({ initialSeconds = 300, activeColor, enabled, gameOver }) {
  /** Manage simple two-player countdown clocks for chess. */
  const [white, setWhite] = useState(initialSeconds);
  const [black, setBlack] = useState(initialSeconds);

  useEffect(() => {
    setWhite(initialSeconds);
    setBlack(initialSeconds);
  }, [initialSeconds]);

  useEffect(() => {
    if (!enabled) return;
    if (gameOver) return;
    if (activeColor !== "w" && activeColor !== "b") return;

    const id = window.setInterval(() => {
      if (activeColor === "w") setWhite((s) => Math.max(0, s - 1));
      if (activeColor === "b") setBlack((s) => Math.max(0, s - 1));
    }, 1000);

    return () => window.clearInterval(id);
  }, [enabled, gameOver, activeColor]);

  const flag = useMemo(() => {
    if (!enabled) return null;
    if (white === 0) return "w";
    if (black === 0) return "b";
    return null;
  }, [enabled, white, black]);

  // PUBLIC_INTERFACE
  const reset = () => {
    /** Reset both clocks to the initial value. */
    setWhite(initialSeconds);
    setBlack(initialSeconds);
  };

  return { white, black, flag, reset };
}
