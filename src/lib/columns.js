// Column / tab titles used by the fork, with defaults when the
// "Platform config" tab does not name them (defaults = Codec's template).
export const DEFAULTS = {
  "Title of column used for chronolocation": "Chronolocation (YYYY-MM-DD HH:MM:SS)",
  "Title of column used for duration": "Asset duration (HH:MM:SS)",
  "Title of column used for latitude": "Latitude (decimal)",
  "Title of column used for longitude": "Longitude (decimal)",
  "Title of column used for bearing": "Bearing (deg)",
  "Title of column used for field of view": "FOV (deg)",
  "Title of column used for sync offset": "Sync offset (s)",
  "Title of tab with trajectories": "trajectories",
  "Rank of trajectories row with column names": "1",
};

export function cfgGet(cfg, key) {
  const v = cfg && cfg[key];
  return v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : DEFAULTS[key];
}

// extra informational columns written when videos are added automatically
export const INGEST_COLUMNS = {
  dateSource: "Date source (auto)",
  dateConfidence: "Date confidence (auto)",
  dateNotes: "Date notes (auto)",
  gpsAccuracy: "GPS accuracy (m)",
  device: "Device",
  originalFile: "Original file",
  sha256: "SHA-256 original",
};
