/**
 * Browser-friendly Minimax (alpha-beta) chess AI for chess.js.
 *
 * Goals:
 * - Stronger evaluation than pure material: PST, mobility, king safety, pawn structure.
 * - Difficulty presets map to noticeable strength differences.
 * - Keep UI responsive: alpha-beta + move ordering + time budget (soft cutoff).
 *
 * Evaluation convention:
 * - Positive score means advantage for White; negative means advantage for Black.
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

// Tunable weights (kept conservative to avoid wild play)
const EVAL = {
  // Mobility: prefer having more options; scaled by game phase
  mobilityPerMoveMid: 2,
  mobilityPerMoveEnd: 3,

  // King safety
  inCheckPenalty: 35, // side-to-move is in check -> penalty to that side
  castledBonus: 18,
  kingOpenFilePenalty: 10,

  // Pawn structure
  doubledPawnPenalty: 12,
  isolatedPawnPenalty: 10,
  passedPawnBonus: 14, // base, further scaled by advancement

  // Bishop pair (small)
  bishopPairBonus: 18
};

const INF = 10 ** 15;

// Piece-square tables (midgame-ish). Values in centipawns from White perspective.
// Indexing: 0..63 where 0=a8, 7=h8, 56=a1, 63=h1 (same as chess.board() scan order).
// For Black, we mirror vertically.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    55, 65, 65, 45, 45, 65, 65, 55,
    22, 28, 34, 48, 48, 34, 28, 22,
    10, 14, 20, 35, 35, 20, 14, 10,
    6, 10, 14, 26, 26, 14, 10, 6,
    4, 6, 8, 16, 16, 8, 6, 4,
    2, 2, 2, -8, -8, 2, 2, 2,
    0, 0, 0, 0, 0, 0, 0, 0
  ],
  n: [
    -60, -35, -20, -15, -15, -20, -35, -60,
    -35, -15, 0, 8, 8, 0, -15, -35,
    -20, 0, 10, 18, 18, 10, 0, -20,
    -15, 8, 18, 26, 26, 18, 8, -15,
    -15, 8, 18, 26, 26, 18, 8, -15,
    -20, 0, 10, 18, 18, 10, 0, -20,
    -35, -15, 0, 8, 8, 0, -15, -35,
    -60, -35, -20, -15, -15, -20, -35, -60
  ],
  b: [
    -30, -18, -12, -10, -10, -12, -18, -30,
    -18, -6, 0, 4, 4, 0, -6, -18,
    -12, 0, 6, 10, 10, 6, 0, -12,
    -10, 4, 10, 14, 14, 10, 4, -10,
    -10, 4, 10, 14, 14, 10, 4, -10,
    -12, 0, 6, 10, 10, 6, 0, -12,
    -18, -6, 0, 4, 4, 0, -6, -18,
    -30, -18, -12, -10, -10, -12, -18, -30
  ],
  r: [
    -10, -8, -4, 0, 0, -4, -8, -10,
    -8, -4, 0, 4, 4, 0, -4, -8,
    -4, 0, 4, 8, 8, 4, 0, -4,
    0, 4, 8, 10, 10, 8, 4, 0,
    0, 4, 8, 10, 10, 8, 4, 0,
    -4, 0, 4, 8, 8, 4, 0, -4,
    -8, -4, 0, 4, 4, 0, -4, -8,
    -10, -8, -4, 0, 0, -4, -8, -10
  ],
  q: [
    -25, -12, -6, -2, -2, -6, -12, -25,
    -12, -2, 2, 4, 4, 2, -2, -12,
    -6, 2, 6, 8, 8, 6, 2, -6,
    -2, 4, 8, 10, 10, 8, 4, -2,
    -2, 4, 8, 10, 10, 8, 4, -2,
    -6, 2, 6, 8, 8, 6, 2, -6,
    -12, -2, 2, 4, 4, 2, -2, -12,
    -25, -12, -6, -2, -2, -6, -12, -25
  ],
  k: [
    20, 30, 10, 0, 0, 10, 30, 20,
    10, 10, 0, -10, -10, 0, 10, 10,
    0, 0, -10, -20, -20, -10, 0, 0,
    -10, -10, -20, -30, -30, -20, -10, -10,
    -20, -20, -30, -40, -40, -30, -20, -20,
    -20, -20, -30, -40, -40, -30, -20, -20,
    -20, -20, -30, -40, -40, -30, -20, -20,
    -20, -20, -30, -40, -40, -30, -20, -20
  ]
};

function mirrorIndex(i) {
  // Mirror vertically: a8<->a1 (0<->56), keep file the same.
  const row = Math.floor(i / 8);
  const col = i % 8;
  const mirroredRow = 7 - row;
  return mirroredRow * 8 + col;
}

function pstValue(pieceType, color, idx) {
  const table = PST[pieceType];
  if (!table) return 0;
  if (color === "w") return table[idx] ?? 0;
  return table[mirrorIndex(idx)] ?? 0;
}

function squareFile(square) {
  // "a1" -> 0
  return square.charCodeAt(0) - 97;
}

function countPieces(chess) {
  const board = chess.board();
  let count = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (board[r][f]) count++;
    }
  }
  return count;
}

function isEndgame(chess) {
  // Heuristic: fewer pieces on board => endgame-ish
  return countPieces(chess) <= 14;
}

function getKingSquare(chess, color) {
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (p && p.type === "k" && p.color === color) {
        const file = "abcdefgh"[f];
        const rank = 8 - r;
        return `${file}${rank}`;
      }
    }
  }
  return null;
}

function evaluatePawnStructure(chess) {
  const board = chess.board();

  const pawnsByFile = {
    w: Array.from({ length: 8 }, () => []),
    b: Array.from({ length: 8 }, () => [])
  };

  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p || p.type !== "p") continue;
      const file = f;
      const rankFromWhiteBottom = 8 - r; // 1..8
      pawnsByFile[p.color][file].push(rankFromWhiteBottom);
    }
  }

  // Sort ranks for easier passed pawn determination
  for (const c of ["w", "b"]) {
    for (let f = 0; f < 8; f++) {
      pawnsByFile[c][f].sort((a, b) => a - b);
    }
  }

  let score = 0;

  for (const color of ["w", "b"]) {
    const sign = color === "w" ? 1 : -1;

    // Doubled pawns & isolated pawns
    for (let f = 0; f < 8; f++) {
      const pawns = pawnsByFile[color][f];
      if (pawns.length >= 2) {
        score += sign * -EVAL.doubledPawnPenalty * (pawns.length - 1);
      }

      if (pawns.length >= 1) {
        const hasLeft = f > 0 && pawnsByFile[color][f - 1].length > 0;
        const hasRight = f < 7 && pawnsByFile[color][f + 1].length > 0;
        if (!hasLeft && !hasRight) score += sign * -EVAL.isolatedPawnPenalty;
      }
    }

    // Passed pawns
    // For each pawn, if no enemy pawn on same/adjacent file in front of it => passed.
    const enemy = color === "w" ? "b" : "w";
    for (let f = 0; f < 8; f++) {
      for (const rank of pawnsByFile[color][f]) {
        const filesToCheck = [f - 1, f, f + 1].filter((x) => x >= 0 && x <= 7);

        let blockedByEnemy = false;
        for (const ef of filesToCheck) {
          for (const erank of pawnsByFile[enemy][ef]) {
            if (color === "w") {
              if (erank > rank) {
                blockedByEnemy = true;
                break;
              }
            } else {
              if (erank < rank) {
                blockedByEnemy = true;
                break;
              }
            }
          }
          if (blockedByEnemy) break;
        }

        if (!blockedByEnemy) {
          // More bonus the closer to promotion
          const advance = color === "w" ? rank - 2 : 7 - rank; // 0..5-ish
          const bonus = EVAL.passedPawnBonus + Math.max(0, advance) * 4;
          score += sign * bonus;
        }
      }
    }
  }

  return score;
}

function evaluateKingSafety(chess) {
  let score = 0;

  const wKing = getKingSquare(chess, "w");
  const bKing = getKingSquare(chess, "b");

  // If king is missing (shouldn't happen in legal chess), ignore.
  if (!wKing || !bKing) return 0;

  // Castling-ish heuristic: king on g1/c1 or g8/c8 gets small bonus.
  if (wKing === "g1" || wKing === "c1") score += EVAL.castledBonus;
  if (bKing === "g8" || bKing === "c8") score -= EVAL.castledBonus;

  // Open file near king: penalize if no friendly pawn on king file.
  // This is crude but helps avoid leaving king in the center with no pawn cover.
  const board = chess.board();

  const hasPawnOnFile = (color, fileIndex) => {
    for (let r = 0; r < 8; r++) {
      const p = board[r][fileIndex];
      if (p && p.color === color && p.type === "p") return true;
    }
    return false;
  };

  const wf = squareFile(wKing);
  const bf = squareFile(bKing);

  if (!hasPawnOnFile("w", wf)) score -= EVAL.kingOpenFilePenalty;
  if (!hasPawnOnFile("b", bf)) score += EVAL.kingOpenFilePenalty;

  // Side to move is in check: penalize side to move.
  if (chess.isCheck()) {
    score += chess.turn() === "w" ? -EVAL.inCheckPenalty : EVAL.inCheckPenalty;
  }

  return score;
}

/**
 * Evaluate a chess.js position from White perspective.
 */
function evaluatePosition(chess) {
  // Terminal conditions first (high magnitude).
  if (chess.isCheckmate()) {
    // Side to move is checkmated.
    return chess.turn() === "w" ? -999999 : 999999;
  }
  if (chess.isDraw() || chess.isStalemate()) return 0;

  const board = chess.board();
  const endgame = isEndgame(chess);

  let score = 0;

  // Material + PST
  let whiteBishops = 0;
  let blackBishops = 0;

  let idx = 0;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board[r][f];
      if (!p) {
        idx++;
        continue;
      }

      const base = PIECE_VALUES[p.type] ?? 0;
      const pst = pstValue(p.type, p.color, idx);

      if (p.type === "b") {
        if (p.color === "w") whiteBishops++;
        else blackBishops++;
      }

      // King PST should matter less in endgame (king becomes active). We dampen it.
      const pstScale = p.type === "k" ? (endgame ? 0.35 : 1.0) : 1.0;
      const pieceScore = base + Math.round(pst * pstScale);

      score += p.color === "w" ? pieceScore : -pieceScore;
      idx++;
    }
  }

  // Bishop pair
  if (whiteBishops >= 2) score += EVAL.bishopPairBonus;
  if (blackBishops >= 2) score -= EVAL.bishopPairBonus;

  // Pawn structure
  score += evaluatePawnStructure(chess);

  // King safety (less relevant in deep endgame, but still useful)
  score += endgame ? Math.round(evaluateKingSafety(chess) * 0.55) : evaluateKingSafety(chess);

  // Mobility: difference between sides.
  // We approximate by generating moves for current side, then for the other side by toggling with a null move (not supported),
  // so instead we compute only current-side mobility with smaller effect. Still helpful for move selection.
  const mobility = chess.moves().length;
  const mobilityBonus = mobility * (endgame ? EVAL.mobilityPerMoveEnd : EVAL.mobilityPerMoveMid);
  score += chess.turn() === "w" ? mobilityBonus : -mobilityBonus;

  return score;
}

function moveOrderScore(move) {
  // Higher is better for ordering.
  // We prioritize captures (MVV-LVA-ish), promotions, and checks.
  let s = 0;

  if (move.flags?.includes("p")) s += 400; // promotion
  if (move.flags?.includes("c") || move.flags?.includes("e")) {
    const captured = PIECE_VALUES[move.captured] ?? 0;
    const attacker = PIECE_VALUES[move.piece] ?? 0;
    s += 200 + captured - Math.round(attacker / 10);
  }
  if (move.san?.includes("+")) s += 60;
  if (move.san?.includes("#")) s += 10000;

  // Prefer castling a bit (king safety)
  if (move.flags?.includes("k") || move.flags?.includes("q")) s += 40;

  return s;
}

function orderedMoves(chess) {
  const moves = chess.moves({ verbose: true });
  // Shallow ordering is cheap and gives alpha-beta a big boost.
  moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));
  return moves;
}

function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  return Date.now();
}

function shouldStopByTime(ctx) {
  if (!ctx || !ctx.startTimeMs || !ctx.timeBudgetMs) return false;
  return nowMs() - ctx.startTimeMs >= ctx.timeBudgetMs;
}

/**
 * Alpha-beta minimax with a soft time cutoff.
 * Returns a score from White perspective.
 */
function alphabeta(chess, depth, alpha, beta, maximizingForWhite, ctx) {
  if (depth <= 0 || chess.isGameOver()) {
    return evaluatePosition(chess);
  }

  if (ctx?.timeBudgetMs && shouldStopByTime(ctx)) {
    // Soft cutoff: return static eval at current node.
    return evaluatePosition(chess);
  }

  const moves = orderedMoves(chess);
  if (moves.length === 0) return evaluatePosition(chess);

  if (maximizingForWhite) {
    let value = -INF;
    for (const m of moves) {
      chess.move(m);
      const child = alphabeta(chess, depth - 1, alpha, beta, false, ctx);
      chess.undo();

      value = Math.max(value, child);
      alpha = Math.max(alpha, value);
      if (alpha >= beta) break; // beta cut-off
    }
    return value;
  }

  // minimizing for white == maximizing for black
  let value = INF;
  for (const m of moves) {
    chess.move(m);
    const child = alphabeta(chess, depth - 1, alpha, beta, true, ctx);
    chess.undo();

    value = Math.min(value, child);
    beta = Math.min(beta, value);
    if (alpha >= beta) break; // alpha cut-off
  }
  return value;
}

/**
 * Difficulty presets.
 * - Depth: main strength knob.
 * - timeBudgetMs: keeps performance acceptable on slower devices.
 * - randomness: on easy, pick among top few moves sometimes to feel human/less tactical.
 */
const DIFFICULTY_PRESETS = {
  easy: { depth: 2, timeBudgetMs: 120, randomness: 0.35, topK: 3 },
  medium: { depth: 3, timeBudgetMs: 280, randomness: 0.1, topK: 2 },
  hard: { depth: 5, timeBudgetMs: 650, randomness: 0.0, topK: 1 }
};

// PUBLIC_INTERFACE
export function getDifficultyPreset(difficulty) {
  /** Return engine settings (depth/time/randomness) for the given UI difficulty key. */
  return DIFFICULTY_PRESETS[difficulty] ?? DIFFICULTY_PRESETS.medium;
}

/**
 * Choose a move from a list of scored candidates with optional randomness.
 */
function chooseFromTop({ candidates, maximizingForWhite, randomness = 0, topK = 1 }) {
  if (!candidates.length) return null;

  const sorted = [...candidates].sort((a, b) => (maximizingForWhite ? b.score - a.score : a.score - b.score));
  const k = Math.max(1, Math.min(topK, sorted.length));

  if (randomness <= 0 || k === 1) return sorted[0].move;

  // With probability `randomness`, pick randomly among top K; otherwise pick best.
  if (Math.random() >= randomness) return sorted[0].move;

  const choice = sorted[Math.floor(Math.random() * k)];
  return choice.move;
}

/**
 * PV helpers
 */

function moveToUci(move) {
  if (!move) return "";
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function pvToSan(moves) {
  if (!moves?.length) return [];
  return moves.map((m) => m.san).filter(Boolean);
}

function stableBudgetMs(timeBudgetMs, fallbackMs = 120) {
  if (typeof timeBudgetMs !== "number") return fallbackMs;
  if (!Number.isFinite(timeBudgetMs)) return fallbackMs;
  return Math.max(10, Math.floor(timeBudgetMs));
}

function bestLineSearch(chess, depth, maximizingForWhite, ctx) {
  /**
   * Returns the principal variation from the current position.
   *
   * Design:
   * - We reuse alphabeta as the evaluator, but additionally keep track of the best move at each node.
   * - This is still deterministic (given move ordering), and respects the same soft time budget.
   */
  if (depth <= 0 || chess.isGameOver()) {
    return { score: evaluatePosition(chess), pv: [] };
  }

  if (ctx?.timeBudgetMs && shouldStopByTime(ctx)) {
    return { score: evaluatePosition(chess), pv: [] };
  }

  const moves = orderedMoves(chess);
  if (!moves.length) return { score: evaluatePosition(chess), pv: [] };

  let bestScore = maximizingForWhite ? -INF : INF;
  let bestPv = [];
  let bestMove = null;

  for (const m of moves) {
    if (ctx?.timeBudgetMs && shouldStopByTime(ctx)) break;

    chess.move(m);

    // Evaluate remainder. For performance, we use alphabeta for the score at leaf,
    // and only compute PV via recursion along the chosen best branch.
    // This yields an actual PV without dramatically increasing work.
    const childScore = alphabeta(chess, depth - 1, -INF, INF, !maximizingForWhite, ctx);

    chess.undo();

    const isBetter = maximizingForWhite ? childScore > bestScore : childScore < bestScore;
    if (bestMove === null || isBetter) {
      bestScore = childScore;
      bestMove = m;
    }
  }

  if (!bestMove) return { score: evaluatePosition(chess), pv: [] };

  // Build PV by actually playing the best move and recursing.
  chess.move(bestMove);
  const child = bestLineSearch(chess, depth - 1, !maximizingForWhite, ctx);
  chess.undo();

  bestPv = [bestMove, ...child.pv];

  return { score: bestScore, pv: bestPv };
}

/**
 * Pick the best move for a given side by searching from the current position.
 *
 * @param {string} fen current position FEN
 * @param {"w"|"b"} aiColor which side the AI is playing
 * @param {number} depth search depth (plies)
 * @param {number=} timeBudgetMs optional time budget (ms)
 * @param {number=} randomness optional probability to randomize among top moves
 * @param {number=} topK how many top moves are eligible when randomizing
 * @returns {{ from: string, to: string, promotion?: string } | null}
 */
// PUBLIC_INTERFACE
export function findBestMove({ fen, aiColor, depth, timeBudgetMs, randomness, topK }) {
  /** Compute AI move using minimax + alpha-beta pruning for given side and depth (and optional time budget). */
  const chess = new Chess();
  chess.load(fen);

  if (chess.isGameOver()) return null;
  if (chess.turn() !== aiColor) return null;

  const moves = orderedMoves(chess);
  if (moves.length === 0) return null;

  // If AI is white, we maximize; if AI is black, we minimize (because evaluation is from white perspective).
  const maximizingForWhite = aiColor === "w";

  const ctx = {
    startTimeMs: nowMs(),
    timeBudgetMs: typeof timeBudgetMs === "number" ? Math.max(10, timeBudgetMs) : null
  };

  const candidates = [];

  // Small safeguard: if UI passes depth < 1
  const searchDepth = Math.max(1, Math.floor(depth));

  for (const m of moves) {
    // Respect time budget across root moves too.
    if (ctx.timeBudgetMs && shouldStopByTime(ctx)) break;

    chess.move(m);
    const score = alphabeta(chess, searchDepth - 1, -INF, INF, !maximizingForWhite, ctx);
    chess.undo();

    candidates.push({ move: m, score });
  }

  const chosen = chooseFromTop({
    candidates,
    maximizingForWhite,
    randomness: typeof randomness === "number" ? Math.max(0, Math.min(1, randomness)) : 0,
    topK: typeof topK === "number" ? topK : 1
  });

  if (!chosen) return null;

  // chess.js verbose moves include promotion field when applicable
  const out = { from: chosen.from, to: chosen.to };
  if (chosen.promotion) out.promotion = chosen.promotion;
  return out;
}

/**
 * A PV-enabled best line query for analysis UI.
 *
 * @param {string} fen current position FEN
 * @param {number} depth search depth (plies)
 * @param {number=} timeBudgetMs optional time budget (ms)
 * @param {number=} maxPvPlies cap PV length to keep UI compact (defaults to depth)
 * @returns {{ evalCp: number|null, pvUci: string[], pvSan: string[], nodes?: number, stoppedByTime?: boolean }}
 */
// PUBLIC_INTERFACE
export function getPrincipalVariation({ fen, depth, timeBudgetMs, maxPvPlies }) {
  /** Compute a principal variation (best line) plus evaluation from the given FEN. */
  const chess = new Chess();
  chess.load(fen);

  if (chess.isGameOver()) {
    return { evalCp: evaluatePosition(chess), pvUci: [], pvSan: [], stoppedByTime: false };
  }

  const searchDepth = Math.max(1, Math.floor(depth));
  const budget = stableBudgetMs(timeBudgetMs, 140);

  // We want a PV for the side to move; "maximizingForWhite" refers to the eval convention.
  const maximizingForWhite = chess.turn() === "w";

  const ctx = {
    startTimeMs: nowMs(),
    timeBudgetMs: budget
  };

  const res = bestLineSearch(chess, searchDepth, maximizingForWhite, ctx);

  const cap = typeof maxPvPlies === "number" ? Math.max(0, Math.floor(maxPvPlies)) : searchDepth;
  const pvMoves = (res.pv ?? []).slice(0, cap);

  return {
    evalCp: Number.isFinite(res.score) ? res.score : null,
    pvUci: pvMoves.map(moveToUci).filter(Boolean),
    pvSan: pvToSan(pvMoves),
    stoppedByTime: Boolean(ctx.timeBudgetMs && shouldStopByTime(ctx))
  };
}

/**
 * Helper to map a difficulty label to a depth.
 * Depth meaning: number of plies (half-moves) searched.
 */
// PUBLIC_INTERFACE
export function difficultyToDepth(difficulty) {
  /** Map UI difficulty value to minimax depth (for legacy callers). */
  return getDifficultyPreset(difficulty).depth;
}

/**
 * Helper to map a difficulty label to a time budget.
 */
// PUBLIC_INTERFACE
export function difficultyToTimeBudgetMs(difficulty) {
  /** Map UI difficulty value to a soft compute time budget (ms). */
  return getDifficultyPreset(difficulty).timeBudgetMs;
}

/**
 * Helper to map a difficulty label to a low-depth randomization amount.
 */
// PUBLIC_INTERFACE
export function difficultyToRandomness(difficulty) {
  /** Map UI difficulty value to randomness probability when choosing among top moves. */
  return getDifficultyPreset(difficulty).randomness;
}

/**
 * Public evaluator entrypoint for analysis mode.
 *
 * NOTE:
 * - This intentionally reuses the engine's internal evaluation (material + PST + structure + safety).
 * - The score is from White perspective in centipawns: positive = White better.
 */

// PUBLIC_INTERFACE
export function evaluateFen({ fen }) {
  /** Evaluate a FEN position and return a centipawn score from White perspective. */
  const chess = new Chess();
  chess.load(fen);

  // If position is terminal, evaluation handles checkmate/draw cases.
  return evaluatePosition(chess);
}
