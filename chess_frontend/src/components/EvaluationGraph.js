import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * Canvas-based evaluation-over-time graph (centipawns from White perspective).
 *
 * Goals:
 * - Lightweight: no deps, simple drawing.
 * - Performant: requestAnimationFrame drawing + O(n) render; ok for long games.
 * - Interactive:
 *    - hover -> preview ply
 *    - click -> select/navigate ply
 * - Theme-aware: reads CSS variables from :root at draw time.
 */

/**
 * Clamp helper.
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Extract a number from CSS string (e.g. "12px").
 */
function pxNumber(s, fallback = 0) {
  const n = Number.parseFloat(String(s ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Convert CSS variable color to an rgba string with given alpha.
 * Supports: rgb(), rgba(), hex (#rrggbb / #rgb).
 */
function toRgba(color, alpha) {
  const c = String(color ?? "").trim();

  if (c.startsWith("rgba(")) {
    // Replace alpha component naively.
    const parts = c
      .slice(5, -1)
      .split(",")
      .map((x) => x.trim());
    if (parts.length === 4) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    if (parts.length === 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }

  if (c.startsWith("rgb(")) {
    const parts = c
      .slice(4, -1)
      .split(",")
      .map((x) => x.trim());
    if (parts.length === 3) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  }

  // Hex support
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    if (hex.length === 6) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  // Fallback: if it's something else (named color), just return it (alpha won't apply).
  return c;
}

/**
 * Decide y-range for plotting. We clamp extreme evaluations (mates etc.) to keep graph readable.
 */
function computeYRange(values, clampAbsCp = 900) {
  let minV = 0;
  let maxV = 0;

  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const vv = clamp(v, -clampAbsCp, clampAbsCp);
    minV = Math.min(minV, vv);
    maxV = Math.max(maxV, vv);
  }

  // Ensure range isn't 0 so scaling works.
  if (minV === maxV) {
    minV -= 50;
    maxV += 50;
  }

  // Add headroom.
  const span = maxV - minV;
  const pad = Math.max(40, span * 0.08);
  return { min: minV - pad, max: maxV + pad, clampAbsCp };
}

/**
 * Map ply index to x coordinate.
 */
function xForIndex(i, n, plotLeft, plotWidth) {
  if (n <= 1) return plotLeft;
  const t = i / (n - 1);
  return plotLeft + t * plotWidth;
}

/**
 * Map evaluation to y coordinate (canvas y-down).
 */
function yForValue(v, yrange, plotTop, plotHeight) {
  const vv = clamp(v, -yrange.clampAbsCp, yrange.clampAbsCp);
  const t = (vv - yrange.min) / (yrange.max - yrange.min);
  return plotTop + (1 - t) * plotHeight;
}

/**
 * Draw rounded rect (small helper for nicer hover pill background).
 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * PUBLIC_INTERFACE
 */
export function EvaluationGraph({
  evalCpByPly,
  selectedPly,
  onHoverPly,
  onSelectPly,
  height = 140
}) {
  /** Render an evaluation-over-time graph and emit hover/click ply events. */
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

  const rafRef = useRef(0);

  // Track pixel size of the container so canvas can be responsive.
  const [size, setSize] = useState({ width: 0, height });

  // Local hover state to drive tooltip/highlight even if parent doesn't store hover.
  const [localHover, setLocalHover] = useState(null);

  const values = useMemo(() => {
    const arr = Array.isArray(evalCpByPly) ? evalCpByPly : [];
    return arr.map((x) => (Number.isFinite(x) ? x : null));
  }, [evalCpByPly]);

  const yrange = useMemo(() => computeYRange(values.filter((v) => Number.isFinite(v))), [values]);

  // Resize observer for responsive layout.
  useLayoutEffect(() => {
    if (!wrapRef.current) return undefined;
    const el = wrapRef.current;

    const ro = new ResizeObserver((entries) => {
      const rect = entries?.[0]?.contentRect;
      if (!rect) return;
      setSize({ width: Math.max(0, Math.floor(rect.width)), height });
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

  // Draw (rAF scheduled to keep main thread responsive and avoid repeated sync paint).
  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const canvas = canvasRef.current;

    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const css = window.getComputedStyle(document.documentElement);
        const cText = css.getPropertyValue("--text").trim() || "#eaf0ff";
        const cMuted = css.getPropertyValue("--muted").trim() || "rgba(234, 240, 255, 0.7)";
        const cBorder = css.getPropertyValue("--border").trim() || "rgba(255, 255, 255, 0.14)";
        const cAccent = css.getPropertyValue("--accent").trim() || "#3b82f6";
        const cSuccess = css.getPropertyValue("--success").trim() || "#10b981";
        const cPanel = css.getPropertyValue("--panel").trim() || "#111a33";

        const w = Math.max(0, size.width);
        const h = Math.max(0, size.height);
        if (!w || !h) return;

        // HiDPI scaling.
        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.clearRect(0, 0, w, h);

        // Layout
        const padL = 44;
        const padR = 14;
        const padT = 10;
        const padB = 24;

        const plotLeft = padL;
        const plotTop = padT;
        const plotWidth = Math.max(1, w - padL - padR);
        const plotHeight = Math.max(1, h - padT - padB);

        // Background (subtle, fits analysis panel)
        ctx.fillStyle = toRgba(cPanel, 0.08) || "rgba(255,255,255,0.03)";
        ctx.strokeStyle = toRgba(cBorder, 0.85) || cBorder;
        ctx.lineWidth = 1;
        roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 12);
        ctx.fill();
        ctx.stroke();

        // Horizontal grid lines (simple axes)
        const gridLines = 4;
        ctx.strokeStyle = toRgba(cBorder, 0.65);
        ctx.lineWidth = 1;

        for (let i = 0; i <= gridLines; i++) {
          const y = plotTop + (plotHeight * i) / gridLines;
          ctx.beginPath();
          ctx.moveTo(plotLeft, y);
          ctx.lineTo(plotLeft + plotWidth, y);
          ctx.stroke();
        }

        // Zero baseline
        const y0 = yForValue(0, yrange, plotTop, plotHeight);
        ctx.strokeStyle = toRgba(cMuted, 0.55);
        ctx.beginPath();
        ctx.moveTo(plotLeft, y0);
        ctx.lineTo(plotLeft + plotWidth, y0);
        ctx.stroke();

        // Y labels (min/max/0)
        ctx.fillStyle = toRgba(cMuted, 0.95);
        ctx.font = "12px var(--mono)";
        ctx.textBaseline = "middle";
        const label = (cp) => {
          const pawns = cp / 100;
          const s = pawns > 0 ? "+" : "";
          return `${s}${pawns.toFixed(1)}`;
        };

        ctx.fillText(label(yrange.max), 10, plotTop);
        ctx.fillText("0.0", 10, y0);
        ctx.fillText(label(yrange.min), 10, plotTop + plotHeight);

        // Area shading for advantage (above/below baseline)
        // We fill two polygons: positive (green-ish), negative (red-ish).
        const n = values.length;
        if (n >= 2) {
          // Draw positive/negative area segments in one pass over points.
          const pts = [];
          for (let i = 0; i < n; i++) {
            const v = values[i];
            if (!Number.isFinite(v)) continue;
            pts.push({
              i,
              x: xForIndex(i, n, plotLeft, plotWidth),
              y: yForValue(v, yrange, plotTop, plotHeight),
              v
            });
          }

          if (pts.length >= 2) {
            const fillArea = (predicate, fillStyle) => {
              ctx.fillStyle = fillStyle;

              let started = false;
              let lastX = null;

              for (let p = 0; p < pts.length; p++) {
                const a = pts[p];
                const ok = predicate(a.v);
                if (!ok) {
                  if (started && lastX != null) {
                    ctx.lineTo(lastX, y0);
                    ctx.closePath();
                    ctx.fill();
                    started = false;
                    lastX = null;
                  }
                  continue;
                }

                if (!started) {
                  ctx.beginPath();
                  ctx.moveTo(a.x, y0);
                  ctx.lineTo(a.x, a.y);
                  started = true;
                } else {
                  ctx.lineTo(a.x, a.y);
                }
                lastX = a.x;
              }

              if (started && lastX != null) {
                ctx.lineTo(lastX, y0);
                ctx.closePath();
                ctx.fill();
              }
            };

            fillArea((v) => v >= 0, toRgba(cSuccess, 0.18));
            fillArea((v) => v < 0, "rgba(239, 68, 68, 0.16)");
          }
        }

        // Line path
        if (values.length >= 2) {
          ctx.strokeStyle = cAccent;
          ctx.lineWidth = 2;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();

          let started = false;
          for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (!Number.isFinite(v)) {
              started = false;
              continue;
            }
            const x = xForIndex(i, values.length, plotLeft, plotWidth);
            const y = yForValue(v, yrange, plotTop, plotHeight);

            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        }

        // Selected / hover markers
        const drawMarker = (ply, color, isHover = false) => {
          if (ply == null) return;
          if (!Number.isFinite(values[ply])) return;
          const x = xForIndex(ply, values.length, plotLeft, plotWidth);
          const y = yForValue(values[ply], yrange, plotTop, plotHeight);

          // Vertical guide
          ctx.strokeStyle = toRgba(color, isHover ? 0.75 : 0.55);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, plotTop);
          ctx.lineTo(x, plotTop + plotHeight);
          ctx.stroke();

          // Dot
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, isHover ? 4 : 3, 0, Math.PI * 2);
          ctx.fill();
        };

        // Selected first (slightly subtler), then hover on top.
        drawMarker(selectedPly, toRgba(cAccent, 0.95), false);
        drawMarker(localHover, "#ffffff", true);

        // X-axis label
        ctx.fillStyle = toRgba(cMuted, 0.95);
        ctx.font = "12px var(--mono)";
        ctx.textBaseline = "alphabetic";
        ctx.fillText("Move (ply)", plotLeft, h - 8);

        // Tooltip for hover
        if (localHover != null && Number.isFinite(values[localHover])) {
          const x = xForIndex(localHover, values.length, plotLeft, plotWidth);
          const v = values[localHover];
          const pawns = v / 100;
          const s = pawns > 0 ? "+" : "";
          const text = `${s}${pawns.toFixed(2)}`;

          ctx.font = "12px var(--mono)";
          const tw = ctx.measureText(text).width;
          const padX = 8;
          const padY = 6;

          const boxW = tw + padX * 2;
          const boxH = 24;

          const bx = clamp(x - boxW / 2, plotLeft, plotLeft + plotWidth - boxW);
          const by = plotTop + 6;

          ctx.fillStyle = toRgba(cPanel, 0.92);
          ctx.strokeStyle = toRgba(cBorder, 0.9);
          ctx.lineWidth = 1;

          roundRect(ctx, bx, by, boxW, boxH, 10);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = cText;
          ctx.textBaseline = "middle";
          ctx.fillText(text, bx + padX, by + boxH / 2);
        }
      });
    };

    schedule();
    return () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [size.width, size.height, values, yrange, selectedPly, localHover]);

  const getPlyFromEvent = (evt) => {
    if (!wrapRef.current) return null;
    const rect = wrapRef.current.getBoundingClientRect();
    const x = evt.clientX - rect.left;

    const n = values.length;
    if (n <= 0) return null;

    // Match the same padding as draw logic.
    const padL = 44;
    const padR = 14;

    const plotLeft = padL;
    const plotWidth = Math.max(1, rect.width - padL - padR);

    const t = (x - plotLeft) / plotWidth;
    const idx = Math.round(t * (n - 1));
    return clamp(idx, 0, n - 1);
  };

  const emitHover = (ply) => {
    setLocalHover(ply);
    if (typeof onHoverPly === "function") onHoverPly(ply);
  };

  const emitSelect = (ply) => {
    if (typeof onSelectPly === "function") onSelectPly(ply);
  };

  const hasData = values.length >= 2;

  return (
    <div className="evalGraphWrap" ref={wrapRef} aria-label="Evaluation graph (centipawns over time)">
      <div className="evalGraphHeader">
        <div className="evalGraphTitle">Evaluation over time</div>
        <div className="evalGraphHint">Hover to preview • Click to jump</div>
      </div>

      <div
        className="evalGraphCanvasWrap"
        role="application"
        aria-label="Interactive evaluation graph"
        tabIndex={0}
        onMouseMove={(e) => {
          if (!hasData) return;
          const ply = getPlyFromEvent(e);
          emitHover(ply);
        }}
        onMouseLeave={() => emitHover(null)}
        onClick={(e) => {
          if (!hasData) return;
          const ply = getPlyFromEvent(e);
          emitSelect(ply);
        }}
        onKeyDown={(e) => {
          if (!hasData) return;
          // Basic keyboard support: left/right to nudge selection, enter to confirm selection.
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            const base = localHover != null ? localHover : selectedPly != null ? selectedPly : 0;
            emitHover(clamp(base - 1, 0, values.length - 1));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            const base = localHover != null ? localHover : selectedPly != null ? selectedPly : 0;
            emitHover(clamp(base + 1, 0, values.length - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (localHover != null) emitSelect(localHover);
          }
        }}
      >
        <canvas ref={canvasRef} className="evalGraphCanvas" />
        {!hasData ? <div className="evalGraphEmpty">Run analysis to see the evaluation graph.</div> : null}
      </div>
    </div>
  );
}
