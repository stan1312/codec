// Synchronised playback logic, framework-free so it can be unit-tested.
//
// Time model (same convention as the rest of Codec): every datetime coming
// from the sheet is converted with localtoUTCdatetimeobj, so "master time"
// is a number of milliseconds in that same space. A video whose
// chronolocation is `startMs` shows, at master time T, the frame at
// (T - startMs) / 1000 seconds into the file.

export const SYNC_DEFAULTS = {
  // above this drift (s) we hard-seek the video
  seekThreshold: 0.3,
  // below this drift (s) we consider the video in sync
  toleranceWhilePlaying: 0.04,
  toleranceWhilePaused: 0.02,
  // max relative speed change used to catch up small drifts smoothly
  maxRateCorrection: 0.1,
  // proportional gain: rate correction per second of drift
  rateGain: 0.5,
};

// Seconds into the media file for a given master time.
export function mediaTimeFor(masterMs, startMs, offsetSec = 0) {
  return (masterMs - startMs) / 1000 - (offsetSec || 0);
}

// Master time (ms) corresponding to a position inside the media file.
export function masterTimeFor(mediaSec, startMs, offsetSec = 0) {
  return startMs + (mediaSec + (offsetSec || 0)) * 1000;
}

// Decide what to do with a <video> element so that it follows the master clock.
//
// state: { currentTime, duration, paused } of the element
// target: seconds into the file where it should be
// playing: whether the master clock is running
// rate: master playback rate
//
// Returns { status, seekTo?, play?, pause?, playbackRate }
//   status: "before" | "after" | "sync" | "seek" | "correct"
export function syncDecision(state, target, playing, rate = 1, opts = {}) {
  const o = { ...SYNC_DEFAULTS, ...opts };
  const duration = Number.isFinite(state.duration) ? state.duration : Infinity;

  if (target < 0) {
    return { status: "before", seekTo: needsSeek(state.currentTime, 0, o.toleranceWhilePaused), pause: !state.paused, playbackRate: rate };
  }
  if (target > duration) {
    return { status: "after", seekTo: needsSeek(state.currentTime, duration, o.toleranceWhilePaused), pause: !state.paused, playbackRate: rate };
  }

  // positive drift = video is ahead of where it should be
  const drift = state.currentTime - target;
  const abs = Math.abs(drift);

  if (!playing) {
    return {
      status: abs > o.toleranceWhilePaused ? "seek" : "sync",
      seekTo: abs > o.toleranceWhilePaused ? target : undefined,
      pause: !state.paused,
      playbackRate: rate,
    };
  }

  if (abs > o.seekThreshold) {
    return { status: "seek", seekTo: target, play: state.paused, playbackRate: rate };
  }
  if (abs > o.toleranceWhilePlaying) {
    // smooth catch-up: slow down if ahead, speed up if behind
    const corr = clamp(-drift * o.rateGain, -o.maxRateCorrection, o.maxRateCorrection);
    return { status: "correct", play: state.paused, playbackRate: rate * (1 + corr) };
  }
  return { status: "sync", play: state.paused, playbackRate: rate };
}

function needsSeek(current, wanted, tol) {
  return Math.abs(current - wanted) > tol ? wanted : undefined;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// Advance the master clock. Returns { time, playing }.
export function advanceClock(time, dtMs, rate, minMs, maxMs) {
  let t = time + dtMs * rate;
  if (Number.isFinite(maxMs) && t >= maxMs) return { time: maxMs, playing: false };
  if (Number.isFinite(minMs) && t < minMs) t = minMs;
  return { time: t, playing: true };
}

// "HH:MM:SS(.sss)" -> seconds
export function parseDuration(str) {
  if (str === undefined || str === null || str === "") return NaN;
  const parts = String(str).trim().split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// Format master time (ms in Codec's "UTC" space) as HH:MM:SS.s
export function formatClock(ms, decimals = 1) {
  if (!Number.isFinite(ms)) return "--:--:--";
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  let s = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (decimals > 0) {
    s += "." + String(Math.floor(d.getUTCMilliseconds() / Math.pow(10, 3 - decimals))).padStart(decimals, "0");
  }
  return s;
}
