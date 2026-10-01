// Master clock: a single requestAnimationFrame loop that advances
// playback_store.time while playing.
import { get } from "svelte/store";
import { playback_store } from "../stores/store";
import { advanceClock } from "./sync";

let bounds = { min: NaN, max: NaN };
let rafId = null;
let last = null;

export function setClockBounds(minMs, maxMs) {
  bounds = { min: minMs, max: maxMs };
  const p = get(playback_store);
  if (!Number.isFinite(p.time) && Number.isFinite(minMs)) {
    playback_store.update((s) => ({ ...s, time: minMs, jump: s.jump + 1 }));
  }
}

function tick(now) {
  const p = get(playback_store);
  if (!p.playing) {
    rafId = null;
    last = null;
    return;
  }
  if (last !== null) {
    const { time, playing } = advanceClock(p.time, now - last, p.rate, bounds.min, bounds.max);
    playback_store.update((s) => ({ ...s, time, playing }));
  }
  last = now;
  rafId = requestAnimationFrame(tick);
}

export function play() {
  const p = get(playback_store);
  if (Number.isFinite(bounds.max) && p.time >= bounds.max) {
    // at the end: restart from the beginning
    playback_store.update((s) => ({ ...s, time: bounds.min, jump: s.jump + 1 }));
  }
  playback_store.update((s) => ({ ...s, playing: true }));
  if (rafId === null) {
    last = null;
    rafId = requestAnimationFrame(tick);
  }
}

export function pause() {
  playback_store.update((s) => ({ ...s, playing: false }));
}

export function togglePlay() {
  get(playback_store).playing ? pause() : play();
}

// Jump to an absolute master time (ms)
export function seekTo(ms) {
  if (!Number.isFinite(ms)) return;
  let t = ms;
  if (Number.isFinite(bounds.min)) t = Math.max(bounds.min, t);
  if (Number.isFinite(bounds.max)) t = Math.min(bounds.max, t);
  playback_store.update((s) => ({ ...s, time: t, jump: s.jump + 1 }));
}

export function seekBy(deltaMs) {
  seekTo(get(playback_store).time + deltaMs);
}

export function setRate(rate) {
  playback_store.update((s) => ({ ...s, rate }));
}
