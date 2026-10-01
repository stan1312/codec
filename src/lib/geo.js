// Geometry helpers for view cones and camera trajectories (framework-free).

const DEG = Math.PI / 180;

// metres per degree at a given latitude (WGS84 series expansion)
export function metersPerDegree(latDeg) {
  const p = latDeg * DEG;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

// Point at `distM` metres from (lat, lon) towards `bearingDeg` (0 = north, clockwise).
// Local flat-earth approximation: accurate to well under a metre over a few hundred metres.
export function destination(lat, lon, bearingDeg, distM) {
  const m = metersPerDegree(lat);
  const b = bearingDeg * DEG;
  return {
    lat: lat + (distM * Math.cos(b)) / m.lat,
    lon: lon + (distM * Math.sin(b)) / m.lon,
  };
}

export function normalizeBearing(b) {
  return ((b % 360) + 360) % 360;
}

// Closed polygon ring ([lon, lat] pairs) for a view cone.
export function conePolygon(lat, lon, bearingDeg, fovDeg = 60, lengthM = 40, steps = 12) {
  const ring = [[lon, lat]];
  const half = fovDeg / 2;
  for (let i = 0; i <= steps; i++) {
    const b = bearingDeg - half + (fovDeg * i) / steps;
    const p = destination(lat, lon, b, lengthM);
    ring.push([p.lon, p.lat]);
  }
  ring.push([lon, lat]);
  return ring;
}

// Shortest-path interpolation between two bearings.
export function lerpBearing(a, b, f) {
  const d = ((b - a + 540) % 360) - 180;
  return normalizeBearing(a + d * f);
}

// Pose of a camera at `t` seconds into its video, from a sorted track
// [{t, lat, lon, bearing}]. Returns null if the track is empty.
// Before the first / after the last sample the pose is held.
// `maxGap`: if t falls in a gap longer than this (s) between samples,
// `interpolated_gap` is set so the UI can show it as uncertain.
export function poseAt(track, t, maxGap = 3) {
  if (!track || track.length === 0) return null;
  if (t <= track[0].t) return { ...track[0], clamped: t < track[0].t };
  const last = track[track.length - 1];
  if (t >= last.t) return { ...last, clamped: t > last.t };
  // binary search for the segment
  let lo = 0;
  let hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = track[lo];
  const b = track[hi];
  const f = (t - a.t) / (b.t - a.t);
  const bearing =
    Number.isFinite(a.bearing) && Number.isFinite(b.bearing)
      ? lerpBearing(a.bearing, b.bearing, f)
      : Number.isFinite(a.bearing)
        ? a.bearing
        : b.bearing;
  return {
    t,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    bearing,
    clamped: false,
    interpolated_gap: b.t - a.t > maxGap,
  };
}

// Rows from the "trajectories" sheet tab (first row = column names) ->
// { UAR: [{t, lat, lon, bearing}] } sorted by t.
// Expected columns (case-insensitive): UAR, t, lat, lon, bearing
export function parseTrajectoryRows(rows) {
  const out = {};
  if (!Array.isArray(rows) || rows.length < 2) return out;
  const header = rows[0].map((c) => String(c).trim().toLowerCase());
  const idx = (names) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n + " ")));
  const iU = idx(["uar"]);
  const iT = idx(["t", "time", "temps"]);
  const iLat = idx(["lat", "latitude"]);
  const iLon = idx(["lon", "lng", "long", "longitude"]);
  const iB = idx(["bearing", "cap", "heading"]);
  if ([iU, iT, iLat, iLon].some((i) => i < 0)) return out;
  const num = (v) => parseFloat(String(v ?? "").replace(",", "."));
  for (const row of rows.slice(1)) {
    const uar = String(row[iU] ?? "").trim();
    const p = { t: num(row[iT]), lat: num(row[iLat]), lon: num(row[iLon]), bearing: iB >= 0 ? num(row[iB]) : NaN };
    if (!uar || ![p.t, p.lat, p.lon].every(Number.isFinite)) continue;
    if (!out[uar]) out[uar] = [];
    out[uar].push(p);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t - b.t);
  return out;
}
