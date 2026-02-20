/**
 * UI helpers for mapping chess.js board state to UI rendering concerns.
 */

const PIECE_TO_UNICODE = {
  w: { p: "♙", r: "♖", n: "♘", b: "♗", q: "♕", k: "♔" },
  b: { p: "♟", r: "♜", n: "♞", b: "♝", q: "♛", k: "♚" }
};

// PUBLIC_INTERFACE
export function pieceToUnicode(piece) {
  /** Convert a chess.js piece ({type,color}) to a unicode symbol string. */
  if (!piece) return "";
  return PIECE_TO_UNICODE[piece.color]?.[piece.type] ?? "";
}

// PUBLIC_INTERFACE
export function files() {
  /** Files (a-h) left-to-right. */
  return ["a", "b", "c", "d", "e", "f", "g", "h"];
}

// PUBLIC_INTERFACE
export function ranks() {
  /** Ranks (8-1) top-to-bottom for standard white-at-bottom view. */
  return [8, 7, 6, 5, 4, 3, 2, 1];
}

// PUBLIC_INTERFACE
export function squareAt(file, rank) {
  /** Build algebraic square string like "e4". */
  return `${file}${rank}`;
}

// PUBLIC_INTERFACE
export function isLightSquare(fileIndex, rankIndex) {
  /** Determine if a square should be light, given 0-based file index and rank index in UI rows. */
  return (fileIndex + rankIndex) % 2 === 0;
}
