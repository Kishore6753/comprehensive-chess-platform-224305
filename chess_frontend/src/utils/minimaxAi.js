/**
 * Simple Minimax (alpha-beta) chess AI for chess.js.
 * Uses chess.js for legal move generation and move application.
 *
 * Notes:
 * - This is intentionally "basic" (no openings/endgame tables, limited eval).
 * - Depth is the main difficulty knob.
 */

import { Chess } from "chess.js";

const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000
};

// A tiny mobility bonus encourages activity; kept small to avoid erratic play.
const MOBILITY_BONUS_PER_MOVE = 2;

/**
 * Evaluate a chess.js position from White's perspective:
 * positive = advantage white, negative = advantage black.
 */
function evaluatePosition(chess) {
  // Terminal conditions first (high magnitude).
  if (chess.isCheckmate()) {
    // Side to move is checkmated.
    return chess.turn() === "w" ? -999999 : 999999;
  }
  if (chess.isDraw() || chess.isStalemate()) return 0;

  const board = chess.board();
  let score = 0;

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) continue;

      const base = PIECE_VALUES[p.type] ?? 0;
      score += p.color === "w" ? base : -base;

      // Very small piece-square encouragement (centralization).
      // Center is around (3.5, 3.5) in 0..7 coordinates.
      const dr = Math.abs(r - 3.5);
      const df = Math.abs(f - 3.5);
      const centerBonus = Math.round((3.5 - (dr + df) / 2) * 2); // roughly -? to +?
      // Knights/bishops benefit more; pawns/king less.
      const scale =
        p.type === "n" || p.type === "b" ? 3 : p.type === "q" || p.type === "r" ? 2 : p.type === "p" ? 1 : 1;
      score += (p.color === "w" ? 1 : -1) * centerBonus * scale;
    }
  }

  // Mobility term: side to move has some initiative; we approximate by counting legal moves.
  // This is simplistic but helps avoid being too material-greedy.
  const mobility = chess.moves().length * MOBILITY_BONUS_PER_MOVE;
  score += chess.turn() === "w" ? mobility : -mobility;

  // Small check bonus to prefer giving check (without going crazy).
  if (chess.isCheck()) {
    score += chess.turn() === "w" ? -25 : 25;
  }

  return score;
}

/**
 * Alpha-beta minimax.
 * Returns a score from White perspective.
 */
function alphabeta(chess, depth, alpha, beta, maximizingForWhite) {
  if (depth === 0 || chess.isGameOver()) {
    return evaluatePosition(chess);
  }

  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return evaluatePosition(chess);

  if (maximizingForWhite) {
    let value = -Infinity;
    for (const m of moves) {
      chess.move(m);
      const child = alphabeta(chess, depth - 1, alpha, beta, false);
      chess.undo();

      value = Math.max(value, child);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break; // beta cut-off
    }
    return value;
  }

  // minimizing for white == maximizing for black
  let value = Infinity;
  for (const m of moves) {
    chess.move(m);
    const child = alphabeta(chess, depth - 1, alpha, beta, true);
    chess.undo();

    value = Math.min(value, child);
    beta = Math.min(beta, value);
    if (alpha >= beta) break; // alpha cut-off
  }
  return value;
}

/**
 * Pick the best move for a given side by searching from the current position.
 * @param {string} fen current position FEN
 * @param {"w"|"b"} aiColor which side the AI is playing
 * @param {number} depth search depth (plies)
 * @returns {{ from: string, to: string, promotion?: string } | null}
 */
// PUBLIC_INTERFACE
export function findBestMove({ fen, aiColor, depth }) {
  /** Compute AI move using minimax + alpha-beta pruning for given side and depth. */
  const chess = new Chess();
  chess.load(fen);

  if (chess.isGameOver()) return null;
  if (chess.turn() !== aiColor) return null;

  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  // If AI is white, we maximize; if AI is black, we minimize (because evaluation is from white perspective).
  const maximizingForWhite = aiColor === "w";

  let bestMove = null;
  let bestScore = maximizingForWhite ? -Infinity : Infinity;

  for (const m of moves) {
    chess.move(m);
    const score = alphabeta(chess, depth - 1, -Infinity, Infinity, !maximizingForWhite);
    chess.undo();

    if (maximizingForWhite) {
      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
      }
    } else {
      if (score < bestScore) {
        bestScore = score;
        bestMove = m;
      }
    }
  }

  if (!bestMove) return null;

  // chess.js verbose moves include promotion field when applicable
  const out = { from: bestMove.from, to: bestMove.to };
  if (bestMove.promotion) out.promotion = bestMove.promotion;
  return out;
}

/**
 * Helper to map a difficulty label to a depth.
 * Depth meaning: number of plies (half-moves) searched.
 */
// PUBLIC_INTERFACE
export function difficultyToDepth(difficulty) {
  /** Map UI difficulty value to minimax depth. */
  switch (difficulty) {
    case "easy":
      return 1;
    case "medium":
      return 2;
    case "hard":
      return 3;
    default:
      return 2;
  }
}
