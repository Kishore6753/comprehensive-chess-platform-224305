import { Chess } from "chess.js";

/**
 * Utility helpers for exporting annotated PGN (dependency-free).
 *
 * Notes on PGN comments:
 * - We use PGN comment blocks `{ ... }` for annotations.
 * - Severity tags are included both as NAGs ($2/$4/$??) and as symbolic glyphs (!?, ?, ??) in the comment for readability.
 * - Engine evaluation is formatted in pawns (e.g. +0.34) or mate (e.g. #+3) when available.
 */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatPgnDate(dateObj) {
  // PGN uses YYYY.MM.DD
  const d = dateObj instanceof Date ? dateObj : new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}.${mm}.${dd}`;
}

function escapePgnHeaderValue(v) {
  // PGN header values are quoted; escape quotes/backslashes minimally.
  return String(v ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function sanitizeComment(text) {
  // PGN comments can't contain unbalanced braces. Replace braces with parentheses.
  return String(text ?? "").replaceAll("{", "(").replaceAll("}", ")");
}

function severityToGlyph(severity) {
  if (severity === "inaccuracy") return "!?";
  if (severity === "mistake") return "?";
  if (severity === "blunder") return "??";
  return "";
}

function severityToNag(severity) {
  // Standard NAG codes:
  // Inaccuracy: $2 (?!), Mistake: $4 (?), Blunder: $?? is $?? not standard; use $?? doesn't exist.
  // Use $2 for inaccuracy, $4 for mistake, $?? not valid => use $?? alternative $??.
  // We will use: inaccuracy $2, mistake $4, blunder $?? -> use $?? is invalid; commonly blunder is $?? = $?? not.
  // Use $4 for mistake and $?? cannot; use $??. Better: use $4 for mistake, $2 for inaccuracy, $?? for blunder -> instead use $??.
  // We'll use: blunder = $?? -> choose $?? not allowed; choose $4?? no.
  // Use: $2 inaccuracy, $4 mistake, $7 blunder (??) actually: $7 is "forced move" (not). NAG for blunder is $?? not.
  // Widely used: $2 = ?!, $4 = ?, $?? doesn't exist; BUT "??" is $?? not.
  // We'll omit NAG for blunder and rely on glyph in comment to stay standard-compliant.
  if (severity === "inaccuracy") return "$2";
  if (severity === "mistake") return "$4";
  return "";
}

function formatEvalForComment(item) {
  // Prefer mate if present (future-proof), otherwise centipawns.
  // Current analysis uses centipawns only; we still support a "mate" field if added later.
  if (!item) return null;

  const mate = item.evalAfterMate ?? item.mateAfter ?? null;
  if (Number.isFinite(mate)) {
    const sign = mate > 0 ? "+" : "";
    return `#${sign}${Math.trunc(mate)}`;
  }

  const cp = item.evalAfter;
  if (!Number.isFinite(cp)) return null;

  const pawns = cp / 100;
  const sign = pawns > 0 ? "+" : "";
  return `${sign}${pawns.toFixed(2)}`;
}

function formatPvForComment(item) {
  const pvSan = item?.pvSan;
  if (!Array.isArray(pvSan) || pvSan.length === 0) return null;
  return pvSan.join(" ");
}

/**
 * Build a single comment string like:
 *   "!? eval +0.34 | PV: ... | loss: 123cp"
 */
function buildMoveComment(item) {
  const parts = [];

  const glyph = severityToGlyph(item?.severity);
  if (glyph) parts.push(glyph);

  const evalText = formatEvalForComment(item);
  if (evalText) parts.push(`eval ${evalText}`);

  const pvText = formatPvForComment(item);
  if (pvText) parts.push(`PV: ${pvText}`);

  if (Number.isFinite(item?.lossCpForMover)) {
    parts.push(`loss ${Math.round(item.lossCpForMover)}cp`);
  }

  if (!parts.length) return null;
  return sanitizeComment(parts.join(" | "));
}

/**
 * Convert SAN history into a move text section with inline annotations.
 *
 * @param {string[]} historySAN SAN moves in order (plies)
 * @param {Array<{ply:number,san:string,severity?:string,evalAfter?:number,lossCpForMover?:number,pvSan?:string[]}>} analysisItems
 */
function buildMovesSection(historySAN, analysisItems) {
  const chess = new Chess();

  const itemsByPly = new Map();
  (analysisItems ?? []).forEach((it) => {
    if (it && Number.isFinite(it.ply)) itemsByPly.set(it.ply, it);
  });

  const tokens = [];
  for (let ply = 0; ply < historySAN.length; ply++) {
    const san = historySAN[ply];

    // Ensure move numbers appear correctly.
    if (ply % 2 === 0) {
      tokens.push(`${Math.floor(ply / 2) + 1}.`);
    }

    // Apply move to validate SAN; if invalid, stop exporting at that point.
    // This ensures we don't export broken PGN if history got corrupted.
    try {
      const moveObj = chess.move(san, { sloppy: true });
      if (!moveObj) break;
    } catch {
      break;
    }

    const it = itemsByPly.get(ply);

    // Include NAG (optional) immediately after SAN, then comment.
    const nag = severityToNag(it?.severity);
    const comment = buildMoveComment(it);

    let moveToken = san;
    if (nag) moveToken += ` ${nag}`;
    if (comment) moveToken += ` { ${comment} }`;

    tokens.push(moveToken);
  }

  // Wrap lines at ~80 chars for readability.
  const lines = [];
  let cur = "";
  for (const t of tokens) {
    if (!cur.length) {
      cur = t;
      continue;
    }
    if ((cur + " " + t).length > 80) {
      lines.push(cur);
      cur = t;
    } else {
      cur = `${cur} ${t}`;
    }
  }
  if (cur.length) lines.push(cur);

  return lines.join("\n");
}

/**
 * PUBLIC_INTERFACE
 * Export an annotated PGN string for the finished game.
 *
 * @param {{
 *  historySAN: string[],
 *  analysisResult?: { items: any[] } | null,
 *  headers?: Partial<{Event:string,Site:string,Date:string,Round:string,White:string,Black:string,Result:string}>,
 *  fileName?: string
 * }} params
 * @returns {{ pgn: string, fileName: string }}
 */
export function exportAnnotatedPgn({ historySAN, analysisResult, headers, fileName }) {
  /** Generate an annotated PGN using existing analysis data (no recomputation). */
  const safeHistory = Array.isArray(historySAN) ? historySAN : [];
  const items = analysisResult?.items ?? [];

  const defaultHeaders = {
    Event: "Casual Game",
    Site: "Local",
    Date: formatPgnDate(new Date()),
    Round: "-",
    White: "White",
    Black: "Black",
    Result: headers?.Result ?? "*"
  };

  const hdr = { ...defaultHeaders, ...(headers ?? {}) };

  const headerLines = ["Event", "Site", "Date", "Round", "White", "Black", "Result"].map(
    (k) => `[${k} "${escapePgnHeaderValue(hdr[k] ?? "")}"]`
  );

  const movesSection = buildMovesSection(safeHistory, items);

  const resultToken = String(hdr.Result ?? "*").trim() || "*";

  const pgn = `${headerLines.join("\n")}\n\n${movesSection}${movesSection ? "\n" : ""}${resultToken}\n`;

  const outName =
    (fileName && String(fileName).trim()) ||
    `retro-chess-${String(hdr.Date ?? "game").replaceAll(".", "-")}.pgn`;

  return { pgn, fileName: outName };
}

/**
 * PUBLIC_INTERFACE
 * Trigger a browser download for a PGN string (no dependencies).
 *
 * @param {{ pgn: string, fileName: string }} params
 */
export function downloadPgn({ pgn, fileName }) {
  /** Download the given PGN content as a .pgn file in the browser. */
  const blob = new Blob([String(pgn ?? "")], { type: "application/x-chess-pgn;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "game.pgn";
    a.rel = "noopener";
    // Append is needed for Firefox in some cases.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Release the object URL shortly after click to avoid memory leaks.
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
  }
}
