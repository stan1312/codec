import test from "node:test";
import assert from "node:assert/strict";
import { syncDecision, mediaTimeFor, masterTimeFor, advanceClock, parseDuration, formatClock } from "../src/lib/sync.js";
import { destination, conePolygon, poseAt, lerpBearing, parseTrajectoryRows, metersPerDegree } from "../src/lib/geo.js";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("media time / master time are inverse", () => {
  const start = Date.UTC(2025, 9, 2, 20, 47, 10);
  close(mediaTimeFor(start + 12_500, start), 12.5);
  close(mediaTimeFor(start + 12_500, start, 2), 10.5);
  close(masterTimeFor(12.5, start), start + 12_500);
  close(masterTimeFor(mediaTimeFor(start + 3333, start, 1.2), start, 1.2), start + 3333);
});

test("sync decisions", () => {
  const st = (currentTime, paused = false, duration = 60) => ({ currentTime, paused, duration });
  assert.equal(syncDecision(st(5), -1, true).status, "before");
  assert.equal(syncDecision(st(5), -1, true).seekTo, 0);
  assert.equal(syncDecision(st(5), -1, true).pause, true);
  assert.equal(syncDecision(st(60, true), 70, true).status, "after");
  assert.equal(syncDecision(st(10), 10.01, true).status, "sync");
  const c = syncDecision(st(10.1), 10, true, 1);
  assert.equal(c.status, "correct");
  assert.ok(c.playbackRate < 1, "ahead -> slow down");
  const c2 = syncDecision(st(9.9), 10, true, 2);
  assert.ok(c2.playbackRate > 2, "behind -> speed up relative to master rate");
  const s = syncDecision(st(5), 10, true);
  assert.equal(s.status, "seek");
  assert.equal(s.seekTo, 10);
  const p = syncDecision(st(5, false), 5.5, false);
  assert.equal(p.seekTo, 5.5);
  assert.equal(p.pause, true);
  assert.equal(syncDecision(st(5, true), 5.005, false).status, "sync");
  assert.equal(syncDecision(st(5, true), 5.1, true).play, true);
  // NaN duration (not loaded) treated as open-ended
  assert.equal(syncDecision({ currentTime: 0, paused: true, duration: NaN }, 100, true).status, "seek");
});

test("clock", () => {
  assert.deepEqual(advanceClock(1000, 500, 2, 0, 5000), { time: 2000, playing: true });
  assert.deepEqual(advanceClock(4900, 500, 1, 0, 5000), { time: 5000, playing: false });
});

test("durations and clock format", () => {
  close(parseDuration("00:01:23.5"), 83.5);
  close(parseDuration("1:00"), 60);
  assert.ok(Number.isNaN(parseDuration("")));
  assert.equal(formatClock(Date.UTC(2025, 9, 2, 20, 47, 10, 560)), "20:47:10.5");
});

test("destination distances", () => {
  const lat = 46.2085, lon = 6.149; // pont du Mont-Blanc
  const m = metersPerDegree(lat);
  const n = destination(lat, lon, 0, 100);
  close((n.lat - lat) * m.lat, 100, 1e-6);
  close(n.lon, lon, 1e-12);
  const e = destination(lat, lon, 90, 100);
  close((e.lon - lon) * m.lon, 100, 1e-6);
  // compare against haversine for 300 m at 45°
  const p = destination(lat, lon, 45, 300);
  const R = 6371008.8, r = Math.PI / 180;
  const dlat = (p.lat - lat) * r, dlon = (p.lon - lon) * r;
  const a = Math.sin(dlat / 2) ** 2 + Math.cos(lat * r) * Math.cos(p.lat * r) * Math.sin(dlon / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(a));
  assert.ok(Math.abs(d - 300) < 1, `haversine ${d}`);
});

test("cone polygon", () => {
  const ring = conePolygon(46.2, 6.15, 90, 60, 40, 6);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 6 + 3);
  // all far points east of apex
  ring.slice(1, -1).forEach(([lo]) => assert.ok(lo > 6.15));
});

test("bearing interpolation wraps", () => {
  close(lerpBearing(350, 10, 0.5), 0);
  close(lerpBearing(10, 350, 0.25), 5);
  close(lerpBearing(90, 180, 0.5), 135);
});

test("pose interpolation", () => {
  const track = [
    { t: 0, lat: 46, lon: 6, bearing: 350 },
    { t: 2, lat: 46.002, lon: 6.002, bearing: 10 },
    { t: 10, lat: 46.004, lon: 6.004, bearing: 20 },
  ];
  const p = poseAt(track, 1);
  close(p.lat, 46.001); close(p.lon, 6.001); close(p.bearing, 0);
  assert.equal(p.interpolated_gap, false);
  assert.equal(poseAt(track, 5).interpolated_gap, true);
  assert.equal(poseAt(track, -1).clamped, true);
  close(poseAt(track, 99).lat, 46.004);
  assert.equal(poseAt([], 1), null);
});

test("parse trajectory rows", () => {
  const rows = [
    ["UAR", "t (s)", "Lat", "Lon", "Bearing", "quality"],
    ["GE-2", "1,5", "46.1", "6.1", "90", "ok"],
    ["GE-2", "0.5", "46.0", "6.0", "", "ok"],
    ["", "1", "46", "6", "1", ""],
    ["GE-3", "x", "46", "6", "1", ""],
  ];
  const tr = parseTrajectoryRows(rows);
  assert.deepEqual(Object.keys(tr), ["GE-2"]);
  assert.equal(tr["GE-2"][0].t, 0.5);
  assert.ok(Number.isNaN(tr["GE-2"][0].bearing));
  assert.equal(tr["GE-2"][1].t, 1.5);
});

import { projectRelative, originForPosition, relativeAt, azimuth } from "../src/lib/geo.js";
test("relative trajectories", () => {
  const rows = [["UAR", "t", "x", "y", "heading_rel", "quality"], ["A", "0", "0", "0", "0", ""], ["A", "2", "0", "10", "-90", ""]];
  const tr = parseTrajectoryRows(rows);
  assert.equal(tr.A[1].relative, true);
  const origin = { lat: 46.2, lon: 6.15, bearing: 90 }; // facing east
  const p = projectRelative(origin, tr.A[1]); // 10 m forward = 10 m east, now facing north
  const m = metersPerDegree(46.2);
  close((p.lon - 6.15) * m.lon, 10, 1e-6);
  close(p.lat, 46.2, 1e-9);
  close(p.bearing, 0);
  const mid = relativeAt(tr.A, 1);
  close(mid.y, 5); close(mid.heading_rel, -45);
  // origin that puts the t=2 point on a chosen spot
  const o = originForPosition({ lat: 46.3, lon: 6.2 }, tr.A[1], 90);
  const back = projectRelative({ ...o, bearing: 90 }, tr.A[1]);
  close(back.lat, 46.3, 1e-9); close(back.lon, 6.2, 1e-9);
  close(azimuth({ lat: 46.2, lon: 6.15 }, { lat: 46.2, lon: 6.16 }), 90, 1e-9);
  close(azimuth({ lat: 46.2, lon: 6.15 }, { lat: 46.19, lon: 6.15 }), 180, 1e-9);
});

import { computePoses, pathOf, bearingFromClick, positionFromClick } from "../src/lib/poses.js";
test("poses: static, relative, editing by click", () => {
  const start = new Date(Date.UTC(2026, 5, 14, 17, 0, 0));
  const A = { UAR: "A", lat: 46.2, long: 6.15, bearing: 90, fov: 60, start, end: start.getTime() + 20000 };
  const B = { UAR: "B", lat: 46.2, long: 6.15, bearing: NaN, start, end: start.getTime() + 20000 };
  const C = { UAR: "C", lat: NaN, long: NaN, start };
  const tr = { A: [{ t: 0, x: 0, y: 0, heading_rel: 0, relative: true }, { t: 10, x: 0, y: 10, heading_rel: -90, relative: true }] };
  const poses = computePoses({ A, B, C }, tr, start.getTime() + 10000);
  assert.ok(!poses.C);
  assert.ok(Number.isNaN(poses.B.bearing));
  close(poses.A.bearing, 0);
  assert.ok(poses.A.active);
  const m = metersPerDegree(46.2);
  close((poses.A.lon - 6.15) * m.lon, 10, 1e-6);
  assert.equal(pathOf(A, tr.A).length, 2);
  // override rotates the whole path
  const rot = computePoses({ A }, tr, start.getTime() + 10000, { A: { bearing: 0 } });
  close((rot.A.lat - 46.2) * m.lat, 10, 1e-6);
  // click 50 m south of the camera's CURRENT position at t=10 -> it should look south
  const t10 = start.getTime() + 10000;
  const here = poses.A;
  const click = { lat: here.lat - 50 / m.lat, lon: here.lon };
  const b0 = bearingFromClick(A, tr.A, t10, click);
  const after = computePoses({ A }, tr, t10, { A: { bearing: b0 } }).A;
  // looks at the click from its new position
  const look = azimuth({ lat: after.lat, lon: after.lon }, click);
  assert.ok(Math.abs(((after.bearing - look + 540) % 360) - 180) < 0.2, `${after.bearing} vs ${look}`);
  // position click puts the camera exactly there at that time
  const target = { lat: 46.21, lon: 6.16 };
  const pos = positionFromClick(A, tr.A, t10, target);
  const moved = computePoses({ A }, tr, t10, { A: pos }).A;
  close(moved.lat, 46.21, 1e-6); close(moved.lon, 6.16, 1e-6);
  // static medium: bearing = azimuth from its position
  const S = { UAR: "S", lat: 46.2, long: 6.15, bearing: NaN, start, end: start.getTime() + 1000 };
  close(bearingFromClick(S, undefined, t10, { lat: 46.2, lon: 6.16 }), 90, 0.1);
});
