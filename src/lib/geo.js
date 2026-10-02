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
// { UAR: [{t, lat, lon, bearing}] } (absolute) or
// { UAR: [{t, x, y, heading_rel, relative: true}] } (relative, metres)
// sorted by t.
//
// Absolute columns: UAR, t, lat, lon, bearing
// Relative columns: UAR, t, x, y, heading_rel   (x = metres to the right of the
//   first view, y = metres forward along the first view, heading_rel = degrees
//   relative to the first view). Relative tracks are put on the map with the
//   position and bearing of the video's first image from the media tab, so
//   changing the bearing in the sheet (or on the map) rotates the whole path.
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
  const iX = idx(["x", "x_m"]);
  const iY = idx(["y", "y_m"]);
  const iH = idx(["heading_rel", "bearing_rel"]);
  if (iU < 0 || iT < 0) return out;
  const relative = iLat < 0 && iX >= 0 && iY >= 0;
  if (!relative && (iLat < 0 || iLon < 0)) return out;
  const num = (v) => parseFloat(String(v ?? "").replace(",", "."));
  for (const row of rows.slice(1)) {
    const uar = String(row[iU] ?? "").trim();
    let p;
    if (relative) {
      p = { t: num(row[iT]), x: num(row[iX]), y: num(row[iY]), heading_rel: iH >= 0 ? num(row[iH]) : NaN, relative: true };
      if (!uar || ![p.t, p.x, p.y].every(Number.isFinite)) continue;
    } else {
      p = { t: num(row[iT]), lat: num(row[iLat]), lon: num(row[iLon]), bearing: iB >= 0 ? num(row[iB]) : NaN };
      if (!uar || ![p.t, p.lat, p.lon].every(Number.isFinite)) continue;
    }
    if (!out[uar]) out[uar] = [];
    out[uar].push(p);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t - b.t);
  return out;
}

// Relative point (metres in the frame of the first view) -> map position.
// origin = { lat, lon, bearing } of the first image.
export function projectRelative(origin, p) {
  const b = (origin.bearing || 0) * DEG;
  // rotate clockwise by the bearing: "forward" (y) -> bearing, "right" (x) -> bearing + 90
  const e = p.x * Math.cos(b) + p.y * Math.sin(b);
  const n = -p.x * Math.sin(b) + p.y * Math.cos(b);
  const m = metersPerDegree(origin.lat);
  return {
    lat: origin.lat + n / m.lat,
    lon: origin.lon + e / m.lon,
    bearing: Number.isFinite(p.heading_rel) ? normalizeBearing(origin.bearing + p.heading_rel) : origin.bearing,
  };
}

// Inverse: which origin puts relative point p at map position `at` (with bearing kept)?
export function originForPosition(at, p, bearing) {
  const b = (bearing || 0) * DEG;
  const e = p.x * Math.cos(b) + p.y * Math.sin(b);
  const n = -p.x * Math.sin(b) + p.y * Math.cos(b);
  const m = metersPerDegree(at.lat);
  return { lat: at.lat - n / m.lat, lon: at.lon - e / m.lon };
}

// Interpolated relative point {x, y, heading_rel} of a relative track at time t.
export function relativeAt(track, t) {
  if (!track || !track.length) return null;
  const asAbs = track.map((p) => ({ t: p.t, lat: p.y, lon: p.x, bearing: Number.isFinite(p.heading_rel) ? normalizeBearing(p.heading_rel) : NaN }));
  const q = poseAt(asAbs, t);
  let h = q.bearing;
  if (Number.isFinite(h) && h > 180) h -= 360;
  return { t, x: q.lon, y: q.lat, heading_rel: h, clamped: q.clamped, interpolated_gap: q.interpolated_gap };
}

// Azimuth (deg, clockwise from north) from a to b, local flat approximation.
export function azimuth(a, b) {
  const m = metersPerDegree(a.lat);
  const e = (b.lon - a.lon) * m.lon;
  const n = (b.lat - a.lat) * m.lat;
  return normalizeBearing((Math.atan2(e, n) * 180) / Math.PI);
}
