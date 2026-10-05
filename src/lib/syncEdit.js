// Editing the synchronisation of videos (fork Genève).
// Every tool (exact start time, drag on the timeline, nudges, "caler ici",
// "synchroniser 2 vidéos") goes through setSyncOffset():
//   - the video moves at once on the timeline, the map and the players
//     (media_store is updated in place),
//   - the "Sync offset (s)" column of the sheet is written (debounced),
//   - the chronolocation written in the sheet is never touched: effective
//     start = chronolocation + Sync offset.
import { writable, get } from "svelte/store";
import { media_store, platform_config_store, sheet_refresh } from "../stores/store";
import { sheetWrite, friendlyError } from "./sheetClient";
import { cfgGet } from "./columns";

// offsets set here and not yet visible in the sheet: { UAR: seconds }
export const sync_overrides = writable({});
// save status per video: { UAR: "…" | "enregistré" | error message }
export const sync_save = writable({});
// undo history: [{ uar, before, after }]
export const sync_history = writable([]);

// UI state of the sync tools
export const sync_panel_open = writable(false);
export const drag_unlocked = writable(false); // videos can be dragged on the timeline
export const drag_info = writable(null); // { uar, start, offset } while dragging

export const offsetOf = (m) => (m && Number.isFinite(m.sync_offset) ? m.sync_offset : 0);
export const hasChrono = (m) => m && m.start instanceof Date && !isNaN(m.start) && m.start_raw instanceof Date;

// move a medium (copy) so that its effective start = start_raw + offset
export function placeMedium(m, offset) {
  if (!hasChrono(m)) return m;
  const dur = new Date(m.end).getTime() - m.start.getTime();
  const start = new Date(m.start_raw.getTime() + offset * 1000);
  const end = new Date(start.getTime() + (Number.isFinite(dur) ? dur : 0));
  return { ...m, sync_offset: offset, start, end, end_date_time: end };
}

// Called by App when the sheet is (re)read: an override wins until the sheet
// shows the same value. Returns the offset to use.
export function resolveOffset(uar, sheetOffset) {
  const o = get(sync_overrides)[uar];
  if (!Number.isFinite(o)) return sheetOffset;
  if (Math.abs(o - sheetOffset) < 0.0005) {
    sync_overrides.update((s) => {
      const c = { ...s };
      delete c[uar];
      return c;
    });
    return sheetOffset;
  }
  return o;
}

const timers = {};

export function setSyncOffset(uar, offset, { record = true } = {}) {
  offset = Math.round(offset * 1000) / 1000;
  if (!Number.isFinite(offset)) return;
  const m = get(media_store)[uar];
  if (!hasChrono(m)) return;
  const before = offsetOf(m);
  if (Math.abs(before - offset) < 0.0005) return;
  if (record) sync_history.update((h) => [...h.slice(-49), { uar, before, after: offset }]);
  sync_overrides.update((s) => ({ ...s, [uar]: offset }));
  media_store.update((s) => ({ ...s, [uar]: placeMedium(s[uar], offset) }));
  sync_save.update((s) => ({ ...s, [uar]: "…" }));
  clearTimeout(timers[uar]);
  timers[uar] = setTimeout(async () => {
    const col = cfgGet(get(platform_config_store), "Title of column used for sync offset");
    const value = get(sync_overrides)[uar];
    try {
      await sheetWrite({ action: "update_media", uar, values: { [col]: value } });
      sync_save.update((s) => ({ ...s, [uar]: "enregistré" }));
      sheet_refresh.update((n) => n + 1);
    } catch (e) {
      sync_save.update((s) => ({ ...s, [uar]: friendlyError(e) }));
    }
  }, 700);
}

// make the video start exactly at startMs
export function setStartTime(uar, startMs) {
  const m = get(media_store)[uar];
  if (!hasChrono(m) || !Number.isFinite(startMs)) return false;
  setSyncOffset(uar, Math.round(startMs - m.start_raw.getTime()) / 1000);
  return true;
}

export function undoSync() {
  const h = get(sync_history);
  if (!h.length) return;
  const last = h[h.length - 1];
  sync_history.set(h.slice(0, -1));
  setSyncOffset(last.uar, last.before, { record: false });
}
