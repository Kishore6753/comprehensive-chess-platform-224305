import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "chess_ui_theme";

/**
 * Determine OS/browser preference. Safe to call only in browser contexts.
 */
function getSystemTheme() {
  if (typeof window === "undefined") return "dark";
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  return mq && mq.matches ? "dark" : "light";
}

/**
 * Read initial theme from localStorage (if present), else system preference.
 */
function getInitialTheme() {
  if (typeof window === "undefined") return "dark";

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    // Ignore storage errors (privacy mode, blocked storage, etc.)
  }

  return getSystemTheme();
}

// PUBLIC_INTERFACE
export function useTheme() {
  /**
   * Manage application theme ("light" | "dark"):
   * - initializes from localStorage if present, otherwise system preference
   * - persists to localStorage after user changes
   * - applies theme as `data-theme` on <html> so CSS variables can react globally
   */
  const [theme, setTheme] = useState(getInitialTheme);

  // Apply to document root so all CSS can key off [data-theme="..."]
  useEffect(() => {
    if (typeof document === "undefined") return;

    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Persist the user's explicit choice
  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  // If user has NOT explicitly chosen a theme, follow system changes.
  // We interpret "no saved choice" as: localStorage missing on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;

    let hadSavedChoice = false;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      hadSavedChoice = raw === "light" || raw === "dark";
    } catch {
      // If storage is blocked, just don't follow system changes to avoid toggling unexpectedly.
      hadSavedChoice = true;
    }

    if (hadSavedChoice) return;

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;

    const handler = () => setTheme(mq.matches ? "dark" : "light");

    // Support older Safari
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", handler);
    else if (typeof mq.addListener === "function") mq.addListener(handler);

    return () => {
      if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", handler);
      else if (typeof mq.removeListener === "function") mq.removeListener(handler);
    };
  }, []);

  // PUBLIC_INTERFACE
  const toggleTheme = useCallback(() => {
    /** Toggle between light and dark themes. */
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const isDark = theme === "dark";

  return useMemo(() => ({ theme, isDark, setTheme, toggleTheme }), [theme, isDark, toggleTheme]);
}
