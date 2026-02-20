import React, { useMemo } from "react";

// PUBLIC_INTERFACE
export function MoveHistory({ history }) {
  /** Display move history in SAN, grouped by full moves (1. e4 e5). */
  const rows = useMemo(() => {
    const out = [];
    for (let i = 0; i < history.length; i += 2) {
      out.push({
        moveNo: i / 2 + 1,
        white: history[i] ?? "",
        black: history[i + 1] ?? ""
      });
    }
    return out;
  }, [history]);

  return (
    <div>
      <h3 className="moveListTitle">Move History</h3>
      <div className="moveList" role="log" aria-label="Move history">
        {rows.length === 0 ? (
          <div className="moveRow">
            <div className="moveNo">—</div>
            <div className="moveCell">No moves yet</div>
            <div className="moveCell" />
          </div>
        ) : (
          rows.map((r) => (
            <div className="moveRow" key={r.moveNo}>
              <div className="moveNo">{r.moveNo}.</div>
              <div className="moveCell">{r.white}</div>
              <div className="moveCell">{r.black}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
