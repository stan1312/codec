// Waveforms of the videos (fork Genève): decoded once per video in the
// browser (local file or URL), kept in memory, drawn on the timeline items
// and in the "synchroniser 2 vidéos" panel.
import { writable, get } from "svelte/store";
import { decodeEnvelope, waveformDataURL } from "./audio";

// { UAR: { status: "queued"|"loading"|"ok"|"error", env, rate, duration, url, error } }
export const waveforms = writable({});
export const waves_on = writable(false);

// where to read a medium from (same rule as the video player)
export function mediaSource(medium, cfg, localFiles) {
  if (!medium) return null;
  if (String(cfg["Source of media files"] || "").includes("local")) return (localFiles && localFiles[medium.UAR]) || null;
  const url = medium[cfg["Title of column used for url"]];
  return url ? String(url) : null;
}

const queue = [];
let running = false;

function set(uar, v) {
  waveforms.update((s) => ({ ...s, [uar]: { ...(s[uar] || {}), ...v } }));
}

// ask for the waveforms of these media (already known ones are skipped)
export function requestWaveforms(media, cfg, localFiles) {
  const have = get(waveforms);
  for (const m of media) {
    if (!m || queue.some((q) => q.uar === m.UAR)) continue;
    // known, except "file not loaded yet" (retried once the file is selected)
    if (have[m.UAR] && !(have[m.UAR].status === "error" && have[m.UAR].missing)) continue;
    const src = mediaSource(m, cfg, localFiles);
    if (!src) {
      if (!have[m.UAR]) set(m.UAR, { status: "error", error: "fichier non chargé", missing: true });
      continue;
    }
    const len = m.start instanceof Date ? (new Date(m.end).getTime() - m.start.getTime()) / 1000 : NaN;
    queue.push({ uar: m.UAR, src, len });
    set(m.UAR, { status: "queued", missing: false, error: "" });
  }
  run();
}

export function retryWaveform(uar) {
  waveforms.update((s) => {
    const c = { ...s };
    delete c[uar];
    return c;
  });
}

async function run() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { uar, src, len } = queue.shift();
    set(uar, { status: "loading" });
    try {
      const { env, rate, duration } = await decodeEnvelope(src);
      // the timeline bar lasts `len` s (duration column): draw exactly that span
      const span = Number.isFinite(len) && len > 0 ? len : duration;
      const url = waveformDataURL(env, { width: 900, height: 32, color: "rgba(0,0,0,0.8)", from: 0, to: Math.round(span * rate) });
      set(uar, { status: "ok", env, rate, duration, url });
    } catch (e) {
      console.log("waveform", uar, e);
      set(uar, { status: "error", error: /fetch|network|cors/i.test(String(e)) ? "fichier inaccessible (lien)" : "pas de son lisible" });
    }
  }
  running = false;
}

// counts for the interface
export function waveCounts(s) {
  const v = Object.values(s);
  return {
    ok: v.filter((x) => x.status === "ok").length,
    busy: v.filter((x) => x.status === "loading" || x.status === "queued").length,
    err: v.filter((x) => x.status === "error").length,
  };
}
