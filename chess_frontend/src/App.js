import React from "react";
import "./App.css";
import { ChessGame } from "./pages/ChessGame";
import { useTheme } from "./hooks/useTheme";

// PUBLIC_INTERFACE
function App() {
  /** Application entrypoint that renders the full chess game UI. */
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="App">
      <ChessGame theme={theme} onToggleTheme={toggleTheme} />
    </div>
  );
}

export default App;
