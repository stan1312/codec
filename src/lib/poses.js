// Where is each camera, and where does it look, at a given master time?
// Framework-free so it can be tested.
import { poseAt, relativeAt, projectRelative, originForPosition, azimuth, normalizeBearing } from "./geo.js";
import { mediaTimeFor } from "./sync.js";

// effective first-image parameters of a medium (sheet values + local edits)
export function originOf(medium, override = {}) {
  const pick = (k, alt) => (override && Number.isFinite(override[k]) ? override[k] : alt);
  return {
    lat: pick("lat", medium.lat),
    lon: pick("long", medium.long),
    bearing: pick("bearing", medium.bearing),
    fov: pick("fov", medium.fov),
  };
}

function hasTime(medium) {
  return medium.start instanceof Date && !isNaN(medium.start);
}

export function mediaTime(medium, time) {
  return hasTime(medium) && Number.isFinite(time) ? mediaTimeFor(time, medium.start.getTime()) : 0;
}

// -> { lat, lon, bearing, fov, active, relative }  or null if the medium has no position
export function poseOf(medium, track, time, override) {
  const o = originOf(medium, override);
  const active =
    hasTime(medium) && Number.isFinite(time) && time >= medium.start.getTime() && time <= new Date(medium.end).getTime();
  const t = mediaTime(medium, time);
  if (track && track.length && track[0].relative) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return null;
    const r = relativeAt(track, t);
    if (!Number.isFinite(o.bearing)) {
      // no bearing yet: follow the path with a PROVISIONAL orientation (north),
      // without a cone (the direction is unknown)
      const p = projectRelative({ ...o, bearing: 0 }, r);
      return { lat: p.lat, lon: p.lon, bearing: NaN, fov: o.fov, active, relative: true, unoriented: true };
    }
    const p = projectRelative(o, r);
    return { ...p, fov: o.fov, active, relative: true };
  }
  if (track && track.length) {
    const p = poseAt(track, t);
    return { lat: p.lat, lon: p.lon, bearing: Number.isFinite(p.bearing) ? p.bearing : o.bearing, fov: o.fov, active };
  }
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return null;
  return { lat: o.lat, lon: o.lon, bearing: o.bearing, fov: o.fov, active };
}

export function computePoses(media, trajectories, time, overrides = {}) {
  const out = {};
  for (const m of Object.values(media)) {
    const p = poseOf(m, trajectories[m.UAR], time, overrides[m.UAR]);
    if (p) out[m.UAR] = p;
  }
  return out;
}

// [[lon, lat], ...] of the whole path on the map (or null)
export function pathOf(medium, track, override) {
  if (!track || track.length < 2) return null;
  if (track[0].relative) {
    const o = originOf(medium, override);
    if (![o.lat, o.lon].every(Number.isFinite)) return null;
    // no bearing yet: provisional orientation (north), see isOriented()
    if (!Number.isFinite(o.bearing)) o.bearing = 0;
    return track.map((p) => {
      const q = projectRelative(o, p);
      return [q.lon, q.lat];
    });
  }
  return track.map((p) => [p.lon, p.lat]);
}

// a relative path needs the bearing of the first image to be oriented
export function isOriented(medium, track, override) {
  if (!track || !track.length || !track[0].relative) return true;
  return Number.isFinite(originOf(medium, override).bearing);
}

// short description of a trajectory for the interface
export function trackSummary(track) {
  if (!track || track.length < 2) return null;
  let len = 0;
  if (track[0].relative) for (let i = 1; i < track.length; i++) len += Math.hypot(track[i].x - track[i - 1].x, track[i].y - track[i - 1].y);
  return { points: track.length, length: len, from: track[0].t, to: track[track.length - 1].t };
}

// ---- editing from a click on the map ----

// New FIRST-IMAGE bearing so that the camera looks towards `click` at master time `time`.
// For a relative trajectory the rotation measured by COLMAP/VGGT at that moment
// is taken into account, so you can set the direction on any frame.
export function bearingFromClick(medium, track, time, click, override) {
  const pose = poseOf(medium, track, time, { ...override, bearing: Number.isFinite(originOf(medium, override).bearing) ? originOf(medium, override).bearing : 0 });
  if (!pose) return NaN;
  const wanted = azimuth({ lat: pose.lat, lon: pose.lon }, click);
  if (track && track.length && track[0].relative) {
    const r = relativeAt(track, mediaTime(medium, time));
    const rel = Number.isFinite(r.heading_rel) ? r.heading_rel : 0;
    // the position also depends on the bearing: iterate (converges in a few steps)
    let b = normalizeBearing(wanted - rel);
    for (let i = 0; i < 5; i++) {
      const o = originOf(medium, { ...override, bearing: b });
      const p = projectRelative(o, r);
      b = normalizeBearing(azimuth({ lat: p.lat, lon: p.lon }, click) - rel);
    }
    return round1(b);
  }
  return round1(wanted);
}

// New FIRST-IMAGE position so that the camera is at `click` at master time `time`.
export function positionFromClick(medium, track, time, click, override) {
  if (track && track.length && track[0].relative) {
    const o = originOf(medium, override);
    const r = relativeAt(track, mediaTime(medium, time));
    const p = originForPosition(click, r, Number.isFinite(o.bearing) ? o.bearing : 0);
    return { lat: round7(p.lat), long: round7(p.lon) };
  }
  return { lat: round7(click.lat), long: round7(click.lon) };
}

const round1 = (x) => Math.round(x * 10) / 10;
const round7 = (x) => Math.round(x * 1e7) / 1e7;
