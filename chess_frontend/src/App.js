import React from "react";
import "./App.css";
import { ChessGame } from "./pages/ChessGame";

// PUBLIC_INTERFACE
function App() {
  /** Application entrypoint that renders the full chess game UI. */
  return (
    <div className="App">
      <ChessGame />
    </div>
  );
}

export default App;
