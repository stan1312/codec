// Tests the sheet-write logic against an in-memory fake of the Sheets values API.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === "google-spreadsheet") return { GoogleSpreadsheet: function () {} };
  return origLoad.call(this, req, ...a);
};
const { _internal } = require("../functions/sheet-write.js");
const { handle, colLetter } = _internal;

function letterToCol(s) { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function parseRange(r) {
  const m = r.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/);
  if (!m) throw new Error("bad range " + r);
  return { tab: m[1].replace(/''/g, "'"), c0: letterToCol(m[2]), r0: +m[3] - 1, c1: m[4] ? letterToCol(m[4]) : letterToCol(m[2]), r1: m[5] ? +m[5] - 1 : (m[4] ? Infinity : +m[3] - 1) };
}
function fakeIO(tabs) {
  const grid = (t) => tabs[t];
  const io = {
    calls: [],
    async read(tab, a1) {
      const { c0, r0, c1, r1 } = parseRange(`'${tab}'!${a1}`);
      const g = grid(tab) || [];
      let rows = g.slice(r0, r1 === Infinity ? undefined : r1 + 1).map((r) => (r || []).slice(c0, c1 + 1));
      // API trims trailing empty cells / rows
      rows = rows.map((r) => { const x = r.map((v) => (v === undefined || v === null ? "" : String(v))); while (x.length && x[x.length - 1] === "") x.pop(); return x; });
      while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
      return rows;
    },
    async batchWrite(data) {
      io.calls.push(["write", data.length]);
      for (const { range, values } of data) {
        const { tab, c0, r0 } = parseRange(range);
        const g = grid(tab);
        values.forEach((row, i) => { g[r0 + i] = g[r0 + i] || []; row.forEach((v, j) => (g[r0 + i][c0 + j] = v)); });
      }
    },
    async clear(range) {
      const { tab, c0, r0, c1, r1 } = parseRange(range);
      const g = grid(tab);
      for (let r = r0; r <= r1; r++) if (g[r]) for (let c = c0; c <= c1; c++) g[r][c] = "";
    },
    async ensureGrid() {},
    hasTab: (t) => !!tabs[t],
  };
  return io;
}
const config = () => [
  ["Title of tab with media assets", "media assets"],
  ["Rank of assets row with column names", "2"],
  ["Title of tab with trajectories", "trajectories"],
  ["Rank of trajectories row with column names", "1"],
];

test("colLetter", () => {
  assert.equal(colLetter(0), "A"); assert.equal(colLetter(25), "Z"); assert.equal(colLetter(26), "AA"); assert.equal(colLetter(701), "ZZ");
});

test("add_media appends new UARs only, creates missing columns, never overwrites", async () => {
  const tabs = {
    "Platform config": config(),
    "media assets": [["notes en haut"], ["UAR", "Chronolocation", "Commentaire"], ["IMG_1", "2026-06-14 19:00:00", "manuel"]],
  };
  const io = fakeIO(tabs);
  const r = await handle(io, { action: "add_media", rows: [
    { UAR: "IMG_1", Chronolocation: "WRONG" },
    { UAR: "IMG_2", Chronolocation: "2026-06-14 19:19:24", "Latitude (decimal)": 46.219 },
  ] });
  assert.deepEqual(r, { added: ["IMG_2"], skipped: ["IMG_1"] });
  const g = tabs["media assets"];
  assert.deepEqual(g[1], ["UAR", "Chronolocation", "Commentaire", "Latitude (decimal)"]);
  assert.equal(g[2][1], "2026-06-14 19:19:24".replace("19:19:24", "19:00:00")); // untouched
  assert.deepEqual(g[3], ["IMG_2", "2026-06-14 19:19:24", "", 46.219]);
});

test("update_media sets one cell of the right row, adding the column if needed", async () => {
  const tabs = {
    "Platform config": config(),
    "media assets": [[], ["UAR", "Lat"], ["A", "1"], ["B", "2"]],
  };
  const r = await handle(fakeIO(tabs), { action: "update_media", uar: "B", values: { "Bearing (deg)": 212.5 } });
  assert.equal(r.row, 4);
  assert.deepEqual(tabs["media assets"][1], ["UAR", "Lat", "Bearing (deg)"]);
  assert.equal(tabs["media assets"][3][2], 212.5);
  assert.equal(tabs["media assets"][2][2], undefined);
  await assert.rejects(handle(fakeIO(tabs), { action: "update_media", uar: "Z", values: { x: 1 } }), /not found/);
});

test("replace_trajectory swaps the rows of one UAR and clears leftovers", async () => {
  const tabs = {
    "Platform config": config(),
    trajectories: [["UAR", "t", "x", "y"], ["A", "0", "0", "0"], ["B", "0", "0", "0"], ["A", "1", "1", "1"], ["A", "2", "2", "2"]],
  };
  const r = await handle(fakeIO(tabs), { action: "replace_trajectory", uar: "A", rows: [{ t: 0, x: 0, y: 0, heading_rel: 0 }] });
  assert.deepEqual(r, { uar: "A", rows: 1, removed: 3 });
  const g = tabs.trajectories.map((row) => row.map(String));
  assert.deepEqual(g[0], ["UAR", "t", "x", "y", "heading_rel"]);
  assert.deepEqual(g[1].slice(0, 2), ["B", "0"]);
  assert.deepEqual(g[2], ["A", "0", "0", "0", "0"]);
  assert.ok(g.slice(3).every((row) => row.every((v) => v === "")));
});

test("missing trajectories tab is a clear error", async () => {
  await assert.rejects(handle(fakeIO({ "Platform config": config() }), { action: "replace_trajectory", uar: "A", rows: [] }), /create a tab/);
});

test("handler checks the write key", async () => {
  const { handler } = require("../functions/sheet-write.js");
  delete process.env.CODEC_WRITE_KEY;
  assert.equal((await handler({ httpMethod: "POST", headers: {} })).statusCode, 403);
  process.env.CODEC_WRITE_KEY = "s3cret";
  assert.equal((await handler({ httpMethod: "POST", headers: { "x-codec-key": "nope" } })).statusCode, 401);
  assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
});
