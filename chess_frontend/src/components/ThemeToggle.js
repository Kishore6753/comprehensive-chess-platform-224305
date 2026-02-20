import React from "react";

// PUBLIC_INTERFACE
export function ThemeToggle({ theme, onToggle }) {
  /**
   * A11y-first theme toggle:
   * - <button> so it's naturally keyboard-focusable
   * - aria-pressed indicates toggle state
   * - accessible label includes current mode
   */
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      className="btn themeToggle"
      onClick={onToggle}
      aria-pressed={isDark}
      aria-label={label}
      title={label}
    >
      <span className="themeToggleIcon" aria-hidden="true">
        {isDark ? "🌙" : "☀️"}
      </span>
      <span className="themeToggleText">{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}
