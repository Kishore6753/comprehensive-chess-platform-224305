import React, { useMemo } from "react";
import { files, isLightSquare, pieceToUnicode, ranks, squareAt } from "../utils/chessUi";

/**
 * Pure rendering component: emits square clicks to parent.
 */

// PUBLIC_INTERFACE
export function ChessBoard({
  board,
  selectedSquare,
  legalMoves,
  inCheckSquare,
  onSquareClick
}) {
  /** Render chessboard, pieces, and move highlights. */
  const legalMoveTargets = useMemo(() => {
    const map = new Map();
    for (const m of legalMoves) map.set(m.to, m);
    return map;
  }, [legalMoves]);

  const ranksArr = ranks();
  const filesArr = files();

  return (
    <div>
      <div className="boardWrap" aria-label="Chess board">
        <div className="ranksCol" aria-hidden="true">
          {ranksArr.map((r) => (
            <div key={r}>{r}</div>
          ))}
        </div>

        <div
          className="board"
          role="grid"
          aria-label="Chessboard squares"
        >
          {ranksArr.map((rank, rankIndex) =>
            filesArr.map((file, fileIndex) => {
              const square = squareAt(file, rank);
              const piece = board?.[rankIndex]?.[fileIndex] ?? null;

              const isLight = isLightSquare(fileIndex, rankIndex);
              const isSelected = selectedSquare === square;
              const isCheck = inCheckSquare === square;

              const targetMove = legalMoveTargets.get(square);
              const isCapture = Boolean(targetMove && (targetMove.flags?.includes("c") || targetMove.flags?.includes("e")));

              const squareClass = [
                "square",
                isLight ? "squareLight" : "squareDark",
                isSelected ? "squareSelected" : "",
                isCheck ? "squareCheck" : "",
                targetMove ? (isCapture ? "squareCaptureHint" : "squareMoveHint") : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={square}
                  type="button"
                  className={squareClass}
                  onClick={() => onSquareClick(square)}
                  aria-label={`Square ${square}${piece ? `, ${piece.color}${piece.type}` : ""}`}
                >
                  <span className="piece pieceGrab" aria-hidden="true">
                    {pieceToUnicode(piece)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="filesCol" aria-hidden="true">
        {filesArr.map((f) => (
          <div key={f}>{f}</div>
        ))}
      </div>
    </div>
  );
}
