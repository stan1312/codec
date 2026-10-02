#!/usr/bin/env node
// auto_ingest.mjs - add a folder of videos to Codec automatically.
//
// For every video in the folder:
//   1. reads its metadata (same code as the web interface): every date it
//      carries, GPS position, duration, orientation
//   2. chooses the capture time carefully (see src/lib/captureTime.js) inside
//      the event window, and records why
//   3. adds a row to the Google Sheet (existing rows are never modified)
//   4. optionally: playback copies (tools/prepare_media.py)
//   5. optionally: camera trajectory with COLMAP or VGGT, written as a
//      RELATIVE path to the "trajectories" tab. Codec orients it with the
//      bearing you set on the map, so no bearing is needed here.
// A report (every date found, the one chosen, why) is written next to the videos.
//
// Usage
//   node tools/auto_ingest.mjs <videos folder> --site https://your-codec.netlify.app [options]
// Options
//   --key KEY              write key (or environment variable CODEC_WRITE_KEY)
//   --window "2026-06-14 14:00" "2026-06-15 10:00"   event window (local time)
//                          default: "Capture window start/end" or timeline bounds of the sheet
//   --tz Europe/Zurich     time zone of the event
//   --proxies DIR          make playback copies in DIR
//   --trajectory none|colmap|vggt   (default none)
//   --vggt-repo PATH       path to the vggt repository (for --trajectory vggt)
//   --python python3       python executable (the one with numpy / torch)
//   --fps 2                frames per second analysed for trajectories
//   --work DIR             working folder for trajectories (default <folder>/_codec_work)
//   --dry-run              do not write to the sheet
import { readdir, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readerFromPath, readMediaMeta } from "../src/lib/mediaMeta.js";
import { mediaRowFromMeta, uarFromFileName, captureWindow } from "../src/lib/ingest.js";
import { parseLocal, formatLocal, DEFAULT_TZ } from "../src/lib/captureTime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIDEO_EXT = new Set([".mov", ".mp4", ".m4v", ".3gp"]);

function parseArgs(argv) {
  const a = { _: [], trajectory: "none", python: "python3", fps: 2, tz: DEFAULT_TZ };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--site") a.site = next().replace(/\/$/, "");
    else if (k === "--key") a.key = next();
    else if (k === "--window") a.window = [next(), next()];
    else if (k === "--tz") a.tz = next();
    else if (k === "--proxies") a.proxies = next();
    else if (k === "--trajectory") a.trajectory = next();
    else if (k === "--vggt-repo") a.vggtRepo = next();
    else if (k === "--python") a.python = next();
    else if (k === "--fps") a.fps = parseFloat(next());
    else if (k === "--work") a.work = next();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "-h" || k === "--help") a.help = true;
    else a._.push(k);
  }
  return a;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    console.log("  $", cmd, args.join(" "));
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
    p.on("error", reject);
  });
}

async function api(site, key, body) {
  const res = await fetch(`${site}/.netlify/functions/sheet-write`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codec-key": key },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function platformConfig(site) {
  const res = await fetch(`${site}/.netlify/functions/googlesheets?sheet=platformconfig&offset=1`);
  if (!res.ok) throw new Error(`cannot read the Platform config (${res.status})`);
  return res.json();
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function readCsv(file) {
  const txt = await readFile(file, "utf8");
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a._[0] || !a.site) {
    console.log(await readFile(fileURLToPath(import.meta.url), "utf8").then((t) => t.split("\n").slice(1, 33).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")));
    process.exit(a.help ? 0 : 1);
  }
  const dir = path.resolve(a._[0]);
  const key = a.key || process.env.CODEC_WRITE_KEY;
  if (!key && !a.dryRun) throw new Error("no write key: --key or CODEC_WRITE_KEY (or --dry-run)");

  const cfg = await platformConfig(a.site);
  const window = a.window
    ? { start: parseLocal(a.window[0], a.tz), end: parseLocal(a.window[1], a.tz) }
    : captureWindow(cfg, a.tz);
  console.log(`window: ${formatLocal(window.start, a.tz)} -> ${formatLocal(window.end, a.tz)} (${a.tz})`);

  const files = (await readdir(dir)).filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()) && !f.startsWith("."));
  files.sort();
  const report = [];
  const rows = [];
  for (const f of files) {
    const full = path.join(dir, f);
    process.stdout.write(`${f}: `);
    const r = await readerFromPath(full);
    const meta = await readMediaMeta(r);
    await r.close();
    const hash = await sha256(full);
    const info = mediaRowFromMeta(meta, cfg, { window, tz: a.tz, sha256: hash });
    rows.push(info.row);
    const c = info.choice;
    if (path.parse(f).name.includes(".")) console.log(`\n    ! "${f}": Codec coupe le nom au premier "." -> UAR "${info.uar}". Renommez le fichier.`);
    console.log(`${c.start_local || "—"}  [${c.status}${c.confidence ? ", " + c.confidence : ""}] ${c.label || ""}`);
    for (const n of c.notes) console.log("    · " + n);
    for (const cand of c.candidates)
      report.push([info.uar, f, cand.local, cand.label, cand.source, cand.reliability, cand.in_window ? "oui" : "non", cand.source === c.source ? "CHOISIE" : "", c.status, hash]);
    if (!c.candidates.length) report.push([info.uar, f, "", "aucune date", "", "", "", "", c.status, hash]);
  }

  const outDir = a.work ? path.resolve(a.work) : path.join(dir, "_codec_work");
  await mkdir(outDir, { recursive: true });
  const reportFile = path.join(outDir, "rapport_dates.csv");
  const header = ["UAR", "fichier", "date (locale)", "type de date", "source", "fiabilité 0-5", "dans la fenêtre", "choix", "statut", "sha256"];
  await writeFile(reportFile, [header, ...report].map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
  console.log(`report: ${reportFile}`);

  if (!a.dryRun && rows.length) {
    const res = await api(a.site, key, { action: "add_media", rows });
    console.log(`sheet: ${res.added.length} added, ${res.skipped.length} already present (not modified)`);
  }

  if (a.proxies) {
    await run(a.python, [path.join(HERE, "prepare_media.py"), dir, path.resolve(a.proxies), "--skip-existing"]);
  }

  if (a.trajectory !== "none") {
    for (const f of files) {
      const uar = uarFromFileName(f);
      const work = path.join(outDir, uar);
      // prefer the constant-frame-rate playback copy when there is one
      let src = path.join(dir, f);
      if (a.proxies) {
        const proxy = path.join(path.resolve(a.proxies), `${uar}.mp4`);
        if (await stat(proxy).then(() => true, () => false)) src = proxy;
      }
      console.log(`\n== trajectory ${uar} (${a.trajectory})`);
      try {
        await run(a.python, [path.join(HERE, "colmap_track.py"), "frames", src, work, "--fps", String(a.fps)]);
        if (a.trajectory === "colmap") await run(a.python, [path.join(HERE, "colmap_track.py"), "colmap", work]);
        else if (a.trajectory === "vggt")
          await run(a.python, [path.join(HERE, "vggt_poses.py"), work, ...(a.vggtRepo ? ["--vggt-repo", a.vggtRepo] : [])]);
        else throw new Error("--trajectory must be none, colmap or vggt");
        const csvFile = path.join(work, "trajectory.csv");
        await run(a.python, [path.join(HERE, "colmap_track.py"), "georef", work, "--uar", uar, "--relative", "--smooth", "3", "-o", csvFile]);
        const traj = (await readCsv(csvFile)).map((r) => ({
          t: parseFloat(r.t),
          x: parseFloat(r.x),
          y: parseFloat(r.y),
          heading_rel: r.heading_rel === "" ? "" : parseFloat(r.heading_rel),
          quality: r.quality,
        }));
        if (!a.dryRun) {
          const res = await api(a.site, key, { action: "replace_trajectory", uar, rows: traj });
          console.log(`sheet: trajectory ${uar}: ${res.rows} rows`);
        }
      } catch (e) {
        console.log(`!! ${uar}: trajectory failed (${e.message}) - continuing`);
      }
    }
  }
}

main().catch((e) => {
  console.error("error:", e.message);
  process.exit(1);
});
