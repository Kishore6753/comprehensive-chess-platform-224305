import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Chess } from "chess.js";
import { ChessBoard } from "../components/ChessBoard";
import { MoveHistory } from "../components/MoveHistory";
import { PromotionModal } from "../components/PromotionModal";
import { ThemeToggle } from "../components/ThemeToggle";
import { useChessClock } from "../hooks/useChessClock";
import { difficultyToRandomness, difficultyToTimeBudgetMs, difficultyToDepth, findBestMove } from "../utils/minimaxAi";
import { playCaptureSfx, playMoveSfx, primeSfx } from "../utils/sfx";

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

    // Timer configuration (base time). Running/paused is managed in component state.
    timersEnabled: false,
    timerSeconds: 300,

    // Draw offer flow
    // drawOffer: null | { offeredBy: "w"|"b", ply: number, atMs: number }
    drawOffer: null,

    // Game end state (in addition to chess.js built-in gameOver conditions).
    // end: null | { result: "1-0"|"0-1"|"1/2-1/2", reason: string }
    end: null
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

function statusText({ chess, flag, end, drawOffer }) {
  const turn = chess.turn() === "w" ? "White" : "Black";

  if (end) {
    return `${end.reason} (${end.result})`;
  }

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

  if (drawOffer) {
    const offeredBy = drawOffer.offeredBy === "w" ? "White" : "Black";
    return `${turn} to move. Draw offered by ${offeredBy}.`;
  }

  return `${turn} to move.`;
}

function isPromotionMove(chess, from, to) {
  const piece = chess.get(from);
  if (!piece || piece.type !== "p") return false;

  // If pawn reaches 8th (white) or 1st (black)
  const targetRank = to[1];
  return (piece.color === "w" && targetRank === "8") || (piece.color === "b" && targetRank === "1");
}

function clampTimerSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 300;
  return Math.min(60 * 60, Math.max(10, Math.round(n)));
}

function movePly(chess) {
  // chess.js half-move counter isn't exposed directly; derive from history length.
  return chess.history().length;
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

    case "OFFER_DRAW": {
      // Only allow if not already offered and game not ended.
      if (state.end) return state;
      if (state.drawOffer) return state;

      const chess = chessFromFen(state.fen);
      const offeredBy = chess.turn();
      const ply = movePly(chess);

      return {
        ...state,
        drawOffer: { offeredBy, ply, atMs: Date.now() }
      };
    }

    case "RESPOND_DRAW": {
      // payload: { response: "accept"|"decline" }
      if (state.end) return state;
      if (!state.drawOffer) return state;

      if (action.response === "accept") {
        return {
          ...state,
          end: { result: "1/2-1/2", reason: "Draw by agreement" },
          drawOffer: null,
          selectedSquare: null,
          legalMoves: [],
          pendingPromotion: null
        };
      }

      // decline -> clear offer
      return {
        ...state,
        drawOffer: null
      };
    }

    case "CLEAR_DRAW_OFFER": {
      if (!state.drawOffer) return state;
      return { ...state, drawOffer: null };
    }

    case "APPLY_MOVE": {
      // If game already ended by agreement, do nothing.
      if (state.end) return state;

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

      // chess.js may throw on invalid input; protect reducer from runtime crashes.
      try {
        const result = chess.move(moveToApply);
        if (!result) {
          return { ...state, selectedSquare: null, legalMoves: [] };
        }
      } catch (e) {
        return { ...state, selectedSquare: null, legalMoves: [] };
      }

      return {
        ...state,
        fen: chess.fen(),
        board: chess.board(),
        historySAN: chess.history(),
        selectedSquare: null,
        legalMoves: [],
        pendingPromotion: null,
        // Offer expires on any move.
        drawOffer: null
      };
    }

    case "UNDO": {
      if (state.end) {
        // Allow undo to step back from an agreed draw? For simplicity, treat undo as resuming play and clearing end state.
        // This matches the requirement "on reset/undo to a position before the offer" and keeps UI consistent.
        // Undo will also clear any offer implicitly.
      }

      const chess = chessFromFen(state.fen);
      chess.undo();

      const nextPly = movePly(chess);
      const offerStillValid = state.drawOffer && state.drawOffer.ply === nextPly;

      return {
        ...state,
        fen: chess.fen(),
        board: chess.board(),
        historySAN: chess.history(),
        selectedSquare: null,
        legalMoves: [],
        pendingPromotion: null,
        // If undo rewinds past the offer ply, clear the offer.
        drawOffer: offerStillValid ? state.drawOffer : null,
        // Undoing implies we're back in normal play.
        end: null
      };
    }
    default:
      return state;
  }
}

/**
 * @param {{ theme?: "light"|"dark", onToggleTheme?: () => void }} props
 */
// PUBLIC_INTERFACE
export function ChessGame({ theme = "dark", onToggleTheme }) {
  /** Full-featured chess game with complete rules, highlights, SAN history, undo/reset, optional timers, and optional AI. */
  const [state, dispatch] = useReducer(reducer, undefined, createNewGame);

  // AI controls (kept separate from reducer to avoid complicating undo/history state).
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiSide, setAiSide] = useState("b"); // "w" or "b"
  const [aiDifficulty, setAiDifficulty] = useState("medium"); // easy|medium|hard
  const [aiThinking, setAiThinking] = useState(false);

  // Timer run state (separate from reducer; config lives in reducer).
  const [timersRunning, setTimersRunning] = useState(false);

  // SFX: detect successful move application by watching history length changes.
  const prevHistoryLenRef = useRef(0);

  // SFX: prime audio on first user gesture (autoplay policies).
  const audioPrimedRef = useRef(false);

  const chess = useMemo(() => chessFromFen(state.fen), [state.fen]);
  const turn = chess.turn();

  const gameOverByRules = useMemo(() => {
    return chess.isGameOver();
  }, [chess, state.fen]);

  const gameOver = Boolean(state.end) || gameOverByRules;

  const isAiTurn = useMemo(() => {
    if (!aiEnabled) return false;
    if (gameOver) return false;
    if (state.pendingPromotion) return false; // human promotion UI open; don't interrupt
    return turn === aiSide;
  }, [aiEnabled, aiSide, turn, gameOver, state.pendingPromotion]);

  const isClockPaused = useMemo(() => {
    // Pauses when:
    // - timers aren't enabled or not started
    // - game over
    // - promotion modal open (waiting for choice)
    // - AI is thinking (avoid burning time while engine computes / UI locks)
    if (!state.timersEnabled) return true;
    if (!timersRunning) return true;
    if (gameOver) return true;
    if (state.pendingPromotion) return true;
    if (aiThinking) return true;
    return false;
  }, [state.timersEnabled, timersRunning, gameOver, state.pendingPromotion, aiThinking]);

  const { white, black, flag, reset: resetClocks } = useChessClock({
    initialSeconds: state.timerSeconds,
    activeColor: turn,
    enabled: state.timersEnabled,
    paused: isClockPaused,
    gameOver
  });

  // If someone flags, the game should effectively stop: pause timers and stop AI.
  useEffect(() => {
    if (!flag) return;
    setTimersRunning(false);
    setAiThinking(false);
  }, [flag]);

  // If game ends by agreement, stop timers and AI.
  useEffect(() => {
    if (!state.end) return;
    setTimersRunning(false);
    setAiThinking(false);
  }, [state.end]);

  const checkSquare = useMemo(() => {
    if (!chess.isCheck()) return null;
    return computeCheckSquare(chess);
  }, [chess, state.fen]);

  const status = useMemo(
    () =>
      statusText({
        chess,
        flag,
        end: state.end,
        drawOffer: state.drawOffer
      }),
    [chess, state.fen, flag, state.end, state.drawOffer]
  );

  const canUndo = state.historySAN.length > 0;

  const humanCanInteract = useMemo(() => {
    // When AI is thinking or it's AI's turn, lock board interactions.
    if (gameOver || flag) return false;
    if (!aiEnabled) return true;
    if (aiThinking) return false;
    if (isAiTurn) return false;
    return true;
  }, [aiEnabled, aiThinking, isAiTurn, gameOver, flag]);

  const isHumanTurn = useMemo(() => {
    if (gameOver || flag) return false;
    if (!aiEnabled) return true;
    return turn !== aiSide;
  }, [aiEnabled, aiSide, turn, gameOver, flag]);

  const canOfferDraw = useMemo(() => {
    if (!isHumanTurn) return false;
    if (state.end) return false;
    if (gameOverByRules) return false;
    if (state.pendingPromotion) return false;
    if (state.drawOffer) return false;
    if (aiThinking) return false;
    return true;
  }, [isHumanTurn, state.end, gameOverByRules, state.pendingPromotion, state.drawOffer, aiThinking]);

  const drawOfferTarget = useMemo(() => {
    if (!state.drawOffer) return null;
    return state.drawOffer.offeredBy === "w" ? "b" : "w";
  }, [state.drawOffer]);

  const isDrawBannerVisible = useMemo(() => {
    if (!state.drawOffer) return false;
    if (gameOver || flag) return false;
    // "Offers are only active on the opponent's turn"
    return turn === drawOfferTarget;
  }, [state.drawOffer, drawOfferTarget, turn, gameOver, flag]);

  const isAiOpponentOfOffer = useMemo(() => {
    if (!aiEnabled) return false;
    if (!state.drawOffer) return false;
    return drawOfferTarget === aiSide;
  }, [aiEnabled, state.drawOffer, drawOfferTarget, aiSide]);

  // Simple AI policy: decline draw offers by default.
  useEffect(() => {
    if (!isDrawBannerVisible) return;
    if (!isAiOpponentOfOffer) return;
    if (gameOver || flag) return;

    const id = window.setTimeout(() => {
      // Clear offer; do not auto-accept.
      dispatch({ type: "RESPOND_DRAW", response: "decline" });
    }, 250);

    return () => window.clearTimeout(id);
  }, [isDrawBannerVisible, isAiOpponentOfOffer, gameOver, flag]);

  // Trigger AI move automatically when it's AI's turn.
  useEffect(() => {
    if (!aiEnabled) return;
    if (!isAiTurn) return;
    if (aiThinking) return;
    if (gameOver || flag) return;

    // If there's an outstanding draw offer, it should be handled first.
    // Since we currently auto-decline when AI is the offer target, and humans can respond when human is target,
    // we simply avoid making AI moves while a banner is visible.
    if (isDrawBannerVisible) return;

    let canceled = false;

    const doAiMove = async () => {
      setAiThinking(true);
      try {
        // Give UI a moment to update before computing (feels more natural).
        await new Promise((r) => window.setTimeout(r, 120));
        if (canceled) return;

        const depth = difficultyToDepth(aiDifficulty);
        const timeBudgetMs = difficultyToTimeBudgetMs(aiDifficulty);
        const randomness = difficultyToRandomness(aiDifficulty);

        const best = findBestMove({
          fen: state.fen,
          aiColor: aiSide,
          depth,
          timeBudgetMs,
          randomness
        });
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
  }, [
    aiEnabled,
    isAiTurn,
    aiThinking,
    aiDifficulty,
    aiSide,
    state.fen,
    gameOver,
    flag,
    isDrawBannerVisible
  ]);

  // Stop timers automatically on checkmate/draw/etc.
  useEffect(() => {
    if (!state.timersEnabled) return;
    if (!gameOver) return;
    setTimersRunning(false);
  }, [state.timersEnabled, gameOver]);

  // SFX: play after a successful move (human or AI) by observing history growth.
  useEffect(() => {
    const prevLen = prevHistoryLenRef.current;
    const nextLen = state.historySAN.length;

    // Ignore initial mount, undo, and reset (history shrinks or stays same).
    if (nextLen <= prevLen) {
      prevHistoryLenRef.current = nextLen;
      return;
    }

    // Determine whether the last applied move was a capture using chess.js verbose history.
    // We derive this from the *current* position after the move has been applied.
    try {
      const verboseHistory = chess.history({ verbose: true });
      const last = verboseHistory[verboseHistory.length - 1];

      // Capture flags: 'c' (capture) or 'e' (en passant capture).
      const isCapture = Boolean(last && (last.flags?.includes("c") || last.flags?.includes("e")));

      // Fire-and-forget: never await, never block UI.
      if (isCapture) playCaptureSfx();
      else playMoveSfx();
    } catch {
      // If anything goes wrong, fail silently (SFX must never break gameplay).
    } finally {
      prevHistoryLenRef.current = nextLen;
    }
  }, [state.historySAN.length, chess]);

  const onSquareClick = (square) => {
    // Prime audio on the first user gesture to satisfy autoplay policies.
    if (!audioPrimedRef.current) {
      audioPrimedRef.current = true;
      primeSfx();
    }

    // If it's not the human's turn (AI), ignore board clicks
    if (!humanCanInteract) return;

    // If a draw offer is waiting for a response from the current human, keep UI locked until respond.
    if (isDrawBannerVisible && state.drawOffer && turn === drawOfferTarget && !isAiOpponentOfOffer) return;

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
    resetClocks(state.timerSeconds);
    setTimersRunning(false);
    setAiThinking(false);
  };

  const toggleTimersEnabled = () => {
    const nextEnabled = !state.timersEnabled;
    dispatch({ type: "SET_TIMERS", enabled: nextEnabled, seconds: state.timerSeconds });
    setTimersRunning(false);
    resetClocks(state.timerSeconds);
  };

  const onTimerSecondsChange = (e) => {
    const nextSeconds = clampTimerSeconds(e.target.value);
    dispatch({ type: "SET_TIMERS", enabled: state.timersEnabled, seconds: nextSeconds });
    // If user reconfigures time, reset clocks and stop running.
    setTimersRunning(false);
    resetClocks(nextSeconds);
  };

  const onStartPauseTimers = () => {
    if (!state.timersEnabled) return;
    if (gameOver || flag) return;
    setTimersRunning((r) => !r);
  };

  const onResetTimers = () => {
    resetClocks(state.timerSeconds);
    setTimersRunning(false);
  };

  const onOfferDraw = () => {
    dispatch({ type: "OFFER_DRAW" });
  };

  const onAcceptDraw = () => {
    dispatch({ type: "RESPOND_DRAW", response: "accept" });
  };

  const onDeclineDraw = () => {
    dispatch({ type: "RESPOND_DRAW", response: "decline" });
  };

  const offerByLabel = state.drawOffer?.offeredBy === "w" ? "White" : "Black";

  return (
    <div className="container">
      <div className="headerBar">
        <div className="brand">
          <h1 className="title">Retro Chess</h1>
          <p className="subtitle">Full rules • Highlights • SAN history • Undo/Reset • Optional timers • Minimax AI</p>
        </div>

        <div className="headerActions" aria-label="Header actions">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />

          <div className="badge" aria-label="Current position FEN">
            <p className="badgeTitle">FEN</p>
            <p className="badgeValue" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {state.fen}
            </p>
          </div>
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

        {isDrawBannerVisible ? (
          <div className="drawBanner" role="alert" aria-live="polite" aria-label="Draw offer">
            <div className="drawBannerText">Draw offer from <strong>{offerByLabel}</strong>.</div>

            {isAiOpponentOfOffer ? (
              <div className="drawBannerActions">
                <span className="drawBannerHint">AI declined.</span>
              </div>
            ) : (
              <div className="drawBannerActions">
                <button type="button" className="btn btnPrimary" onClick={onAcceptDraw}>
                  Accept
                </button>
                <button type="button" className="btn" onClick={onDeclineDraw}>
                  Decline
                </button>
              </div>
            )}
          </div>
        ) : null}

        <div className="aiControls" aria-label="Timers and AI controls">
          <div className="aiControlsRow" style={{ justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label className="aiLabel">
                <span className="aiLabelText">Timers</span>
                <input type="checkbox" checked={state.timersEnabled} onChange={toggleTimersEnabled} />
              </label>

              <label className="aiLabel">
                <span className="aiLabelText">Time (sec)</span>
                <input
                  type="number"
                  min={10}
                  max={3600}
                  step={10}
                  value={state.timerSeconds}
                  onChange={onTimerSecondsChange}
                  disabled={!state.timersEnabled}
                  style={{
                    width: 110,
                    border: "1px solid var(--border)",
                    background: "rgba(255, 255, 255, 0.06)",
                    color: "var(--text)",
                    padding: "8px 10px",
                    borderRadius: 10,
                    fontWeight: 700,
                    fontSize: 13
                  }}
                />
              </label>

              <button
                type="button"
                className="btn"
                onClick={onStartPauseTimers}
                disabled={!state.timersEnabled || gameOver || Boolean(flag)}
              >
                {timersRunning ? "Pause" : "Start"}
              </button>

              <button type="button" className="btn" onClick={onResetTimers} disabled={!state.timersEnabled}>
                Reset Timers
              </button>
            </div>

            <label className="aiLabel">
              <span className="aiLabelText">AI Opponent</span>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => {
                  setAiEnabled(e.target.checked);
                  setAiThinking(false);
                  dispatch({ type: "CLEAR_SELECTION" });
                  // If AI is turned on/off, any outstanding offer should not linger confusingly.
                  dispatch({ type: "CLEAR_DRAW_OFFER" });
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
                  dispatch({ type: "CLEAR_DRAW_OFFER" });
                }}
                disabled={!aiEnabled}
              >
                <option value="w">White</option>
                <option value="b">Black</option>
              </select>
            </label>

            <label className="aiLabel">
              <span className="aiLabelText">Difficulty</span>
              <select value={aiDifficulty} onChange={(e) => setAiDifficulty(e.target.value)} disabled={!aiEnabled}>
                <option value="easy">Easy (depth 2)</option>
                <option value="medium">Medium (depth 3)</option>
                <option value="hard">Hard (depth 5)</option>
              </select>
            </label>
          </div>

          <div className="smallHelp">
            Timers count down only while running and will pause during AI thinking / promotion selection. AI uses minimax +
            alpha-beta pruning; higher difficulty searches deeper and may feel slower.
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

          <button
            type="button"
            className="btn"
            onClick={onOfferDraw}
            disabled={!canOfferDraw}
            aria-label="Offer draw"
          >
            Offer Draw
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
