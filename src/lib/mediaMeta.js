// Minimal QuickTime / MP4 metadata reader, framework-free.
// Works in the browser (File) and in Node (fs file handle) through a small
// "reader" interface: { size, read(offset, length) -> Promise<Uint8Array> }.
//
// It only reads the box headers and the 'moov' box (a few hundred KB at most),
// never the video data, so it is fast even on multi-GB files.
//
// Extracted:
//   duration (s), width/height as displayed (rotation applied), rotation
//   make, model, software
//   location {lat, lon, alt, accuracy_m, source}
//   timestamps: every date found, with where it came from (see captureTime.js)

const QT_EPOCH_OFFSET_S = 2082844800; // seconds between 1904-01-01 and 1970-01-01

export function readerFromFile(file) {
  return {
    size: file.size,
    name: file.name,
    lastModified: file.lastModified,
    async read(offset, length) {
      const buf = await file.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

export async function readerFromPath(path) {
  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const fh = await fs.open(path, "r");
  const st = await fh.stat();
  return {
    size: st.size,
    name: pathMod.basename(path),
    lastModified: st.mtimeMs,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, st.size - offset));
      const b = Buffer.alloc(len);
      await fh.read(b, 0, len, offset);
      return new Uint8Array(b.buffer, b.byteOffset, len);
    },
    close: () => fh.close(),
  };
}

const td = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
function str(u8, a, b) {
  return td ? td.decode(u8.subarray(a, b)) : Buffer.from(u8.subarray(a, b)).toString("utf8");
}
function fourcc(u8, a) {
  return String.fromCharCode(u8[a], u8[a + 1], u8[a + 2], u8[a + 3]);
}
function u32(dv, a) {
  return dv.getUint32(a);
}
function u64(dv, a) {
  return dv.getUint32(a) * 4294967296 + dv.getUint32(a + 4);
}

// iterate child boxes in u8[start, end)
function* boxes(u8, dv, start, end) {
  let off = start;
  while (off + 8 <= end) {
    let size = u32(dv, off);
    const type = fourcc(u8, off + 4);
    let header = 8;
    if (size === 1) {
      size = u64(dv, off + 8);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) return;
    yield { type, start: off, body: off + header, end: off + size };
    off += size;
  }
}

function find(u8, dv, start, end, type) {
  for (const b of boxes(u8, dv, start, end)) if (b.type === type) return b;
  return null;
}

// Locate the moov box by walking the top-level boxes (moov can be at the end)
async function loadMoov(reader) {
  let off = 0;
  while (off + 8 <= reader.size) {
    const h = await reader.read(off, 16);
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = u64(dv, 8);
    else if (size === 0) size = reader.size - off;
    if (size < 8) break;
    if (type === "moov") {
      if (size > 64 * 1024 * 1024) throw new Error("moov box too large");
      return { u8: await reader.read(off, size), base: off };
    }
    off += size;
  }
  return null;
}

function qtDate(seconds) {
  if (!seconds) return null;
  const ms = (seconds - QT_EPOCH_OFFSET_S) * 1000;
  // ignore obviously unset dates (before 2000)
  if (ms < Date.UTC(2000, 0, 1)) return null;
  return ms;
}

// ISO 6709 "+46.2190+006.1490+417.373/" -> {lat, lon, alt}
export function parseISO6709(s) {
  if (!s) return null;
  const m = String(s).match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, alt: m[3] ? parseFloat(m[3]) : null, decimals: (m[1].split(".")[1] || "").length };
}

// Apple 'mdta' keys + ilst
function readKeysIlst(u8, dv, meta) {
  const out = {};
  // QuickTime meta is not a full box; ISO meta (in udta) is (4 bytes version/flags)
  let start = meta.body;
  if (fourcc(u8, start + 4) !== "hdlr") start += 4;
  const keys = find(u8, dv, start, meta.end, "keys");
  const ilst = find(u8, dv, start, meta.end, "ilst");
  if (!ilst) return out;
  const names = [];
  if (keys) {
    const count = u32(dv, keys.body + 4);
    let off = keys.body + 8;
    for (let i = 0; i < count && off + 8 <= keys.end; i++) {
      const sz = u32(dv, off);
      names.push(str(u8, off + 8, off + sz));
      off += sz;
    }
  }
  for (const item of boxes(u8, dv, ilst.body, ilst.end)) {
    // item type is either a 1-based key index (mdta) or a fourcc like '©day'
    const idx = u32(dv, item.start + 4);
    let name = keys && idx >= 1 && idx <= names.length ? names[idx - 1] : fourcc(u8, item.start + 4);
    const data = find(u8, dv, item.body, item.end, "data");
    if (!data) continue;
    const typeCode = u32(dv, data.body) & 0xffffff;
    const vStart = data.body + 8;
    let value;
    if (typeCode === 1 || typeCode === 0) value = str(u8, vStart, data.end); // UTF-8
    else if (typeCode === 23) value = dv.getFloat32(vStart);
    else if (typeCode === 24) value = dv.getFloat64(vStart);
    else if (typeCode === 21 || typeCode === 22) {
      const n = data.end - vStart;
      value = n === 1 ? dv.getInt8(vStart) : n === 2 ? dv.getInt16(vStart) : n === 4 ? dv.getInt32(vStart) : null;
    } else continue;
    out[name] = value;
  }
  return out;
}

// udta children like '©xyz', '©day' (QuickTime "international text" atoms)
function readUdtaText(u8, dv, udta) {
  const out = {};
  for (const b of boxes(u8, dv, udta.body, udta.end)) {
    if (b.type.charCodeAt(0) === 0xa9 && b.end - b.body > 4) {
      const len = dv.getUint16(b.body);
      if (len > 0 && b.body + 4 + len <= b.end) out[b.type] = str(u8, b.body + 4, b.body + 4 + len);
    }
    if (b.type === "meta") Object.assign(out, readKeysIlst(u8, dv, b));
  }
  return out;
}

export async function readMediaMeta(reader) {
  const res = {
    file_name: reader.name,
    file_size: reader.size,
    file_mtime: Number.isFinite(reader.lastModified) ? reader.lastModified : null,
    duration: NaN,
    width: null,
    height: null,
    rotation: 0,
    make: null,
    model: null,
    software: null,
    location: null,
    tags: {},
    dates: [], // {source, ms?, text?, tz?}
    error: null,
  };
  try {
    const moov = await loadMoov(reader);
    if (!moov) {
      res.error = "no moov box (not a QuickTime/MP4 file?)";
      return res;
    }
    const u8 = moov.u8;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const top = { body: 8, end: u8.byteLength };

    const mvhd = find(u8, dv, top.body, top.end, "mvhd");
    if (mvhd) {
      const v = u8[mvhd.body];
      let c, m, ts, d;
      if (v === 1) {
        c = u64(dv, mvhd.body + 4);
        m = u64(dv, mvhd.body + 12);
        ts = u32(dv, mvhd.body + 20);
        d = u64(dv, mvhd.body + 24);
      } else {
        c = u32(dv, mvhd.body + 4);
        m = u32(dv, mvhd.body + 8);
        ts = u32(dv, mvhd.body + 12);
        d = u32(dv, mvhd.body + 16);
      }
      if (ts) res.duration = d / ts;
      const cms = qtDate(c);
      const mms = qtDate(m);
      if (cms) res.dates.push({ source: "mvhd.creation", ms: cms });
      if (mms && mms !== cms) res.dates.push({ source: "mvhd.modification", ms: mms });
    }

    for (const trak of boxes(u8, dv, top.body, top.end)) {
      if (trak.type !== "trak") continue;
      const mdia = find(u8, dv, trak.body, trak.end, "mdia");
      const hdlr = mdia && find(u8, dv, mdia.body, mdia.end, "hdlr");
      const handler = hdlr ? fourcc(u8, hdlr.body + 8) : "";
      if (handler !== "vide") continue;
      const tkhd = find(u8, dv, trak.body, trak.end, "tkhd");
      if (tkhd && res.width === null) {
        const v = u8[tkhd.body];
        const mOff = tkhd.body + (v === 1 ? 52 : 40);
        const a = dv.getInt32(mOff) / 65536;
        const b = dv.getInt32(mOff + 4) / 65536;
        const w = dv.getUint32(mOff + 36) / 65536;
        const h = dv.getUint32(mOff + 40) / 65536;
        let rot = Math.round((Math.atan2(b, a) * 180) / Math.PI);
        rot = ((rot % 360) + 360) % 360;
        res.rotation = rot;
        const swap = rot === 90 || rot === 270;
        res.width = Math.round(swap ? h : w);
        res.height = Math.round(swap ? w : h);
      }
    }

    // Apple QuickTime metadata (moov/meta) and udta
    const meta = find(u8, dv, top.body, top.end, "meta");
    if (meta) Object.assign(res.tags, readKeysIlst(u8, dv, meta));
    const udta = find(u8, dv, top.body, top.end, "udta");
    if (udta) Object.assign(res.tags, readUdtaText(u8, dv, udta));

    const t = res.tags;
    res.make = t["com.apple.quicktime.make"] || t["©mak"] || null;
    res.model = t["com.apple.quicktime.model"] || t["©mod"] || null;
    res.software = t["com.apple.quicktime.software"] || t["©swr"] || null;

    if (t["com.apple.quicktime.creationdate"]) {
      res.dates.push({ source: "apple.creationdate", text: String(t["com.apple.quicktime.creationdate"]) });
    }
    if (t["©day"]) res.dates.push({ source: "udta.day", text: String(t["©day"]) });

    const loc = parseISO6709(t["com.apple.quicktime.location.ISO6709"]) || parseISO6709(t["©xyz"]);
    if (loc) {
      const acc = parseFloat(t["com.apple.quicktime.location.accuracy.horizontal"]);
      res.location = {
        ...loc,
        accuracy_m: Number.isFinite(acc) ? acc : null,
        source: t["com.apple.quicktime.location.ISO6709"] ? "apple.ISO6709" : "udta.xyz",
      };
    }
  } catch (e) {
    res.error = String(e && e.message ? e.message : e);
  }
  if (res.file_mtime) res.dates.push({ source: "file.mtime", ms: res.file_mtime });
  return res;
}

// Rough horizontal field of view for phone videos when nothing better is known:
// main camera ~26 mm equivalent, 16:9 frame. Landscape ~69 deg, portrait ~43 deg.
export function estimateFov(meta) {
  if (!meta || !meta.width || !meta.height) return null;
  const f = 26;
  const landscape = meta.width >= meta.height;
  const sensorW = landscape ? 36 : 20.25;
  return Math.round((2 * Math.atan(sensorW / 2 / f) * 180) / Math.PI);
}
