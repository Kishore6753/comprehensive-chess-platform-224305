import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

// Mock SFX to avoid WebAudio usage in Jest/jsdom.
jest.mock("./utils/sfx", () => ({
  primeSfx: jest.fn(),
  playMoveSfx: jest.fn(),
  playCaptureSfx: jest.fn()
}));

// We selectively mock the AI module in tests that need it.
// Default mock keeps real exports available but allows findBestMove override per-test.
jest.mock("./utils/minimaxAi", () => {
  const actual = jest.requireActual("./utils/minimaxAi");
  return {
    ...actual,
    findBestMove: jest.fn(() => null)
  };
});

const { findBestMove } = require("./utils/minimaxAi");

/**
 * Helpers
 */
function getFenText() {
  // The FEN text is rendered in the badgeValue <p>; simplest is to grab the known initial prefix.
  const fenBadge = screen.getByLabelText("Current position FEN");
  return within(fenBadge).getByText(/^[rnbqkbnr]/).textContent;
}

function expectTurnLabel(expected) {
  // The "Turn" badge shows "White"/"Black" (and possibly "(AI thinking…)" etc).
  expect(screen.getByText(new RegExp(`^${expected}\\b`, "i"))).toBeInTheDocument();
}

async function clickSquare(user, square) {
  await user.click(screen.getByRole("button", { name: new RegExp(`Square ${square}\\b`, "i") }));
}

function moveHistoryLog() {
  return screen.getByRole("log", { name: /move history/i });
}

function getStatus() {
  return screen.getByRole("status");
}

describe("Chess frontend - gameplay, UI actions, AI turns, timers, draw offers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders title, board, and initial status", () => {
    render(<App />);

    expect(screen.getByText(/retro chess/i)).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: /chessboard squares/i })).toBeInTheDocument();

    // Initial position
    expect(getFenText()).toMatch(/ w KQkq /);

    // Initial turn/status
    expectTurnLabel("White");
    expect(getStatus()).toHaveTextContent(/white to move\./i);

    // Move history starts empty
    expect(moveHistoryLog()).toHaveTextContent(/no moves yet/i);
  });

  test("making a legal move updates FEN, status, and move history", async () => {
    const user = userEvent.setup();
    render(<App />);

    const fenBefore = getFenText();

    // e2 -> e4
    await clickSquare(user, "e2");
    await clickSquare(user, "e4");

    const fenAfter = getFenText();
    expect(fenAfter).not.toEqual(fenBefore);
    expect(fenAfter).toMatch(/ b KQkq /); // Black to move after white move.

    expectTurnLabel("Black");
    expect(getStatus()).toHaveTextContent(/black to move/i);

    // SAN history should include "e4"
    expect(moveHistoryLog()).toHaveTextContent(/\be4\b/);
  });

  test("illegal move attempt does not change position or history", async () => {
    const user = userEvent.setup();
    render(<App />);

    const fenBefore = getFenText();

    // Try illegal rook-like pawn move: e2 -> e5 (not legal from start)
    await clickSquare(user, "e2");
    await clickSquare(user, "e5");

    // Should remain unchanged
    expect(getFenText()).toEqual(fenBefore);
    expect(moveHistoryLog()).toHaveTextContent(/no moves yet/i);
    expectTurnLabel("White");
  });

  test("undo reverts the last move; restart resets to initial position and clears history", async () => {
    const user = userEvent.setup();
    render(<App />);

    const initialFen = getFenText();

    // Play: e2-e4
    await clickSquare(user, "e2");
    await clickSquare(user, "e4");
    expect(getFenText()).not.toEqual(initialFen);
    expect(moveHistoryLog()).toHaveTextContent(/\be4\b/);

    // Undo brings back initial
    const undoBtn = screen.getByRole("button", { name: /undo/i });
    expect(undoBtn).toBeEnabled();
    await user.click(undoBtn);

    expect(getFenText()).toEqual(initialFen);
    expect(moveHistoryLog()).toHaveTextContent(/no moves yet/i);
    expectTurnLabel("White");

    // Restart also keeps initial and clears history
    await clickSquare(user, "d2");
    await clickSquare(user, "d4");
    expect(moveHistoryLog()).toHaveTextContent(/\bd4\b/);

    await user.click(screen.getByRole("button", { name: /restart/i }));
    expect(getFenText()).toEqual(initialFen);
    expect(moveHistoryLog()).toHaveTextContent(/no moves yet/i);
    expectTurnLabel("White");
  });

  test("draw offer becomes visible on opponent's turn; decline clears it and status updates", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Offer draw as white. Banner should NOT show yet because it's still white to move.
    const offerBtn = screen.getByRole("button", { name: /offer draw/i });
    expect(offerBtn).toBeEnabled();
    await user.click(offerBtn);

    expect(screen.queryByRole("alert", { name: /draw offer/i })).not.toBeInTheDocument();
    expect(getStatus()).toHaveTextContent(/white to move\.\s*draw offered/i);

    // Make a legal move so it's now black's turn, and offer should be visible to black.
    await clickSquare(user, "e2");
    await clickSquare(user, "e4");

    const banner = screen.getByRole("alert", { name: /draw offer/i });
    expect(banner).toHaveTextContent(/draw offer from\s+white/i);

    // Decline clears offer
    await user.click(within(banner).getByRole("button", { name: /decline/i }));
    expect(screen.queryByRole("alert", { name: /draw offer/i })).not.toBeInTheDocument();
    expect(getStatus()).toHaveTextContent(/black to move\./i);
  });

  test("draw offer accept ends the game and prevents further moves", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Offer as white, then play a move to make it black's turn so accept is available.
    await user.click(screen.getByRole("button", { name: /offer draw/i }));
    await clickSquare(user, "d2");
    await clickSquare(user, "d4");

    const banner = screen.getByRole("alert", { name: /draw offer/i });
    await user.click(within(banner).getByRole("button", { name: /accept/i }));

    expect(getStatus()).toHaveTextContent(/draw by agreement/i);
    expect(getStatus()).toHaveTextContent(/\(1\/2-1\/2\)/);

    const fenAfterDraw = getFenText();
    // Try to move (should be blocked because gameOver derived from state.end)
    await clickSquare(user, "g8"); // black knight square
    await clickSquare(user, "f6");
    expect(getFenText()).toEqual(fenAfterDraw);
  });

  test("offering a draw is disabled when it is not the human's turn (AI enabled)", async () => {
    const user = userEvent.setup();
    render(<App />);

    // Enable AI opponent (defaults AI plays black)
    await user.click(screen.getByLabelText(/ai opponent/i));

    // White is human, should be able to offer draw at the very start.
    const offerBtn = screen.getByRole("button", { name: /offer draw/i });
    expect(offerBtn).toBeEnabled();

    // After white plays a move, it becomes AI/black's turn; offer draw should be disabled.
    await clickSquare(user, "e2");
    await clickSquare(user, "e4");

    expect(screen.getByRole("button", { name: /offer draw/i })).toBeDisabled();
  });

  test("AI makes a move on its turn (mocked engine) and move history records both moves", async () => {
    jest.useFakeTimers();

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    // Make AI choose a simple legal black reply to e4: e7->e5
    findBestMove.mockImplementation(() => ({ from: "e7", to: "e5" }));

    render(<App />);

    await user.click(screen.getByLabelText(/ai opponent/i));

    // Human plays e2-e4
    await clickSquare(user, "e2");
    await clickSquare(user, "e4");

    // AI effect waits 120ms before computing, then dispatches APPLY_MOVE.
    await act(async () => {
      jest.advanceTimersByTime(200);
    });

    const history = moveHistoryLog();
    expect(history).toHaveTextContent(/\be4\b/);
    expect(history).toHaveTextContent(/\be5\b/);

    // Ensure our AI hook was invoked at least once
    expect(findBestMove).toHaveBeenCalled();

    jest.useRealTimers();
  });

  test("timers count down when enabled+started and pause during AI thinking", async () => {
    jest.useFakeTimers();

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    render(<App />);

    // Enable timers
    await user.click(screen.getByLabelText(/^timers$/i));
    const startPauseBtn = screen.getByRole("button", { name: /start/i });
    expect(startPauseBtn).toBeEnabled();

    // Start timers: white to move, so white clock should decrement.
    await user.click(startPauseBtn);

    const clocksBadge = screen.getByText(/W\s+\d\d:\d\d\s+•\s+B\s+\d\d:\d\d/i).closest(".badgeValue");
    expect(clocksBadge).toBeTruthy();

    const clocksBefore = clocksBadge.textContent;

    await act(async () => {
      jest.advanceTimersByTime(2000);
    });

    const clocksAfter = clocksBadge.textContent;
    expect(clocksAfter).not.toEqual(clocksBefore);

    // Now enable AI and force AI to "think" for a bit; timers should pause while aiThinking is true.
    await user.click(screen.getByLabelText(/ai opponent/i));

    // Move so it becomes AI turn; AI waits 120ms and sets aiThinking true quickly.
    await clickSquare(user, "d2");
    await clickSquare(user, "d4");

    // Let AI enter thinking state
    await act(async () => {
      jest.advanceTimersByTime(130);
    });

    // Capture clocks while AI is thinking; advance time and ensure it doesn't change.
    const clocksDuringThinking = clocksBadge.textContent;

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(clocksBadge.textContent).toEqual(clocksDuringThinking);

    jest.useRealTimers();
  });
});
