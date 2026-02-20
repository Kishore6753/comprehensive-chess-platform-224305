import React from "react";
import { pieceToUnicode } from "../utils/chessUi";

const PROMO_TYPES = ["q", "r", "b", "n"];

// PUBLIC_INTERFACE
export function PromotionModal({ color, onSelect }) {
  /** Modal to select a promotion piece type (q/r/b/n). */
  return (
    <div className="promoOverlay" role="dialog" aria-modal="true" aria-label="Choose promotion piece">
      <div className="panel promoModal">
        <p className="promoTitle">Pawn Promotion</p>
        <div className="promoGrid">
          {PROMO_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="promoBtn"
              onClick={() => onSelect(type)}
              aria-label={`Promote to ${type}`}
            >
              <span className="promoPiece">{pieceToUnicode({ color, type })}</span>
            </button>
          ))}
        </div>
        <div className="smallHelp">
          Select the piece to promote to. (Queen, Rook, Bishop, Knight)
        </div>
      </div>
    </div>
  );
}
