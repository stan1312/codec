import test from "node:test";
import assert from "node:assert/strict";
import { readerFromPath, readMediaMeta } from "../src/lib/mediaMeta.js";
import { chooseCaptureTime, parseLocal, formatLocal, datesFromFileName, parseDateText, tzOffsetMs } from "../src/lib/captureTime.js";

const W = { start: parseLocal("2026-06-14 14:00"), end: parseLocal("2026-06-15 10:00") };
const meta = (over) => ({ file_name: "x.mp4", duration: 20, make: null, dates: [], ...over });

test("time zone helpers (CEST = UTC+2 in June, CET in winter)", () => {
  assert.equal(tzOffsetMs(Date.UTC(2026, 5, 14, 12), "Europe/Zurich"), 2 * 3600e3);
  assert.equal(tzOffsetMs(Date.UTC(2025, 11, 14, 12), "Europe/Zurich"), 3600e3);
  assert.equal(parseLocal("2026-06-14 14:00"), Date.UTC(2026, 5, 14, 12, 0));
  assert.equal(formatLocal(Date.UTC(2026, 5, 14, 17, 19, 24)), "2026-06-14 19:19:24");
  assert.equal(parseDateText("2026-06-14T19:19:24+0200").ms, Date.UTC(2026, 5, 14, 17, 19, 24));
  assert.equal(parseDateText("2026-06-14T17:19:24Z").ms, Date.UTC(2026, 5, 14, 17, 19, 24));
  assert.equal(parseDateText("2026-06-14 19:19:24").hasZone, false);
});

for (const [file, expected] of [["IMG_1518.mov", "2026-06-14 19:19:24"], ["IMG_6491.mov", "2026-06-14 19:15:58"]]) {
  test(`real iPhone file ${file}: Apple creationdate chosen, export dates ignored`, async (t) => {
    const p = "/mnt/user-data/uploads/03_CODEC/videos_test/" + file;
    let r;
    try { r = await readerFromPath(p); } catch { t.skip("file not staged"); return; }
    const m = await readMediaMeta(r); await r.close();
    const res = chooseCaptureTime(m, W);
    assert.equal(res.start_local, expected);
    assert.equal(res.source, "apple.creationdate");
    assert.equal(res.confidence, "haute");
    assert.equal(res.status, "ok");
    // the container date (export/AirDrop, 15-16 June) is outside the window
    assert.equal(res.candidates.find((c) => c.source === "mvhd.creation").in_window, false);
  });
}

test("most recent date is NOT taken: an in-window creationdate wins over later dates", () => {
  const m = meta({
    make: "Apple",
    dates: [
      { source: "apple.creationdate", text: "2026-06-14T21:05:10+0200" },
      { source: "mvhd.creation", ms: Date.UTC(2026, 5, 15, 6, 0, 0) }, // in window, but later & unreliable
      { source: "file.mtime", ms: Date.UTC(2026, 5, 15, 7, 0, 0) },
    ],
  });
  const r = chooseCaptureTime(m, W);
  assert.equal(r.start_local, "2026-06-14 21:05:10");
  assert.equal(r.status, "ok");
});

test("Android: file name start time agrees with mvhd (as end) -> confirmed", () => {
  const start = parseLocal("2026-06-14 22:10:05");
  const m = meta({
    file_name: "VID_20260614_221005.mp4", duration: 30,
    dates: [{ source: "mvhd.creation", ms: start + 30000 }],
  });
  const r = chooseCaptureTime(m, W);
  assert.equal(r.start_local, "2026-06-14 22:10:05");
  assert.equal(r.confidence, "moyenne");
  assert.ok(r.notes.some((n) => n.startsWith("confirmé par")));
});

test("Pixel names are UTC", () => {
  const [d] = datesFromFileName("PXL_20260614_201005123.mp4");
  assert.equal(formatLocal(d.ms), "2026-06-14 22:10:05.123");
});

test("WhatsApp file: only an upper bound -> no date, manual chronolocation", () => {
  const m = meta({ file_name: "WhatsApp Video 2026-06-15 at 08.12.44.mp4", dates: [{ source: "mvhd.creation", ms: Date.UTC(2026, 5, 20, 10) }] });
  const r = chooseCaptureTime(m, W);
  assert.equal(r.start_ms, null);
  assert.equal(r.status, "hors fenêtre");
});

test("conflict between two decent sources is flagged", () => {
  const m = meta({
    file_name: "VID_20260614_200000.mp4",
    dates: [{ source: "udta.day", text: "2026-06-14T23:30:00+0200" }],
  });
  const r = chooseCaptureTime(m, W);
  assert.equal(r.status, "conflit");
  assert.ok(r.notes.some((n) => n.startsWith("désaccord")));
});

test("best source outside the window is reported, window-compatible fallback used", () => {
  const m = meta({
    make: "Apple",
    file_name: "VID_20260614_200000.mp4",
    dates: [{ source: "apple.creationdate", text: "2026-06-12T20:00:00+0200" }], // phone clock wrong?
  });
  const r = chooseCaptureTime(m, W);
  assert.equal(r.start_local, "2026-06-14 20:00:00");
  assert.ok(r.notes.some((n) => n.includes("HORS de la fenêtre")));
});

test("clip must END inside the window too", () => {
  const m = meta({ make: "Apple", duration: 3600, dates: [{ source: "apple.creationdate", text: "2026-06-15T09:30:00+0200" }] });
  assert.equal(chooseCaptureTime(m, W).start_ms, null);
});
