import React, { useEffect, useMemo, useReducer, useState } from "react";
import { Chess } from "chess.js";
import { ChessBoard } from "../components/ChessBoard";
import { MoveHistory } from "../components/MoveHistory";
import { PromotionModal } from "../components/PromotionModal";
import { useChessClock } from "../hooks/useChessClock";
import { difficultyToDepth, findBestMove } from "../utils/minimaxAi";

/**
 * Game reducer keeps all chess state transitions predictable and undoable.
 */

/**
 * Create a Chess instance from a FEN string.
 * Keeping chess.js objects out of reducer state avoids subtle UI desync caused by
 * holding a single mutable object across renders.
 */
function chessFromFen(fen) {
  const chess = new Chess();
  if (fen) chess.load(fen);
  return chess;
}

function createNewGame() {
  const chess = new Chess();
  return {
    // Source of truth for position. Everything else can be derived.
    fen: chess.fen(),
    board: chess.board(),
    selectedSquare: null,
    legalMoves: [],
    historySAN: [],
    pendingPromotion: null, // { from, to, color }
    timersEnabled: false,
    timerSeconds: 300
  };
}

function computeCheckSquare(chess) {
  // chess.js doesn't directly expose king square; use board scan
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === "k" && p.color === chess.turn()) {
        const file = "abcdefgh"[f];
        const rank = 8 - r;
        return `${file}${rank}`;
      }
    }
  }
  return null;
}

function statusText(chess, flag) {
  const turn = chess.turn() === "w" ? "White" : "Black";

  if (flag) {
    const loser = flag === "w" ? "White" : "Black";
    const winner = flag === "w" ? "Black" : "White";
    return `Time! ${loser} flagged. ${winner} wins.`;
  }

  if (chess.isCheckmate()) {
    const winner = chess.turn() === "w" ? "Black" : "White";
    return `Checkmate. ${winner} wins.`;
  }
  if (chess.isStalemate()) return "Stalemate. Draw.";
  if (chess.isDraw()) return "Draw.";
  if (chess.isCheck()) return `${turn} to move — Check!`;
  return `${turn} to move.`;
}

function isPromotionMove(chess, from, to) {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;

  // If pawn reaches 8th (white) or 1st (black)
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

function reducer(state, action) {
  switch (action.type) {
    case "RESET": {
      return createNewGame();
    }
    case "SET_TIMERS": {
      return { ...state, timersEnabled: action.enabled, timerSeconds: action.seconds };
    }
    case "SELECT_SQUARE": {
      return { ...state, selectedSquare: action.square, legalMoves: action.legalMoves };
    }
    case "CLEAR_SELECTION": {
      return { ...state, selectedSquare: null, legalMoves: [] };
    }
    case "PENDING_PROMOTION": {
      return { ...state, pendingPromotion: action.payload };
    }
    case "APPLY_MOVE": {
      // Pure reducer: derive chess from current fen, apply, and return new derived state.
      const chess = chessFromFen(state.fen);

      const { from, to, promotion } = action.move || {};

      if (!from || !to) {
        return { ...state, selectedSquare: null, legalMoves: [] };
      }

      const legal = chess.moves({ square: from, verbose: true });
      const found = legal.find((m) => m.from === from && m.to === to);

      if (!found) {
        return { ...state, selectedSquare: null, legalMoves: [] };
      }

      const moveToApply = { from, to };

      if (found.flags?.includes("p")) {
        moveToApply.promotion = promotion || "q";
      }

      const result = chess.move(moveToApply);

      if (!result) {
        return { ...state, selectedSquare: null, legalMoves: [] };
      }

      return {
        ...state,
        fen: chess.fen(),
        board: chess.board(),
        historySAN: chess.history(),
        selectedSquare: null,
        legalMoves: [],
        pendingPromotion: null
      };
    }
    case "UNDO": {
      const chess = chessFromFen(state.fen);
      chess.undo();
      return {
        ...state,
        fen: chess.fen(),
        board: chess.board(),
        historySAN: chess.history(),
        selectedSquare: null,
        legalMoves: [],
        pendingPromotion: null
      };
    }
    default:
      return state;
  }
}

// PUBLIC_INTERFACE
export function ChessGame() {
  /** Full-featured chess game with complete rules, highlights, SAN history, undo/reset, optional timers, and optional AI. */
  const [state, dispatch] = useReducer(reducer, undefined, createNewGame);

  // AI controls (kept separate from reducer to avoid complicating undo/history state).
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiSide, setAiSide] = useState("b"); // "w" or "b"
  const [aiDifficulty, setAiDifficulty] = useState("medium"); // easy|medium|hard
  const [aiThinking, setAiThinking] = useState(false);

  const chess = useMemo(() => chessFromFen(state.fen), [state.fen]);
  const turn = chess.turn();

  const gameOver = useMemo(() => {
    return chess.isGameOver();
  }, [chess, state.fen]);

  const { white, black, flag, reset: resetClocks } = useChessClock({
    initialSeconds: state.timerSeconds,
    activeColor: turn,
    enabled: state.timersEnabled,
    gameOver
  });

  const checkSquare = useMemo(() => {
    if (!chess.isCheck()) return null;
    return computeCheckSquare(chess);
  }, [chess, state.fen]);

  const status = useMemo(() => statusText(chess, flag), [chess, state.fen, flag]);

  const canUndo = state.historySAN.length > 0;

  const isAiTurn = useMemo(() => {
    if (!aiEnabled) return false;
    if (gameOver || flag) return false;
    if (state.pendingPromotion) return false; // human promotion UI open; don't interrupt
    return turn === aiSide;
  }, [aiEnabled, aiSide, turn, gameOver, flag, state.pendingPromotion]);

  const humanCanInteract = useMemo(() => {
    // When AI is thinking or it's AI's turn, lock board interactions.
    if (!aiEnabled) return !gameOver && !flag;
    if (aiThinking) return false;
    if (isAiTurn) return false;
    return !gameOver && !flag;
  }, [aiEnabled, aiThinking, isAiTurn, gameOver, flag]);

  // Trigger AI move automatically when it's AI's turn.
  useEffect(() => {
    if (!isAiTurn) return;
    if (aiThinking) return;

    let canceled = false;

    const doAiMove = async () => {
      setAiThinking(true);
      try {
        // Give UI a moment to update before computing (feels more natural).
        await new Promise((r) => window.setTimeout(r, 120));
        if (canceled) return;

        const depth = difficultyToDepth(aiDifficulty);
        const best = findBestMove({ fen: state.fen, aiColor: aiSide, depth });
        if (canceled) return;

        if (best) {
          dispatch({ type: "APPLY_MOVE", move: best });
        }
      } finally {
        if (!canceled) setAiThinking(false);
      }
    };

    doAiMove();

    return () => {
      canceled = true;
    };
  }, [isAiTurn, aiThinking, aiDifficulty, aiSide, state.fen]);

  const onSquareClick = (square) => {
    // If it's not the human's turn (AI), ignore board clicks
    if (!humanCanInteract) return;

    // If promotion selection is open, ignore board clicks
    if (state.pendingPromotion) return;

    const piece = chess.get(square);

    // If a piece is selected, attempt move to clicked square if legal
    if (state.selectedSquare) {
      const from = state.selectedSquare;
      const to = square;

      if (from === to) {
        dispatch({ type: "CLEAR_SELECTION" });
        return;
      }

      const legal = chess.moves({ square: from, verbose: true });
      const found = legal.find((m) => m.to === to);

      if (!found) {
        if (piece && piece.color === turn) {
          const nextLegal = chess.moves({ square, verbose: true });
          dispatch({ type: "SELECT_SQUARE", square, legalMoves: nextLegal });
        } else {
          dispatch({ type: "CLEAR_SELECTION" });
        }
        return;
      }

      if (isPromotionMove(chess, from, to)) {
        dispatch({
          type: "PENDING_PROMOTION",
          payload: { from, to, color: chess.get(from)?.color ?? turn }
        });
        return;
      }

      dispatch({ type: "APPLY_MOVE", move: { from, to } });
      return;
    }

    // No piece selected yet => select if it's current player's piece
    if (piece && piece.color === turn && !gameOver && !flag) {
      const legalMoves = chess.moves({ square, verbose: true });
      dispatch({ type: "SELECT_SQUARE", square, legalMoves });
    } else {
      dispatch({ type: "CLEAR_SELECTION" });
    }
  };

  const onPromotionSelect = (promotionType) => {
    const pending = state.pendingPromotion;
    if (!pending) return;

    // Promotion selection is only for the side currently moving (human, in our UI flow).
    dispatch({
      type: "APPLY_MOVE",
      move: { from: pending.from, to: pending.to, promotion: promotionType }
    });
  };

  const onUndo = () => {
    if (!canUndo) return;
    dispatch({ type: "UNDO" });
  };

  const onReset = () => {
    dispatch({ type: "RESET" });
    resetClocks();
    setAiThinking(false);
  };

  const toggleTimers = () => {
    dispatch({ type: "SET_TIMERS", enabled: !state.timersEnabled, seconds: state.timerSeconds });
    resetClocks();
  };

  return (
    <div className="container">
      <div className="headerBar">
        <div className="brand">
          <h1 className="title">Retro Chess</h1>
          <p className="subtitle">Full rules • Highlights • SAN history • Undo/Reset • Optional timers • Minimax AI</p>
        </div>
        <div className="badge" aria-label="Current position FEN">
          <p className="badgeTitle">FEN</p>
          <p className="badgeValue" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {state.fen}
          </p>
        </div>
      </div>

      <div className="panel boardPanel">
        <div className="topStatus">
          <div className="badge">
            <p className="badgeTitle">Turn</p>
            <p className="badgeValue">
              {turn === "w" ? "White" : "Black"}
              {aiEnabled && turn === aiSide ? (
                <span style={{ color: "rgba(234, 240, 255, 0.55)" }}>{aiThinking ? " (AI thinking…)" : " (AI)"}</span>
              ) : null}
            </p>
          </div>

          <div className="badge">
            <p className="badgeTitle">Clocks</p>
            <p className="badgeValue">
              W {formatClock(white)} • B {formatClock(black)}{" "}
              <span style={{ color: "rgba(234, 240, 255, 0.55)" }}>{state.timersEnabled ? "" : "(disabled)"}</span>
            </p>
          </div>
        </div>

        <div className="aiControls" aria-label="AI controls">
          <div className="aiControlsRow">
            <label className="aiLabel">
              <span className="aiLabelText">AI Opponent</span>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => {
                  setAiEnabled(e.target.checked);
                  setAiThinking(false);
                  dispatch({ type: "CLEAR_SELECTION" });
                }}
              />
            </label>

            <label className="aiLabel">
              <span className="aiLabelText">AI plays</span>
              <select
                value={aiSide}
                onChange={(e) => {
                  setAiSide(e.target.value);
                  setAiThinking(false);
                  dispatch({ type: "CLEAR_SELECTION" });
                }}
                disabled={!aiEnabled}
              >
                <option value="w">White</option>
                <option value="b">Black</option>
              </select>
            </label>

            <label className="aiLabel">
              <span className="aiLabelText">Difficulty</span>
              <select
                value={aiDifficulty}
                onChange={(e) => setAiDifficulty(e.target.value)}
                disabled={!aiEnabled}
              >
                <option value="easy">Easy (depth 1)</option>
                <option value="medium">Medium (depth 2)</option>
                <option value="hard">Hard (depth 3)</option>
              </select>
            </label>
          </div>

          <div className="smallHelp">
            AI uses minimax + alpha-beta pruning. Higher difficulty searches deeper and may feel slower.
          </div>
        </div>

        <ChessBoard
          board={state.board}
          selectedSquare={state.selectedSquare}
          legalMoves={humanCanInteract ? state.legalMoves : []}
          inCheckSquare={checkSquare}
          onSquareClick={onSquareClick}
        />

        <div className="statusLine" role="status" aria-live="polite">
          <span className="statusEmph">Status:</span> {status}
        </div>

        <div className="controls" aria-label="Game controls">
          <button type="button" className="btn btnPrimary" onClick={onReset}>
            Restart
          </button>

          <button type="button" className="btn" onClick={onUndo} disabled={!canUndo || aiThinking}>
            Undo
          </button>

          <button type="button" className="btn" onClick={toggleTimers}>
            {state.timersEnabled ? "Disable Timers" : "Enable Timers"}
          </button>

          <button
            type="button"
            className="btn btnDanger"
            onClick={() => dispatch({ type: "CLEAR_SELECTION" })}
            disabled={!state.selectedSquare || aiThinking}
          >
            Clear Selection
          </button>
        </div>

        <div className="smallHelp">
          Tip: Click a piece to see all legal moves. Illegal moves are prevented (including moves that leave your king in
          check). Check/checkmate/stalemate are detected automatically.
          {aiEnabled ? " When AI is enabled, the board locks during AI turns." : ""}
        </div>
      </div>

      <div className="panel sidePanel">
        <MoveHistory history={state.historySAN} />
        <div className="smallHelp">Moves are recorded in standard algebraic notation (SAN). Use Undo to step back.</div>
      </div>

      {state.pendingPromotion ? <PromotionModal color={state.pendingPromotion.color} onSelect={onPromotionSelect} /> : null}
    </div>
  );
}

function formatClock(seconds) {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
