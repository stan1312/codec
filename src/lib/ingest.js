// From a video file's metadata to a row of the media tab (shared by the web
// interface and tools/auto_ingest.mjs).
import { chooseCaptureTime, parseLocal, DEFAULT_TZ } from "./captureTime.js";
import { estimateFov } from "./mediaMeta.js";
import { cfgGet, INGEST_COLUMNS, VERIF_COLUMNS, DATE_CANDIDATES_COLUMN } from "./columns.js";

// UAR = file name up to the first "." (that is how Codec matches local files)
export function uarFromFileName(name) {
  const base = String(name).split(/[\\/]/).pop();
  const i = base.indexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const pad = (n) => String(n).padStart(2, "0");
  const ss = s.toFixed(3).padStart(6, "0");
  return `${pad(h)}:${pad(m)}:${ss}`;
}

// Event window: "Capture window start/end" in Platform config, else the timeline bounds.
export function captureWindow(cfg, tz = DEFAULT_TZ) {
  const a = cfg["Capture window start"] || cfg["Timeline begin datetime"];
  const b = cfg["Capture window end"] || cfg["Timeline end datetime"];
  return { start: parseLocal(a, tz), end: parseLocal(b, tz) };
}

// Every date found in the file, one per line, most reliable first:
// "2026-06-14 19:19:24 | date de prise de vue Apple | fiabilité 5/5 | dans la fenêtre | CHOISIE"
export function formatCandidates(choice) {
  const kinds = { start: "début", end: "fin", start_or_end: "début ou fin", after: "après la captation", day_after: "jour après" };
  return [...choice.candidates]
    .sort((a, b) => b.reliability - a.reliability || a.ms - b.ms)
    .map((c) =>
      [
        c.local,
        c.label,
        `fiabilité ${c.reliability}/5`,
        kinds[c.kind] || c.kind,
        c.kind === "after" || c.kind === "day_after" ? "limite" : c.in_window ? "dans la fenêtre" : "hors fenêtre",
        c.source === choice.source && c.ms !== undefined && choice.start_ms !== null ? "CHOISIE" : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

// -> { uar, row: {column title: value}, choice, meta }
export function mediaRowFromMeta(meta, cfg, opts = {}) {
  const tz = opts.tz || cfg["Time zone"] || DEFAULT_TZ;
  const choice = chooseCaptureTime(meta, opts.window || captureWindow(cfg, tz), { tz });
  const uar = uarFromFileName(meta.file_name);
  const C = (k) => cfgGet(cfg, k);
  const row = { UAR: uar };
  row[C("Title of column used for chronolocation")] = choice.start_local || "";
  row[C("Title of column used for duration")] = formatDuration(meta.duration);
  if (meta.location) {
    row[C("Title of column used for latitude")] = meta.location.lat;
    row[C("Title of column used for longitude")] = meta.location.lon;
  }
  const fov = estimateFov(meta);
  if (fov) row[C("Title of column used for field of view")] = fov;
  row[INGEST_COLUMNS.dateSource] = choice.label || "";
  row[INGEST_COLUMNS.dateConfidence] = choice.status === "ok" ? choice.confidence || "" : choice.status;
  row[INGEST_COLUMNS.dateNotes] = choice.notes.join(" | ");
  row[DATE_CANDIDATES_COLUMN] = formatCandidates(choice);
  row[INGEST_COLUMNS.gpsAccuracy] = meta.location && meta.location.accuracy_m != null ? Math.round(meta.location.accuracy_m) : "";
  row[INGEST_COLUMNS.device] = [meta.make, meta.model].filter(Boolean).join(" ");
  row[INGEST_COLUMNS.originalFile] = meta.file_name;
  if (opts.sha256) row[INGEST_COLUMNS.sha256] = opts.sha256;
  // nothing is verified yet
  for (const v of VERIF_COLUMNS) row[v.column] = false;
  return { uar, row, choice, meta };
}

// For a video ALREADY in the sheet: the informational columns that are still
// empty there (date candidates, date source, device, verification boxes...).
// Never touches what a person may have set: time, duration, position, cone, offset.
export function backfillValues(row, existing, cfg) {
  const C = (k) => cfgGet(cfg, k);
  const protectedCols = new Set([
    "UAR",
    C("Title of column used for chronolocation"),
    C("Title of column used for duration"),
    C("Title of column used for latitude"),
    C("Title of column used for longitude"),
    C("Title of column used for bearing"),
    C("Title of column used for field of view"),
    C("Title of column used for sync offset"),
  ]);
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (protectedCols.has(k)) continue;
    const cur = existing ? existing[k] : undefined;
    const empty = cur === undefined || cur === null || String(cur).trim() === "";
    if (empty && v !== "" && v !== undefined) out[k] = v;
  }
  return out;
}
