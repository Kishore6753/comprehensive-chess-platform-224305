import React, { useMemo, useReducer } from "react";
import { Chess } from "chess.js";
import { ChessBoard } from "../components/ChessBoard";
import { MoveHistory } from "../components/MoveHistory";
import { PromotionModal } from "../components/PromotionModal";
import { useChessClock } from "../hooks/useChessClock";

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
  /** Full-featured chess game with complete rules, highlights, SAN history, undo/reset, and optional timers. */
  const [state, dispatch] = useReducer(reducer, undefined, createNewGame);

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

  const onSquareClick = (square) => {
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
          <p className="subtitle">Full rules • Highlights • SAN history • Undo/Reset • Optional timers</p>
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
            <p className="badgeValue">{turn === "w" ? "White" : "Black"}</p>
          </div>

          <div className="badge">
            <p className="badgeTitle">Clocks</p>
            <p className="badgeValue">
              W {formatClock(white)} • B {formatClock(black)}{" "}
              <span style={{ color: "rgba(234, 240, 255, 0.55)" }}>{state.timersEnabled ? "" : "(disabled)"}</span>
            </p>
          </div>
        </div>

        <ChessBoard
          board={state.board}
          selectedSquare={state.selectedSquare}
          legalMoves={state.legalMoves}
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

          <button type="button" className="btn" onClick={onUndo} disabled={!canUndo}>
            Undo
          </button>

          <button type="button" className="btn" onClick={toggleTimers}>
            {state.timersEnabled ? "Disable Timers" : "Enable Timers"}
          </button>

          <button
            type="button"
            className="btn btnDanger"
            onClick={() => dispatch({ type: "CLEAR_SELECTION" })}
            disabled={!state.selectedSquare}
          >
            Clear Selection
          </button>
        </div>

        <div className="smallHelp">
          Tip: Click a piece to see all legal moves. Illegal moves are prevented (including moves that leave your king in
          check). Check/checkmate/stalemate are detected automatically.
        </div>
      </div>

      <div className="panel sidePanel">
        <MoveHistory history={state.historySAN} />
        <div className="smallHelp">
          Moves are recorded in standard algebraic notation (SAN). Use Undo to step back.
        </div>
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
