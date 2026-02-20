import React, { useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { evaluateFen, getPrincipalVariation } from "../utils/minimaxAi";

/**
 * Post-game analysis design:
 * - Reconstruct the game from SAN history using a fresh Chess() instance.
 * - For each ply:
 *    evalBefore = evaluation of position before the move (white perspective)
 *    apply move
 *    evalAfter = evaluation of position after the move
 *    lossCpForMover = how much worse the mover made their own situation
 * - Tag severities based on centipawn loss:
 *    Inaccuracy: >= 50
 *    Mistake:    >= 120
 *    Blunder:    >= 300
 *
 * PV (principal variation) enhancement:
 * - For each analyzed move, also compute engine PV from the position AFTER the move.
 * - This provides a "best line" to show what the engine expects next.
 *
 * Performance:
 * - PV search is capped (depth/time budget) and done synchronously, but we yield to the UI
 *   before running analysis to avoid blocking initial paint.
 */

const THRESHOLDS = {
  inaccuracy: 50,
  mistake: 120,
  blunder: 300
};

// Keep PV lightweight; this is per-move, so it needs to be small.
const PV_SETTINGS = {
  depth: 3,
  timeBudgetMs: 90,
  maxPvPlies: 6
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatCp(cp) {
  if (!Number.isFinite(cp)) return "—";
  const sign = cp > 0 ? "+" : "";
  // Show as pawns with 2 decimals.
  return `${sign}${(cp / 100).toFixed(2)}`;
}

function severityForLoss(lossCp) {
  if (!Number.isFinite(lossCp)) return null;
  if (lossCp >= THRESHOLDS.blunder) return "blunder";
  if (lossCp >= THRESHOLDS.mistake) return "mistake";
  if (lossCp >= THRESHOLDS.inaccuracy) return "inaccuracy";
  return null;
}

function severityLabel(sev) {
  if (sev === "blunder") return "Blunder";
  if (sev === "mistake") return "Mistake";
  if (sev === "inaccuracy") return "Inaccuracy";
  return "";
}

function sevClass(sev) {
  if (sev === "blunder") return "analysisTag analysisTagBlunder";
  if (sev === "mistake") return "analysisTag analysisTagMistake";
  if (sev === "inaccuracy") return "analysisTag analysisTagInaccuracy";
  return "analysisTag";
}

function safeEvaluateFen(fen) {
  try {
    return evaluateFen({ fen });
  } catch {
    return null;
  }
}

function safeGetPv(fen) {
  try {
    const pv = getPrincipalVariation({
      fen,
      depth: PV_SETTINGS.depth,
      timeBudgetMs: PV_SETTINGS.timeBudgetMs,
      maxPvPlies: PV_SETTINGS.maxPvPlies
    });

    return {
      pvSan: pv?.pvSan ?? [],
      pvUci: pv?.pvUci ?? [],
      pvEvalCp: pv?.evalCp ?? null,
      pvStoppedByTime: Boolean(pv?.stoppedByTime)
    };
  } catch {
    return { pvSan: [], pvUci: [], pvEvalCp: null, pvStoppedByTime: false };
  }
}

function formatPvLine(pvSan) {
  if (!pvSan || pvSan.length === 0) return "—";
  return pvSan.join(" ");
}

function computeAnalysis(historySAN) {
  const chess = new Chess();
  const items = [];

  let prevEval = safeEvaluateFen(chess.fen());

  for (let ply = 0; ply < historySAN.length; ply++) {
    const san = historySAN[ply];

    const mover = chess.turn(); // side to move before applying move
    const fenBefore = chess.fen();
    const evalBefore = prevEval;

    // Apply SAN. chess.js can throw if the history contains something unexpected.
    let moveObj = null;
    try {
      moveObj = chess.move(san, { sloppy: true });
    } catch {
      // If we can't parse, stop analysis at this point.
      break;
    }

    if (!moveObj) break;

    const fenAfter = chess.fen();
    const evalAfter = safeEvaluateFen(fenAfter);

    // PV from position AFTER the move (engine best continuation).
    const pv = safeGetPv(fenAfter);

    // From White perspective, "good for White" is positive.
    // For mover, a worse result means:
    // - White moved: evaluation went DOWN (White advantage decreased)
    // - Black moved: evaluation went UP (White advantage increased => Black worse)
    const delta = Number.isFinite(evalBefore) && Number.isFinite(evalAfter) ? evalAfter - evalBefore : null;

    let lossCpForMover = null;
    if (Number.isFinite(delta)) {
      lossCpForMover = mover === "w" ? Math.max(0, -delta) : Math.max(0, delta);
    }

    const severity = severityForLoss(lossCpForMover);

    items.push({
      ply,
      mover, // "w" | "b"
      san,
      uci: { from: moveObj.from, to: moveObj.to, promotion: moveObj.promotion || undefined },
      fenBefore,
      fenAfter,
      evalBefore,
      evalAfter,
      delta,
      lossCpForMover,
      severity,

      // PV fields (from fenAfter)
      pvSan: pv.pvSan,
      pvUci: pv.pvUci,
      pvEvalCp: pv.pvEvalCp,
      pvStoppedByTime: pv.pvStoppedByTime
    });

    prevEval = evalAfter;
  }

  const counts = items.reduce(
    (acc, it) => {
      if (it.severity === "blunder") acc.blunder += 1;
      if (it.severity === "mistake") acc.mistake += 1;
      if (it.severity === "inaccuracy") acc.inaccuracy += 1;
      return acc;
    },
    { blunder: 0, mistake: 0, inaccuracy: 0 }
  );

  return { items, counts, analyzedPlies: items.length, totalPlies: historySAN.length };
}

// PUBLIC_INTERFACE
export function PostGameAnalysis({ historySAN, onNavigateFen }) {
  /** Post-game analysis UI: evaluates each move, tags severity, and lets user navigate through analyzed plies. */
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [selectedPly, setSelectedPly] = useState(null);

  const lastNavFenRef = useRef(null);

  const canAnalyze = historySAN && historySAN.length > 0;

  useEffect(() => {
    // If game changes (new game), clear analysis state.
    setRunning(false);
    setResult(null);
    setSelectedPly(null);
    lastNavFenRef.current = null;
  }, [historySAN]);

  const selectedItem = useMemo(() => {
    if (!result) return null;
    if (selectedPly == null) return null;
    return result.items.find((x) => x.ply === selectedPly) ?? null;
  }, [result, selectedPly]);

  const navToFen = (fen) => {
    if (!fen) return;
    if (lastNavFenRef.current === fen) return;
    lastNavFenRef.current = fen;
    if (typeof onNavigateFen === "function") onNavigateFen(fen);
  };

  const onRun = async () => {
    if (!canAnalyze) return;
    if (running) return;

    setRunning(true);

    try {
      // Let UI paint before doing synchronous work.
      await new Promise((r) => window.setTimeout(r, 0));

      const computed = computeAnalysis(historySAN);

      setResult(computed);

      // Default selection: first tagged issue, else last ply.
      const firstIssue = computed.items.find((x) => x.severity);
      const defaultPly = firstIssue ? firstIssue.ply : computed.items.length ? computed.items[computed.items.length - 1].ply : null;

      setSelectedPly(defaultPly);

      if (defaultPly != null) {
        const it = computed.items.find((x) => x.ply === defaultPly);
        navToFen(it?.fenAfter);
      }
    } finally {
      setRunning(false);
    }
  };

  const onClear = () => {
    setResult(null);
    setSelectedPly(null);
  };

  const moveNo = (ply) => Math.floor(ply / 2) + 1;

  const moveLabel = (it) => {
    if (!it) return "";
    const prefix = it.mover === "w" ? `${moveNo(it.ply)}.` : `${moveNo(it.ply)}…`;
    return `${prefix} ${it.san}`;
  };

  const onPrev = () => {
    if (!result || selectedPly == null) return;
    const next = clamp(selectedPly - 1, 0, result.items.length - 1);
    const it = result.items[next];
    setSelectedPly(it.ply);
    navToFen(it.fenAfter);
  };

  const onNext = () => {
    if (!result || selectedPly == null) return;
    const next = clamp(selectedPly + 1, 0, result.items.length - 1);
    const it = result.items[next];
    setSelectedPly(it.ply);
    navToFen(it.fenAfter);
  };

  return (
    <div className="analysisPanel" aria-label="Post-game analysis">
      <div className="analysisHeader">
        <div>
          <h3 className="analysisTitle">Post-game analysis</h3>
          <div className="analysisSubtitle">
            Engine-assisted review (local): tags inaccuracies/mistakes/blunders by centipawn loss. Includes PV best lines.
          </div>
        </div>

        <div className="analysisHeaderActions">
          <button type="button" className="btn btnPrimary" onClick={onRun} disabled={!canAnalyze || running}>
            {running ? "Analyzing…" : result ? "Re-run" : "Analyze game"}
          </button>
          <button type="button" className="btn" onClick={onClear} disabled={!result || running}>
            Clear
          </button>
        </div>
      </div>

      {result ? (
        <>
          <div className="analysisSummary" aria-label="Analysis summary">
            <div className="analysisSummaryRow">
              <span className="analysisSummaryKey">Moves analyzed</span>
              <span className="analysisSummaryVal">
                {result.analyzedPlies} / {result.totalPlies}
              </span>
            </div>
            <div className="analysisSummaryRow">
              <span className="analysisSummaryKey">Inaccuracies</span>
              <span className="analysisSummaryVal">{result.counts.inaccuracy}</span>
            </div>
            <div className="analysisSummaryRow">
              <span className="analysisSummaryKey">Mistakes</span>
              <span className="analysisSummaryVal">{result.counts.mistake}</span>
            </div>
            <div className="analysisSummaryRow">
              <span className="analysisSummaryKey">Blunders</span>
              <span className="analysisSummaryVal">{result.counts.blunder}</span>
            </div>
          </div>

          <div className="analysisNav" aria-label="Analysis navigation">
            <button type="button" className="btn" onClick={onPrev} disabled={running || selectedPly == null || selectedPly <= 0}>
              ◀ Prev
            </button>
            <div className="analysisNavCenter" aria-live="polite">
              {selectedItem ? (
                <>
                  <span className="analysisNavMove">{moveLabel(selectedItem)}</span>
                  {selectedItem.severity ? (
                    <span className={sevClass(selectedItem.severity)}>{severityLabel(selectedItem.severity)}</span>
                  ) : (
                    <span className="analysisTag analysisTagOk">OK</span>
                  )}
                </>
              ) : (
                <span className="analysisNavMove">Select a move</span>
              )}
            </div>
            <button
              type="button"
              className="btn"
              onClick={onNext}
              disabled={
                running || selectedPly == null || !result.items.length || selectedPly >= result.items[result.items.length - 1].ply
              }
            >
              Next ▶
            </button>
          </div>

          {selectedItem ? (
            <div className="analysisDetails" aria-label="Selected move details">
              <div className="analysisDetailGrid">
                <div className="analysisDetailCard">
                  <div className="analysisDetailLabel">Eval before</div>
                  <div className="analysisDetailValue">{formatCp(selectedItem.evalBefore)}</div>
                </div>
                <div className="analysisDetailCard">
                  <div className="analysisDetailLabel">Eval after</div>
                  <div className="analysisDetailValue">{formatCp(selectedItem.evalAfter)}</div>
                </div>
                <div className="analysisDetailCard">
                  <div className="analysisDetailLabel">Δ (after - before)</div>
                  <div className="analysisDetailValue">{formatCp(selectedItem.delta)}</div>
                </div>
                <div className="analysisDetailCard">
                  <div className="analysisDetailLabel">Loss (mover)</div>
                  <div className="analysisDetailValue">
                    {Number.isFinite(selectedItem.lossCpForMover) ? `${Math.round(selectedItem.lossCpForMover)} cp` : "—"}
                  </div>
                </div>
              </div>

              <div className="analysisPvCard" aria-label="Principal variation">
                <div className="analysisDetailLabel">Best line (PV)</div>
                <div className="analysisPvValue" title={formatPvLine(selectedItem.pvSan)}>
                  {formatPvLine(selectedItem.pvSan)}
                  {selectedItem.pvStoppedByTime ? <span className="analysisPvHint"> (time-capped)</span> : null}
                </div>
                {Number.isFinite(selectedItem.pvEvalCp) ? (
                  <div className="analysisPvMeta">PV eval: {formatCp(selectedItem.pvEvalCp)}</div>
                ) : null}
              </div>

              <div className="analysisDetailActions">
                <button type="button" className="btn" onClick={() => navToFen(selectedItem.fenBefore)} disabled={running}>
                  Show position before
                </button>
                <button type="button" className="btn btnPrimary" onClick={() => navToFen(selectedItem.fenAfter)} disabled={running}>
                  Show position after
                </button>
              </div>

              <div className="analysisSmallHelp">
                Thresholds: Inaccuracy ≥ {THRESHOLDS.inaccuracy}cp • Mistake ≥ {THRESHOLDS.mistake}cp • Blunder ≥{" "}
                {THRESHOLDS.blunder}cp
                <br />
                PV search: depth {PV_SETTINGS.depth} • time budget {PV_SETTINGS.timeBudgetMs}ms (per move)
              </div>
            </div>
          ) : null}

          <div className="analysisMoveList" role="list" aria-label="Analysis move list">
            {result.items.map((it) => (
              <button
                key={it.ply}
                type="button"
                className={[
                  "analysisMoveRow",
                  selectedPly === it.ply ? "analysisMoveRowSelected" : "",
                  it.severity ? "analysisMoveRowFlagged" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setSelectedPly(it.ply);
                  navToFen(it.fenAfter);
                }}
                aria-label={`Move ${moveLabel(it)}. Best line: ${formatPvLine(it.pvSan)}`}
              >
                <span className="analysisMoveNo">{it.mover === "w" ? `${moveNo(it.ply)}.` : ""}</span>
                <span className="analysisMoveSan">
                  <span className="analysisMoveSanPrimary">{it.san}</span>
                  <span className="analysisMovePv">{formatPvLine(it.pvSan)}</span>
                </span>
                <span className="analysisMoveEval">{formatCp(it.evalAfter)}</span>
                <span className={sevClass(it.severity)}>{it.severity ? severityLabel(it.severity) : "OK"}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="analysisEmpty">
          {canAnalyze ? "Run analysis after the game ends to get a move-by-move report." : "Play some moves to enable analysis."}
        </div>
      )}
    </div>
  );
}
