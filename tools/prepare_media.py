#!/usr/bin/env python3
"""
prepare_media.py - make Codec-ready playback copies of original videos.

For every file in INPUT_DIR:
  * SHA-256 of the ORIGINAL (never modified)              -> manifest.csv
  * full ffprobe metadata of the original                 -> metadata/<UAR>.json
  * creation time / GPS tags if they survived             -> manifest.csv
  * variable frame rate detection                         -> manifest.csv
  * playback copy OUTPUT_DIR/<UAR>.mp4:
      - constant frame rate (phones record in variable frame rate, which makes
        side-by-side playback drift)
      - a keyframe every second (fast, exact seeking when scrubbing the timeline)
      - H.264/AAC, max 720p, "faststart" (plays in every browser)

UAR = file name without extension (Codec matches local files on that).
Rename the originals to their UAR first (e.g. GE0210-0042.mov).

Usage
    python3 tools/prepare_media.py originals/ proxies/ [--fps 30] [--height 720]

Then paste the manifest's Duration column into the sheet ("Asset duration").
"""
import argparse
import csv
import hashlib
import json
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".ts"}


def sha256(path, buf=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(buf)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def ffprobe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def is_vfr(path, seconds=20):
    """True if frame durations vary by more than 5 % over the first seconds."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", f"%+{seconds}",
         "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout
    pts = sorted(float(x) for x in out.split() if x.replace(".", "", 1).replace("-", "", 1).isdigit())
    if len(pts) < 10:
        return False
    d = [b - a for a, b in zip(pts, pts[1:]) if b > a]
    mean = sum(d) / len(d)
    sd = (sum((x - mean) ** 2 for x in d) / len(d)) ** 0.5
    return sd / mean > 0.05


def fmt_hms(sec):
    h = int(sec // 3600)
    m = int(sec % 3600 // 60)
    s = sec - h * 3600 - m * 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def frac(s):
    try:
        f = Fraction(s)
        return float(f) if f.denominator else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


def find_tag(meta, *keys):
    tags = dict(meta.get("format", {}).get("tags", {}))
    for st in meta.get("streams", []):
        for k, v in st.get("tags", {}).items():
            tags.setdefault(k, v)
    low = {k.lower(): v for k, v in tags.items()}
    for k in keys:
        if k.lower() in low:
            return low[k.lower()]
    return ""


def make_proxy(src, dst, fps, height):
    vf = f"fps={fps},scale=-2:'min({height},ih)'"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", str(int(round(fps))), "-keyint_min", str(int(round(fps))),
        "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(dst),
    ]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input_dir")
    ap.add_argument("output_dir")
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--skip-existing", action="store_true", help="do not re-encode existing copies")
    args = ap.parse_args()

    src_dir, out_dir = Path(args.input_dir), Path(args.output_dir)
    meta_dir = out_dir / "metadata"
    meta_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in src_dir.iterdir() if p.suffix.lower() in VIDEO_EXT)
    if not files:
        sys.exit(f"no video files in {src_dir}")

    rows = []
    for f in files:
        uar = f.stem
        if "." in uar:
            print(f"WARNING: '{f.name}': Codec cuts names at the first '.', rename it")
        print(f"[{uar}] hashing, probing...")
        digest = sha256(f)
        meta = ffprobe(f)
        (meta_dir / f"{uar}.json").write_text(json.dumps(meta, indent=2))
        v = next((s for s in meta["streams"] if s.get("codec_type") == "video"), {})
        duration = float(meta.get("format", {}).get("duration", 0) or 0)
        r_fps, avg_fps = frac(v.get("r_frame_rate", "0")), frac(v.get("avg_frame_rate", "0"))
        vfr = bool(r_fps and avg_fps and abs(r_fps - avg_fps) / r_fps > 0.01) or is_vfr(f)
        dst = out_dir / f"{uar}.mp4"
        if not (args.skip_existing and dst.exists()):
            print(f"[{uar}] encoding playback copy ({'VFR -> ' if vfr else ''}{args.fps:g} fps CFR)")
            make_proxy(f, dst, args.fps, args.height)
        rows.append({
            "UAR": uar,
            "original_file": f.name,
            "sha256_original": digest,
            "duration": fmt_hms(duration),
            "creation_time": find_tag(meta, "com.apple.quicktime.creationdate", "creation_time"),
            "gps_iso6709": find_tag(meta, "com.apple.quicktime.location.ISO6709", "location", "location-eng"),
            "device": " ".join(x for x in [find_tag(meta, "com.apple.quicktime.make", "make"),
                                           find_tag(meta, "com.apple.quicktime.model", "model")] if x),
            "width": v.get("width", ""),
            "height": v.get("height", ""),
            "fps_nominal": f"{r_fps:.3f}",
            "fps_average": f"{avg_fps:.3f}",
            "variable_frame_rate": "TRUE" if vfr else "FALSE",
            "playback_copy": dst.name,
            "sha256_playback_copy": sha256(dst),
        })

    with open(out_dir / "manifest.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"done: {len(rows)} files -> {out_dir}/manifest.csv")


if __name__ == "__main__":
    main()
