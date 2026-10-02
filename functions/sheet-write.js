// Netlify function: write to the Google Sheet (fork Genève).
//
// POST /.netlify/functions/sheet-write
// headers: x-codec-key: <CODEC_WRITE_KEY>
// body (JSON), one of:
//   { action: "add_media",   rows: [{ UAR, "<column title>": value, ... }] }
//        adds rows for UARs that are not yet in the media tab; existing rows are
//        never modified (manual edits are safe). Missing columns are created.
//   { action: "update_media", uar, values: { "<column title>": value } }
//        sets cells of one existing media row (e.g. the cone bearing).
//   { action: "replace_trajectory", uar, rows: [{ UAR, t, ... }] }
//        replaces every row of that UAR in the trajectories tab.
//
// Only the tabs named in "Platform config" can be written. Values are written
// RAW (no locale re-interpretation of dates). Requires the service account to
// be an EDITOR of the sheet and the CODEC_WRITE_KEY environment variable.

const { GoogleSpreadsheet } = require("google-spreadsheet");

// ------------------------------------------------------------- A1 helpers
function colLetter(n) {
  // 0 -> A
  let s = "";
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

// ------------------------------------------------------------- Sheet IO (real)
function sheetIO(doc) {
  const enc = (r) => encodeURIComponent(r);
  return {
    async read(tab, a1) {
      const res = await doc.axios.get(`/values/${enc(`${q(tab)}!${a1}`)}`);
      return res.data.values || [];
    },
    async batchWrite(data) {
      if (!data.length) return;
      await doc.axios.post(`/values:batchUpdate`, { valueInputOption: "RAW", data });
    },
    async clear(range) {
      await doc.axios.post(`/values/${enc(range)}:clear`, {});
    },
    async ensureGrid(tab, rows, cols) {
      const sheet = doc.sheetsByTitle[tab];
      if (!sheet) throw new Error(`no tab named ${tab}`);
      const gp = sheet.gridProperties;
      if (gp.rowCount < rows || gp.columnCount < cols) {
        await sheet.resize({ rowCount: Math.max(gp.rowCount, rows), columnCount: Math.max(gp.columnCount, cols) });
      }
    },
    hasTab: (tab) => !!doc.sheetsByTitle[tab],
    // show a column as checkboxes (data validation BOOLEAN) from row `fromRow` (1-based) down
    async setCheckbox(tab, colIndex, fromRow) {
      const sheet = doc.sheetsByTitle[tab];
      await doc.axios.post(":batchUpdate", {
        requests: [
          {
            setDataValidation: {
              range: {
                sheetId: sheet.sheetId,
                startRowIndex: fromRow - 1,
                endRowIndex: sheet.gridProperties.rowCount,
                startColumnIndex: colIndex,
                endColumnIndex: colIndex + 1,
              },
              rule: { condition: { type: "BOOLEAN" }, strict: false, showCustomUi: true },
            },
          },
        ],
      });
    },
  };
}

// columns created in this call that must be shown as checkboxes
async function applyCheckboxes(io, table, created, checkboxes) {
  if (!Array.isArray(checkboxes) || !io.setCheckbox) return;
  for (const name of checkboxes) {
    if (!created.includes(name)) continue;
    const c = table.header.indexOf(name);
    if (c >= 0) await io.setCheckbox(table.tab, c, table.headerRow + 1);
  }
}

// ------------------------------------------------------------- core logic
async function readConfig(io) {
  const rows = await io.read("Platform config", "A1:B200");
  const cfg = {};
  for (const r of rows) if (r[0]) cfg[String(r[0]).trim()] = r[1] !== undefined ? String(r[1]).trim() : "";
  return cfg;
}

// table = { tab, headerRow (1-based), header: [...], rows: [[...]] }
async function readTable(io, tab, headerRow) {
  const values = await io.read(tab, `A${headerRow}:ZZ`);
  const header = (values[0] || []).map((h) => String(h).trim());
  return { tab, headerRow, header, rows: values.slice(1) };
}

// make sure the header contains `names`; returns writes needed
function ensureColumns(table, names) {
  const writes = [];
  writes.created = [];
  for (const n of names) {
    if (!table.header.includes(n)) {
      const c = table.header.length;
      table.header.push(n);
      writes.push({ range: `${q(table.tab)}!${colLetter(c)}${table.headerRow}`, values: [[n]] });
      writes.created.push(n);
    }
  }
  return writes;
}

function rowIndexByKey(table, keyCol, key) {
  const k = table.header.indexOf(keyCol);
  if (k < 0) return -1;
  return table.rows.findIndex((r) => String(r[k] ?? "").trim() === String(key).trim());
}

const cell = (v) => (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : v);

async function addMedia(io, cfg, body) {
  const tab = cfg["Title of tab with media assets"];
  const headerRow = parseInt(cfg["Rank of assets row with column names"] || "1", 10) || 1;
  const t = await readTable(io, tab, headerRow);
  const rows = (body.rows || []).filter((r) => r && r.UAR);
  const names = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const writes = ensureColumns(t, ["UAR", ...names]);
  const added = [];
  const skipped = [];
  // first free line after the last non-empty row
  let next = headerRow + 1 + t.rows.length;
  for (const r of rows) {
    if (rowIndexByKey(t, "UAR", r.UAR) >= 0 || added.includes(r.UAR)) {
      skipped.push(r.UAR);
      continue;
    }
    const line = t.header.map((h) => cell(r[h]));
    writes.push({ range: `${q(tab)}!A${next}:${colLetter(t.header.length - 1)}${next}`, values: [line] });
    added.push(r.UAR);
    next++;
  }
  await io.ensureGrid(tab, next, t.header.length);
  const created = writes.created;
  await io.batchWrite(writes);
  await applyCheckboxes(io, t, created, body.checkboxes);
  return { added, skipped };
}

async function updateMedia(io, cfg, body) {
  const tab = cfg["Title of tab with media assets"];
  const headerRow = parseInt(cfg["Rank of assets row with column names"] || "1", 10) || 1;
  const t = await readTable(io, tab, headerRow);
  const i = rowIndexByKey(t, "UAR", body.uar);
  if (i < 0) throw Object.assign(new Error(`UAR ${body.uar} not found`), { status: 404 });
  const values = body.values || {};
  const writes = ensureColumns(t, Object.keys(values));
  const line = headerRow + 1 + i;
  for (const [k, v] of Object.entries(values)) {
    const c = t.header.indexOf(k);
    writes.push({ range: `${q(tab)}!${colLetter(c)}${line}`, values: [[cell(v)]] });
  }
  await io.ensureGrid(tab, line, t.header.length);
  const created = writes.created;
  await io.batchWrite(writes);
  await applyCheckboxes(io, t, created, body.checkboxes);
  return { updated: body.uar, row: line };
}

async function replaceTrajectory(io, cfg, body) {
  const tab = cfg["Title of tab with trajectories"];
  if (!tab) throw Object.assign(new Error("no 'Title of tab with trajectories' in Platform config"), { status: 400 });
  if (!io.hasTab(tab)) throw Object.assign(new Error(`create a tab named '${tab}' first`), { status: 400 });
  const headerRow = parseInt(cfg["Rank of trajectories row with column names"] || "1", 10) || 1;
  const t = await readTable(io, tab, headerRow);
  const rows = (body.rows || []).map((r) => ({ ...r, UAR: body.uar }));
  const names = [...new Set(["UAR", ...rows.flatMap((r) => Object.keys(r))])];
  const writes = ensureColumns(t, names);
  const k = t.header.indexOf("UAR");
  const kept = t.rows.filter((r) => String(r[k] ?? "").trim() !== String(body.uar).trim());
  const fresh = rows.map((r) => t.header.map((h) => cell(r[h])));
  const all = [...kept, ...fresh].map((r) => t.header.map((_, i) => cell(r[i])));
  const first = headerRow + 1;
  const last = first + all.length - 1;
  const oldLast = first + t.rows.length - 1;
  await io.ensureGrid(tab, Math.max(last, oldLast), t.header.length);
  if (oldLast > last) await io.clear(`${q(tab)}!A${last + 1}:${colLetter(t.header.length - 1)}${oldLast}`);
  if (all.length) writes.push({ range: `${q(tab)}!A${first}:${colLetter(t.header.length - 1)}${last}`, values: all });
  await io.batchWrite(writes);
  return { uar: body.uar, rows: fresh.length, removed: t.rows.length - kept.length };
}

async function handle(io, body) {
  const cfg = await readConfig(io);
  if (body.action === "add_media") return addMedia(io, cfg, body);
  if (body.action === "update_media") return updateMedia(io, cfg, body);
  if (body.action === "replace_trajectory") return replaceTrajectory(io, cfg, body);
  throw Object.assign(new Error("unknown action"), { status: 400 });
}

// ------------------------------------------------------------- handler
exports.handler = async (event) => {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(obj),
  });
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const expected = process.env.CODEC_WRITE_KEY;
  if (!expected) return json(403, { error: "writing disabled: set CODEC_WRITE_KEY in Netlify" });
  const given = event.headers && (event.headers["x-codec-key"] || event.headers["X-Codec-Key"]);
  if (given !== expected) return json(401, { error: "wrong write key" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  try {
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_CLIENT_PRIVATE_KEY.replace(/\\n/gm, "\n"),
    });
    await doc.loadInfo();
    return json(200, await handle(sheetIO(doc), body));
  } catch (err) {
    console.log({ err });
    const msg = err && err.response && err.response.data ? JSON.stringify(err.response.data) : String(err);
    return json(err.status || 500, { error: msg });
  }
};

// exported for tests
exports._internal = { handle, colLetter };
