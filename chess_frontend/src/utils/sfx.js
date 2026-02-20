/**
 * Lightweight, dependency-free sound effects.
 *
 * We use the Web Audio API to generate short beeps (no external asset files),
 * keeping the app lightweight and avoiding bundling/hosting concerns.
 *
 * Design goals:
 * - Non-blocking: schedule and play asynchronously; never await.
 * - Best-effort: if audio is unavailable (e.g., autoplay restrictions), fail silently.
 */

let audioCtx = null;
let masterGain = null;

function getAudioContext() {
  if (typeof window === "undefined") return null;

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  if (!audioCtx) {
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.08; // keep subtle
    masterGain.connect(audioCtx.destination);
  }

  return audioCtx;
}

function ensureRunning(ctx) {
  // Some browsers start in "suspended" until user gesture. We attempt resume but don't block.
  if (ctx.state === "suspended") {
    // Fire-and-forget.
    ctx.resume().catch(() => {});
  }
}

/**
 * Create a short beep with an exponential decay envelope.
 * This is intentionally tiny and "retro".
 */
function scheduleBeep({ freq, durationMs, type = "sine", when = 0 }) {
  const ctx = getAudioContext();
  if (!ctx || !masterGain) return;

  ensureRunning(ctx);

  const t0 = ctx.currentTime + when;

  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(1.0, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);

  osc.connect(gain);
  gain.connect(masterGain);

  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.02);
}

// PUBLIC_INTERFACE
export function playMoveSfx() {
  /** Play a subtle "move" sound. Best-effort; fails silently if audio is unavailable. */
  try {
    // Two short ascending beeps.
    scheduleBeep({ freq: 440, durationMs: 45, type: "triangle" });
    scheduleBeep({ freq: 660, durationMs: 55, type: "triangle", when: 0.05 });
  } catch {
    // no-op
  }
}

// PUBLIC_INTERFACE
export function playCaptureSfx() {
  /** Play a slightly sharper "capture" sound. Best-effort; fails silently if audio is unavailable. */
  try {
    // A quick "zap" + low thud.
    scheduleBeep({ freq: 880, durationMs: 35, type: "square" });
    scheduleBeep({ freq: 220, durationMs: 70, type: "sine", when: 0.04 });
  } catch {
    // no-op
  }
}

// PUBLIC_INTERFACE
export function primeSfx() {
  /**
   * Attempt to initialize/resume audio context (e.g., on first user gesture).
   * This is optional; the sfx functions will also lazily init.
   */
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    ensureRunning(ctx);
  } catch {
    // no-op
  }
}
