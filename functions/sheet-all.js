// Netlify function: everything the platform needs from the Google Sheet in
// ONE call (fork Genève). Replaces the 4 calls per refresh to googlesheets.js,
// which used ~8 "read requests" each time and hit Google's quota
// (60 read requests per minute) as soon as two people had the platform open.
//
// GET /.netlify/functions/sheet-all
// -> { config: {key: value}, media: [[header...], [row...]...], events: [...], trajectories: [...] }
// Rows are formatted values (as displayed), starting with the header row,
// rows whose first cell is empty are dropped (same as googlesheets.js).

const { GoogleSpreadsheet } = require("google-spreadsheet");

const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

// short in-memory cache: several viewers refreshing at the same time share one read
let cache = { at: 0, body: null };
const CACHE_MS = 4000;

function rowsFrom(values) {
  if (!values || !values.length) return [];
  const [header, ...rest] = values;
  return [header, ...rest.filter((r) => r && r[0] !== undefined && String(r[0]) !== "")];
}

exports.handler = async () => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if (cache.body && Date.now() - cache.at < CACHE_MS) return { statusCode: 200, headers, body: cache.body };
  try {
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_CLIENT_PRIVATE_KEY.replace(/\\n/gm, "\n"),
    });
    // 1st read: the platform config (tab names, header rows)
    const cfgRes = await doc.axios.get(`/values/${encodeURIComponent(`'Platform config'!A1:B300`)}`);
    const config = {};
    for (const r of cfgRes.data.values || []) {
      if (r[0] !== undefined && String(r[0]).trim() !== "") config[String(r[0]).trim()] = r[1] !== undefined ? String(r[1]) : "";
    }
    const want = [
      ["media", config["Title of tab with media assets"], config["Rank of assets row with column names"]],
      ["events", config["Title of tab with events"], config["Rank of events row with column names"]],
      ["trajectories", config["Title of tab with trajectories"] || "trajectories", config["Rank of trajectories row with column names"]],
    ].filter(([, tab]) => tab);
    // 2nd read: all tabs at once. A missing tab makes the whole batch fail,
    // so on error we retry without the optional trajectories tab.
    const batch = async (list) => {
      const params = new URLSearchParams();
      for (const [, tab, rank] of list) params.append("ranges", `${q(tab)}!A${parseInt(rank || "1", 10) || 1}:ZZ`);
      const res = await doc.axios.get(`/values:batchGet?${params.toString()}`);
      const out = {};
      list.forEach(([key], i) => (out[key] = rowsFrom(res.data.valueRanges[i].values)));
      return out;
    };
    let tabs;
    try {
      tabs = await batch(want);
    } catch (err) {
      if (err.response && err.response.status === 400) tabs = await batch(want.filter(([k]) => k !== "trajectories"));
      else throw err;
    }
    const body = JSON.stringify({ config, media: [], events: [], trajectories: [], ...tabs });
    cache = { at: Date.now(), body };
    return { statusCode: 200, headers, body };
  } catch (err) {
    const status = err.response ? err.response.status : 500;
    const msg = err.response && err.response.data ? JSON.stringify(err.response.data) : String(err);
    console.log({ err: msg });
    return { statusCode: status === 429 ? 429 : 500, headers, body: JSON.stringify({ error: msg }) };
  }
};
