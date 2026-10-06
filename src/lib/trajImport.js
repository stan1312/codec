// Import of trajectory CSV files computed on a computer (tools/run_trajectories.py
// or colmap_track.py georef --relative): UAR,t,x,y,heading_rel,quality
// (or absolute: UAR,t,lat,lon,bearing,quality). Grouped by video.

function splitLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const NUM = new Set(["t", "x", "y", "heading_rel", "lat", "lon", "bearing"]);

// -> { byUar: { UAR: [rows] }, errors: [] }
export function parseTrajectoryCsv(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const errors = [];
  if (!lines.length) return { byUar: {}, errors: ["fichier vide"] };
  const header = splitLine(lines[0]);
  if (!header.includes("UAR") || !header.includes("t")) return { byUar: {}, errors: ["colonnes UAR et t introuvables"] };
  const byUar = {};
  lines.slice(1).forEach((l, i) => {
    const cells = splitLine(l);
    const r = {};
    header.forEach((h, k) => {
      const v = cells[k] === undefined ? "" : cells[k];
      r[h] = NUM.has(h) && v !== "" ? parseFloat(v) : v;
    });
    if (!r.UAR || !Number.isFinite(r.t)) {
      errors.push(`ligne ${i + 2} ignorée`);
      return;
    }
    const uar = r.UAR;
    delete r.UAR;
    (byUar[uar] = byUar[uar] || []).push(r);
  });
  for (const u of Object.keys(byUar)) byUar[u].sort((a, b) => a.t - b.t);
  return { byUar, errors };
}
