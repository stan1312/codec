// Choosing the capture (start) time of a video among all the dates it carries.
//
// A video file typically holds several dates that do NOT mean the same thing:
//   - Apple "creationdate"   : start of recording, local time WITH time zone  -> best
//   - camera file names      : start of recording (VID_20260614_191524, PXL_...)
//   - mvhd creation time     : depends on the app; often the time the file was
//                              exported, AirDropped, trimmed or re-encoded
//   - messaging app names    : time the file was RECEIVED (WhatsApp, Signal...)
//   - file modification time : time of copy / sync, rarely the capture
// So "the most recent date" is not a rule: we rank sources by how reliably they
// mean "start of recording", keep only those whose clip falls inside the event
// window, and flag disagreements instead of hiding them.

export const DEFAULT_TZ = "Europe/Zurich";

// ---------------------------------------------------------------- time zones

// offset (ms) of time zone `tz` at UTC instant `ms` (local = utc + offset)
export function tzOffsetMs(ms, tz = DEFAULT_TZ) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// local wall-clock fields in tz -> UTC ms
export function localToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = DEFAULT_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0) + s * 1000;
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz); // second pass for DST edges
  return utc;
}

// UTC ms -> "YYYY-MM-DD HH:MM:SS" (+ ".mmm" if needed) in tz
export function formatLocal(ms, tz = DEFAULT_TZ) {
  const local = ms + tzOffsetMs(ms, tz);
  const d = new Date(local);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  let s =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (d.getUTCMilliseconds()) s += "." + pad(d.getUTCMilliseconds(), 3);
  return s;
}

// "2026-06-14 14:00" / "2026-06-14T14:00:00" (local in tz) -> UTC ms
export function parseLocal(str, tz = DEFAULT_TZ) {
  const m = String(str || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/);
  if (!m) return NaN;
  return localToUtc(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), parseFloat(m[6] || 0), tz);
}

// ISO-like string WITH zone ("2026-06-14T19:19:24+0200", "...Z") -> UTC ms.
// Without zone -> interpreted in tz.
export function parseDateText(text, tz = DEFAULT_TZ) {
  const s = String(text || "").trim();
  const m = s.match(
    /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?$/,
  );
  if (!m) return { ms: NaN, hasZone: false };
  const [, y, mo, d, h, mi, sec, zone] = m;
  const seconds = parseFloat(sec || 0);
  if (zone) {
    let off = 0;
    if (zone !== "Z") {
      const z = zone.replace(":", "");
      off = (z[0] === "-" ? -1 : 1) * (parseInt(z.slice(1, 3)) * 60 + parseInt(z.slice(3, 5))) * 60000;
    }
    return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, 0) + seconds * 1000 - off, hasZone: true };
  }
  return { ms: localToUtc(+y, +mo, +d, +h, +mi, seconds, tz), hasZone: false };
}

// ---------------------------------------------------------------- file names

// Each pattern: what the date in the name means and in which zone it is.
const NAME_PATTERNS = [
  // Google Pixel: PXL_20260614_171924123  -> UTC, start
  { re: /PXL_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(\d{3})?/, zone: "UTC", kind: "start", reliability: 3, label: "nom de fichier Pixel (UTC)" },
  // WhatsApp: "WhatsApp Video 2026-06-14 at 19.20.03" -> time RECEIVED / saved
  { re: /WhatsApp Video (\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})/i, zone: "local", kind: "after", reliability: 1, label: "WhatsApp (heure de réception)" },
  // WhatsApp exported names: VID-20260614-WA0012 -> day of reception only
  { re: /VID-(\d{4})(\d{2})(\d{2})-WA\d+/i, zone: "local", kind: "day_after", reliability: 1, label: "WhatsApp (jour de réception)" },
  // Signal: signal-2026-06-14-192003
  { re: /signal-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/i, zone: "local", kind: "after", reliability: 1, label: "Signal (heure de réception)" },
  // Telegram desktop: video_2026-06-14_19-20-03
  { re: /video_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/i, zone: "local", kind: "after", reliability: 1, label: "Telegram (heure de téléchargement)" },
  // Screen recordings
  { re: /Screen[ _]?Recording[ _](\d{4})-?(\d{2})-?(\d{2})[ _-]?(?:at[ _])?(\d{2})[.:\-]?(\d{2})[.:\-]?(\d{2})/i, zone: "local", kind: "start", reliability: 2, label: "enregistrement d'écran" },
  // Android cameras: VID_20260614_191524, IMG_20260614_191524, 20260614_191524 (Samsung)
  { re: /(?:^|[^0-9])(?:VID|IMG|MVIMG|MOV)?_?(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/i, zone: "local", kind: "start", reliability: 3, label: "nom de fichier appareil photo" },
];

export function datesFromFileName(name, tz = DEFAULT_TZ) {
  const out = [];
  for (const p of NAME_PATTERNS) {
    const m = String(name || "").match(p.re);
    if (!m) continue;
    const [, y, mo, d, h = "0", mi = "0", s = "0", ms3] = m;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) continue;
    const sec = +s + (ms3 ? +ms3 / 1000 : 0);
    const utc = p.zone === "UTC" ? Date.UTC(+y, +mo - 1, +d, +h, +mi, 0) + sec * 1000 : localToUtc(+y, +mo, +d, +h, +mi, sec, tz);
    out.push({ source: "filename", label: p.label, ms: utc, kind: p.kind, reliability: p.reliability });
    break; // first matching pattern wins (ordered from most to least specific)
  }
  return out;
}

// ---------------------------------------------------------------- candidates

// Turn the raw dates of readMediaMeta() into ranked candidates.
export function captureCandidates(meta, tz = DEFAULT_TZ) {
  const isApple = /apple/i.test(meta.make || "") || meta.dates.some((d) => d.source === "apple.creationdate");
  const c = [];
  for (const d of meta.dates) {
    if (d.source === "apple.creationdate") {
      const p = parseDateText(d.text, tz);
      if (Number.isFinite(p.ms))
        c.push({ source: d.source, label: "date de prise de vue Apple", ms: p.ms, kind: "start", reliability: p.hasZone ? 5 : 4 });
    } else if (d.source === "udta.day") {
      const p = parseDateText(d.text, tz);
      if (Number.isFinite(p.ms))
        c.push({ source: d.source, label: "date ©day", ms: p.ms, kind: "start_or_end", reliability: 3 });
    } else if (d.source === "mvhd.creation") {
      // on iPhone originals this is frequently the export/AirDrop time
      c.push({ source: d.source, label: "date de création du conteneur (UTC)", ms: d.ms, kind: "start_or_end", reliability: isApple ? 1 : 2 });
    } else if (d.source === "mvhd.modification") {
      c.push({ source: d.source, label: "date de modification du conteneur", ms: d.ms, kind: "start_or_end", reliability: 1 });
    } else if (d.source === "file.mtime") {
      c.push({ source: d.source, label: "date de modification du fichier", ms: d.ms, kind: "start_or_end", reliability: 0 });
    }
  }
  c.push(...datesFromFileName(meta.file_name, tz));
  return c;
}

// Possible START times implied by a candidate, given the clip duration.
function interpretations(c, dur) {
  const D = Number.isFinite(dur) ? dur * 1000 : 0;
  switch (c.kind) {
    case "start":
      return [{ start: c.ms, how: "début" }];
    case "end":
      return [{ start: c.ms - D, how: "fin - durée" }];
    case "start_or_end":
      return [
        { start: c.ms, how: "si début" },
        { start: c.ms - D, how: "si fin" },
      ];
    default:
      return []; // "after", "day_after": only an upper bound
  }
}

// window: { start: utcMs, end: utcMs } of the event (filming must be inside)
// Returns {
//   start_ms, start_local, source, label, confidence: "haute"|"moyenne"|"basse"|null,
//   status: "ok" | "conflit" | "hors fenêtre" | "aucune date",
//   notes: [..], candidates: [...]   (every date seen, with in_window flag)
// }
export function chooseCaptureTime(meta, window, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const dur = meta.duration;
  const D = Number.isFinite(dur) ? dur * 1000 : 0;
  const slack = (opts.slackSeconds ?? 0) * 1000;
  const cands = captureCandidates(meta, tz);
  const inWindow = (start) =>
    !window || ((!Number.isFinite(window.start) || start >= window.start - slack) && (!Number.isFinite(window.end) || start + D <= window.end + slack));

  const plausible = [];
  for (const c of cands) {
    c.in_window = false;
    for (const it of interpretations(c, dur)) {
      if (inWindow(it.start)) {
        c.in_window = true;
        plausible.push({ ...c, start: it.start, how: it.how });
      }
    }
  }
  // upper bounds from messaging apps: capture must have ENDED before them
  const upper = cands.filter((c) => c.kind === "after" || c.kind === "day_after");

  const notes = [];
  const result = {
    start_ms: null,
    start_local: "",
    source: null,
    label: null,
    confidence: null,
    status: "aucune date",
    notes,
    candidates: cands.map((c) => ({ ...c, local: formatLocal(c.ms, tz) })),
  };

  if (!plausible.length) {
    result.status = cands.some((c) => c.kind !== "after" && c.kind !== "day_after") ? "hors fenêtre" : "aucune date";
    notes.push("aucune date de captation compatible avec la fenêtre de l'événement : à chronolocaliser à la main");
    return result;
  }

  // best = highest reliability; ties -> prefer an explicit "start" over "if start/end"
  plausible.sort(
    (a, b) => b.reliability - a.reliability || (a.kind === "start" ? -1 : 0) - (b.kind === "start" ? -1 : 0),
  );
  const best = plausible[0];
  result.start_ms = best.start;
  result.start_local = formatLocal(best.start, tz);
  result.source = best.source;
  result.label = best.label + (best.how && best.kind !== "start" ? ` (${best.how})` : "");

  // the best source of all (even outside the window) - if it is outside, say so
  const topAll = cands.filter((c) => c.kind !== "after" && c.kind !== "day_after").sort((a, b) => b.reliability - a.reliability)[0];
  if (topAll && topAll.reliability > best.reliability && !topAll.in_window) {
    notes.push(`la source la plus fiable (${topAll.label} : ${formatLocal(topAll.ms, tz)}) est HORS de la fenêtre`);
  }

  // agreement / conflicts among plausible sources of decent reliability
  const others = plausible.filter((p) => p !== best && p.source !== best.source && p.reliability >= 2);
  const conflicting = others.filter((p) => Math.abs(p.start - best.start) > 60000);
  const agreeing = others.filter((p) => Math.abs(p.start - best.start) <= 2000);

  for (const u of upper) {
    const limit = u.kind === "day_after" ? u.ms + 86400000 : u.ms;
    if (best.start + D > limit + 1000) {
      notes.push(`incohérent : la vidéo finirait après ${u.label} (${formatLocal(u.ms, tz)})`);
      conflicting.push(u);
    }
  }

  if (best.reliability >= 4) result.confidence = "haute";
  else if (best.reliability === 3 || (best.reliability === 2 && agreeing.length)) result.confidence = "moyenne";
  else result.confidence = "basse";

  if (conflicting.length && best.reliability < 5) {
    result.status = "conflit";
    for (const c of conflicting) notes.push(`désaccord : ${c.label} → ${formatLocal(c.start ?? c.ms, tz)}`);
  } else {
    result.status = "ok";
    if (conflicting.length) for (const c of conflicting) notes.push(`ignoré : ${c.label} → ${formatLocal(c.start ?? c.ms, tz)}`);
  }
  if (agreeing.length) notes.push(`confirmé par : ${agreeing.map((a) => a.label).join(", ")}`);
  if (result.confidence === "basse") notes.push("date peu fiable : à vérifier sur l'image (horloges, lumière, autres vidéos)");
  return result;
}
