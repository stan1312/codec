#!/usr/bin/env python3
"""
colmap_track.py - camera trajectory of a video, from COLMAP, projected on the map.

Turns one video into rows for Codec's "trajectories" tab:
    UAR, t (s), lat, lon, bearing (deg), quality

Pipeline
    1. frames   : extract images from the video at N fps (+ frames.csv: image -> t)
    2. colmap   : run COLMAP (feature_extractor, sequential_matcher, mapper)
    3. georef   : read the reconstruction, put it on the map using
                  - the geolocation + bearing of the FIRST image (from the sheet), and
                  - a scale: from a 2nd anchor point (recommended), from --scale,
                    or estimated from the camera height above the ground (approximate)
    all         : 1 + 2 + 3

Requirements: python3 + numpy, ffmpeg, COLMAP (https://colmap.github.io) in the PATH.
COLMAP has no idea where north or the metre is: the reconstruction is in an
arbitrary frame. Everything that ties it to the map comes from the anchors you
give, so the result is only as good as those anchors.

Examples
    python3 tools/colmap_track.py all GE0210-0042.mp4 work/0042 \\
        --uar GE0210-0042 --lat 46.20851 --lon 6.14912 --bearing 205 \\
        --anchor 38.5,46.20790,6.14870 -o work/0042/trajectory.csv

    # only re-run the georeferencing with another anchor
    python3 tools/colmap_track.py georef work/0042 --uar GE0210-0042 \\
        --lat 46.20851 --lon 6.14912 --bearing 205 --camera-height 1.5 -o out.csv
"""
import argparse
import csv
import math
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

# --------------------------------------------------------------------------
# 1. frames
# --------------------------------------------------------------------------


def extract_frames(video, workdir, fps=3.0, max_size=1600):
    """Extract about `fps` frames per second and record the EXACT timestamp of
    each extracted frame (from ffmpeg's showinfo), so that trajectory times match
    the video to the frame."""
    import re
    workdir = Path(workdir)
    img_dir = workdir / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    for f in img_dir.glob("*.jpg"):
        f.unlink()
    step = 1.0 / fps - 0.002
    vf = (f"select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,{step:.4f})',"
          f"showinfo,scale='min({max_size},iw)':-2")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "info", "-i", str(video),
        "-vf", vf, "-fps_mode", "vfr", "-q:v", "2", "-start_number", "0",
        str(img_dir / "frame_%06d.jpg"),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 and "fps_mode" in res.stderr:
        cmd[cmd.index("-fps_mode")] = "-vsync"  # ffmpeg < 5.1
        res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(res.stderr[-2000:])
    times = [float(m) for m in re.findall(r"Parsed_showinfo.*?pts_time:\s*([-0-9.e]+)", res.stderr)]
    names = sorted(p.name for p in img_dir.glob("frame_*.jpg"))
    if len(times) != len(names):
        sys.exit(f"frame/timestamp mismatch ({len(names)} images, {len(times)} timestamps)")
    t0 = times[0] if times else 0.0  # files whose first pts is not 0
    with open(workdir / "frames.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["image", "t"])
        for name, t in zip(names, times):
            w.writerow([name, f"{t - t0:.4f}"])
    print(f"[frames] {len(names)} images (~{fps} fps) -> {img_dir}")
    return names


# --------------------------------------------------------------------------
# 2. COLMAP
# --------------------------------------------------------------------------


def run_colmap(workdir, colmap_bin="colmap", use_gpu=False, camera_model="SIMPLE_RADIAL", overlap=15):
    workdir = Path(workdir)
    exe = shutil.which(colmap_bin) or colmap_bin
    if not shutil.which(exe) and not Path(exe).exists():
        sys.exit(f"COLMAP not found ('{colmap_bin}'). Install it (https://colmap.github.io/install.html) "
                 "or pass --colmap-bin /path/to/colmap")
    db = workdir / "database.db"
    if db.exists():
        db.unlink()
    sparse = workdir / "sparse"
    if sparse.exists():
        shutil.rmtree(sparse)
    sparse.mkdir(parents=True)
    gpu = "1" if use_gpu else "0"

    def run(args):
        print("[colmap]", " ".join(args))
        try:
            subprocess.run([exe] + args, check=True)
        except subprocess.CalledProcessError:
            # option names differ between COLMAP versions (e.g. SiftExtraction.* vs
            # FeatureExtraction.*): retry without the GPU switch, COLMAP's default
            stripped = []
            skip = False
            for x in args:
                if skip:
                    skip = False
                    continue
                if x.endswith(".use_gpu"):
                    skip = True
                    continue
                stripped.append(x)
            if stripped == args:
                raise
            print("[colmap] retrying without the GPU option:", " ".join(stripped))
            subprocess.run([exe] + stripped, check=True)

    run(["feature_extractor", "--database_path", str(db), "--image_path", str(workdir / "images"),
         "--ImageReader.single_camera", "1", "--ImageReader.camera_model", camera_model,
         "--SiftExtraction.use_gpu", gpu])
    run(["sequential_matcher", "--database_path", str(db),
         "--SequentialMatching.overlap", str(overlap), "--SiftMatching.use_gpu", gpu])
    run(["mapper", "--database_path", str(db), "--image_path", str(workdir / "images"),
         "--output_path", str(sparse)])


# --------------------------------------------------------------------------
# reading COLMAP models (binary or text)
# --------------------------------------------------------------------------


def qvec2rotmat(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * z * x + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * z * x - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


def _read(fh, fmt):
    size = struct.calcsize("<" + fmt)
    return struct.unpack("<" + fmt, fh.read(size))


def read_images_bin(path):
    images = {}
    with open(path, "rb") as fh:
        (n,) = _read(fh, "Q")
        for _ in range(n):
            image_id, qw, qx, qy, qz, tx, ty, tz, cam_id = _read(fh, "IdddddddI")
            name = b""
            while True:
                c = fh.read(1)
                if c == b"\x00":
                    break
                name += c
            (n2d,) = _read(fh, "Q")
            fh.seek(n2d * 24, 1)  # x, y (double) + point3D_id (int64)
            images[image_id] = (name.decode("utf-8"), np.array([qw, qx, qy, qz]), np.array([tx, ty, tz]))
    return images


def read_points_bin(path):
    pts = []
    with open(path, "rb") as fh:
        (n,) = _read(fh, "Q")
        for _ in range(n):
            _pid, x, y, z, _r, _g, _b, _err = _read(fh, "QdddBBBd")
            (tl,) = _read(fh, "Q")
            fh.seek(tl * 8, 1)
            pts.append((x, y, z))
    return np.array(pts).reshape(-1, 3)


def read_images_txt(path):
    images = {}
    with open(path) as fh:
        lines = [ln for ln in fh if not ln.startswith("#")]
    for i in range(0, len(lines), 2):
        el = lines[i].split()
        if len(el) < 10:
            continue
        image_id = int(el[0])
        q = np.array(list(map(float, el[1:5])))
        t = np.array(list(map(float, el[5:8])))
        images[image_id] = (el[9], q, t)
    return images


def read_points_txt(path):
    pts = []
    with open(path) as fh:
        for ln in fh:
            if ln.startswith("#") or not ln.strip():
                continue
            el = ln.split()
            pts.append(tuple(map(float, el[1:4])))
    return np.array(pts).reshape(-1, 3)


def read_model(model_dir):
    model_dir = Path(model_dir)
    if (model_dir / "images.bin").exists():
        imgs = read_images_bin(model_dir / "images.bin")
        pts = read_points_bin(model_dir / "points3D.bin") if (model_dir / "points3D.bin").exists() else np.zeros((0, 3))
    elif (model_dir / "images.txt").exists():
        imgs = read_images_txt(model_dir / "images.txt")
        pts = read_points_txt(model_dir / "points3D.txt") if (model_dir / "points3D.txt").exists() else np.zeros((0, 3))
    else:
        raise FileNotFoundError(f"no COLMAP model in {model_dir}")
    return imgs, pts


def pick_model(workdir):
    """The largest reconstruction in workdir/sparse/* (COLMAP may split a video in several)."""
    workdir = Path(workdir)
    sparse = workdir / "sparse"
    candidates = [d for d in sorted(sparse.iterdir()) if d.is_dir()] if sparse.exists() else []
    if not candidates and ((sparse / "images.bin").exists() or (sparse / "images.txt").exists()):
        candidates = [sparse]
    best = None
    for d in candidates:
        try:
            imgs, pts = read_model(d)
        except FileNotFoundError:
            continue
        if best is None or len(imgs) > len(best[1]):
            best = (d, imgs, pts)
    if best is None:
        sys.exit(f"no reconstruction found in {sparse} - did COLMAP succeed?")
    if len(candidates) > 1:
        print(f"[georef] {len(candidates)} reconstructions, using the largest: {best[0]} ({len(best[1])} images)")
    return best


# --------------------------------------------------------------------------
# 3. georeferencing
# --------------------------------------------------------------------------


def meters_per_degree(lat):
    p = math.radians(lat)
    return (111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p),
            111412.84 * math.cos(p) - 93.5 * math.cos(3 * p))


def latlon_to_en(lat, lon, lat0, lon0):
    mlat, mlon = meters_per_degree(lat0)
    return (lon - lon0) * mlon, (lat - lat0) * mlat


def en_to_latlon(e, n, lat0, lon0):
    mlat, mlon = meters_per_degree(lat0)
    return lat0 + n / mlat, lon0 + e / mlon


def normalize(v):
    return v / np.linalg.norm(v)


def camera_poses(images, frame_times):
    """-> sorted list of dict(t, C (centre), fwd, up) in the model frame."""
    poses = []
    for name, q, tvec in images.values():
        if name not in frame_times:
            continue
        R = qvec2rotmat(q)
        C = -R.T @ tvec
        poses.append({
            "name": name,
            "t": frame_times[name],
            "C": C,
            "fwd": R.T @ np.array([0.0, 0.0, 1.0]),   # camera looks along +Z
            "up": R.T @ np.array([0.0, -1.0, 0.0]),   # image up is -Y
        })
    poses.sort(key=lambda p: p["t"])
    return poses


def estimate_up(poses):
    """World 'up' = mean of the cameras' image-up vectors (handheld, mostly upright videos)."""
    u = normalize(np.mean([p["up"] for p in poses], axis=0))
    spread = float(np.mean([np.dot(p["up"], u) for p in poses]))
    return u, spread


def horizontal_basis(u, fwd0):
    """a = forward of the first frame projected on the horizontal plane, r = its right."""
    h = fwd0 - np.dot(fwd0, u) * u
    if np.linalg.norm(h) < 1e-6:
        sys.exit("first frame looks straight up/down: cannot define its bearing")
    a = normalize(h)
    r = np.cross(a, u)
    return a, r


def heading_in_basis(v, a, r, u):
    h = v - np.dot(v, u) * u
    if np.linalg.norm(h) < 1e-9:
        return float("nan")
    return math.degrees(math.atan2(np.dot(h, r), np.dot(h, a)))


def fit_similarity_2d(src, dst):
    """Least-squares z = c*w + t with complex numbers (rotation + uniform scale, no reflection)."""
    w = src[:, 0] + 1j * src[:, 1]
    z = dst[:, 0] + 1j * dst[:, 1]
    wm, zm = w.mean(), z.mean()
    c = np.sum((z - zm) * np.conj(w - wm)) / np.sum(np.abs(w - wm) ** 2)
    t = zm - c * wm
    resid = np.abs(c * w + t - z)
    return c, t, resid


def fit_ground_plane(poses, points, u, max_tilt_deg=25.0, iters=400, seed=0):
    """RANSAC plane through the 3D points below the cameras, roughly perpendicular to u.

    Returns (normal oriented like u, offset d with n.X = d, n_inliers) or None.
    The ground normal is a better 'up' than the mean camera up vector, which is
    biased by the usual downward tilt of handheld phones.
    """
    if len(points) < 50:
        return None
    rng = np.random.default_rng(seed)
    C = np.array([p["C"] for p in poses])
    c_mean = C.mean(axis=0)
    h_cam = np.median((C - c_mean) @ u)
    cand = points[((points - c_mean) @ u) < h_cam]
    if len(cand) < 50:
        return None
    if len(cand) > 20000:
        cand = cand[rng.choice(len(cand), 20000, replace=False)]
    scale_ref = np.median(np.linalg.norm(cand - c_mean, axis=1))
    thr = 0.01 * scale_ref
    cos_tilt = math.cos(math.radians(max_tilt_deg))
    best = (0, None)
    for _ in range(iters):
        a, b, c = cand[rng.choice(len(cand), 3, replace=False)]
        n = np.cross(b - a, c - a)
        if np.linalg.norm(n) < 1e-12:
            continue
        n = normalize(n)
        if np.dot(n, u) < 0:
            n = -n
        if np.dot(n, u) < cos_tilt:
            continue
        inl = np.abs((cand - a) @ n) < thr
        k = int(inl.sum())
        if k > best[0]:
            best = (k, inl)
    if best[1] is None or best[0] < max(30, 0.15 * len(cand)):
        return None
    P = cand[best[1]]
    centroid = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - centroid)
    n = normalize(vt[-1])
    if np.dot(n, u) < 0:
        n = -n
    return n, float(np.dot(n, centroid)), best[0]


def scale_from_camera_height(poses, plane, cam_height_m):
    """Approximate metres per model unit, assuming the camera is held cam_height_m above the ground plane."""
    if plane is None:
        return None, "no ground plane found below the cameras"
    n, d, k = plane
    above = np.array([np.dot(n, p["C"]) - d for p in poses])
    med = float(np.median(above))
    if med <= 0:
        return None, "cameras below the estimated ground"
    return cam_height_m / med, f"camera height {cam_height_m} m above a ground plane of {k} points"


def circular_smooth(deg, win):
    if win <= 1:
        return deg
    rad = np.radians(deg)
    s = np.convolve(np.sin(rad), np.ones(win) / win, mode="same")
    c = np.convolve(np.cos(rad), np.ones(win) / win, mode="same")
    out = np.degrees(np.arctan2(s, c))
    out[np.isnan(deg)] = np.nan
    return out


def smooth(x, win):
    if win <= 1:
        return x
    pad = win // 2
    xp = np.pad(x, (pad, pad), mode="edge")
    return np.convolve(xp, np.ones(win) / win, mode="valid")[: len(x)]


def georef(workdir, uar, lat, lon, bearing, anchors=(), scale=None, camera_height=None,
           smooth_win=1, max_gap=3.0, out=None, relative=False):
    workdir = Path(workdir)
    frame_times = {}
    with open(workdir / "frames.csv") as fh:
        for row in csv.DictReader(fh):
            frame_times[row["image"]] = float(row["t"])
    model_dir, images, points = pick_model(workdir)
    poses = camera_poses(images, frame_times)
    if len(poses) < 2:
        sys.exit("fewer than 2 registered frames: nothing to georeference")
    n_total = len(frame_times)
    print(f"[georef] {len(poses)}/{n_total} frames registered by COLMAP")

    u, upright = estimate_up(poses)
    if upright < 0.8:
        print(f"[georef] WARNING: cameras are not consistently upright (score {upright:.2f}); "
              "the 'up' direction - hence bearings - may be wrong")
    plane = fit_ground_plane(poses, points, u)
    if plane is not None:
        tilt = math.degrees(math.acos(min(1.0, float(np.dot(plane[0], u)))))
        print(f"[georef] ground plane found ({plane[2]} points), 'up' corrected by {tilt:.1f} deg")
        u = plane[0]
    p0 = poses[0]
    if p0["t"] > 1.0:
        print(f"[georef] WARNING: first registered frame is at t={p0['t']:.1f}s; the sheet's "
              "geolocation (first image) is applied to it")
    a, r = horizontal_basis(u, p0["fwd"])

    # model -> local 2D (x = right of first view, y = along first view), units = model units
    def to2d(C):
        d = C - p0["C"]
        return np.array([np.dot(d, r), np.dot(d, a)])

    xy = np.array([to2d(p["C"]) for p in poses])
    rel_head = np.array([heading_in_basis(p["fwd"], a, r, u) for p in poses])
    steep = np.array([abs(np.dot(normalize(p["fwd"]), u)) > 0.9 for p in poses])

    if relative:
        return write_relative(poses, xy, rel_head, steep, uar, scale, camera_height, plane,
                              smooth_win, max_gap, out)

    # ---- transform local 2D -> ENU metres around the first image
    method = ""
    # first anchor = first image: (0,0) -> (0,0), heading 0 -> bearing
    if anchors:
        src = [xy[0]]
        dst = [np.array([0.0, 0.0])]
        ts = np.array([p["t"] for p in poses])
        for (ta, la, lo) in anchors:
            k = int(np.argmin(np.abs(ts - ta)))
            if abs(ts[k] - ta) > 1.0:
                print(f"[georef] WARNING: no registered frame within 1 s of anchor t={ta}")
            src.append(xy[k])
            dst.append(np.array(latlon_to_en(la, lo, lat, lon)))
        c, t, resid = fit_similarity_2d(np.array(src), np.array(dst))
        s = abs(c)
        rot_deg = -math.degrees(np.angle(c))  # clockwise rotation from model-north to true north
        method = f"anchors({len(src)}): scale {s:.4f} m/unit, residual max {resid.max():.2f} m"
        if bearing is not None and np.isfinite(bearing):
            diff = ((rot_deg - bearing + 540) % 360) - 180
            print(f"[georef] bearing from anchors {rot_deg % 360:.1f} deg vs sheet {bearing:.1f} deg (diff {diff:+.1f})")
        heading_offset = rot_deg
        world = np.array([c * complex(x, y) + t for x, y in xy])
        E, N = world.real, world.imag
    else:
        if bearing is None or not np.isfinite(bearing):
            sys.exit("need --bearing for the first image (or at least one --anchor)")
        if scale:
            s, method = scale, f"scale given: {scale} m/unit"
        elif camera_height:
            s, why = scale_from_camera_height(poses, plane, camera_height)
            if s is None:
                sys.exit(f"cannot estimate the scale from the camera height ({why}); give --anchor or --scale")
            method = f"APPROX scale {s:.4f} m/unit from {why}"
        else:
            sys.exit("no scale: give a 2nd anchor (--anchor t,lat,lon), --scale or --camera-height")
        b = math.radians(bearing)
        x, y = xy[:, 0] * s, xy[:, 1] * s
        # rotate clockwise by bearing: model 'along' axis -> true bearing
        E = x * math.cos(b) + y * math.sin(b)
        N = -x * math.sin(b) + y * math.cos(b)
        heading_offset = bearing

    print(f"[georef] {method}")
    bearings = (rel_head + heading_offset) % 360
    bearings[steep] = np.nan

    E, N = smooth(E, smooth_win), smooth(N, smooth_win)
    bearings = circular_smooth(bearings, smooth_win) % 360

    rows = []
    prev_t = None
    for p, e, n, bdeg, st in zip(poses, E, N, bearings, steep):
        la, lo = en_to_latlon(e, n, lat, lon)
        q = ["colmap", "anchors" if anchors else ("scale" if scale else "approx-scale")]
        if prev_t is not None and p["t"] - prev_t > max_gap:
            q.append(f"gap-before-{p['t'] - prev_t:.1f}s")
        if st:
            q.append("steep-view")
        prev_t = p["t"]
        rows.append([uar, f"{p['t']:.3f}", f"{la:.7f}", f"{lo:.7f}",
                     "" if not np.isfinite(bdeg) else f"{bdeg:.1f}", ";".join(q)])

    dist = float(np.sum(np.hypot(np.diff(E), np.diff(N))))
    print(f"[georef] path length {dist:.1f} m over {poses[-1]['t'] - poses[0]['t']:.1f} s")
    if out:
        with open(out, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["UAR", "t", "lat", "lon", "bearing", "quality"])
            w.writerows(rows)
        print(f"[georef] wrote {len(rows)} rows -> {out}  (paste them into the 'trajectories' tab)")
    return rows


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def write_relative(poses, xy, rel_head, steep, uar, scale, camera_height, plane, smooth_win, max_gap, out):
    """Trajectory in metres in the frame of the FIRST view (x = right, y = forward),
    heading relative to the first view. Codec puts it on the map with the
    position and bearing of the first image from the sheet."""
    if scale:
        s, method = scale, f"scale given: {scale} m/unit"
    else:
        h = camera_height or 1.5
        s, why = scale_from_camera_height(poses, plane, h)
        if s is None:
            sys.exit(f"cannot estimate the scale ({why}); give --scale")
        method = f"APPROX scale {s:.4f} m/unit from {why}"
    print(f"[georef] relative trajectory, {method}")
    x = smooth(xy[:, 0] * s, smooth_win)
    y = smooth(xy[:, 1] * s, smooth_win)
    head = rel_head.copy()
    head[steep] = np.nan
    head = circular_smooth(head, smooth_win)
    head = ((head + 180) % 360) - 180
    rows = []
    prev_t = None
    for p, xi, yi, hi, st in zip(poses, x, y, head, steep):
        q = ["relative", "scale" if scale else "approx-scale"]
        if prev_t is not None and p["t"] - prev_t > max_gap:
            q.append(f"gap-before-{p['t'] - prev_t:.1f}s")
        if st:
            q.append("steep-view")
        prev_t = p["t"]
        rows.append([uar, f"{p['t']:.3f}", f"{xi:.3f}", f"{yi:.3f}",
                     "" if not np.isfinite(hi) else f"{hi:.1f}", ";".join(q)])
    dist = float(np.sum(np.hypot(np.diff(x), np.diff(y))))
    print(f"[georef] path length {dist:.1f} m over {poses[-1]['t'] - poses[0]['t']:.1f} s")
    if out:
        with open(out, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["UAR", "t", "x", "y", "heading_rel", "quality"])
            w.writerows(rows)
        print(f"[georef] wrote {len(rows)} rows -> {out}")
    return rows


def parse_anchor(s):
    try:
        t, la, lo = (float(x) for x in s.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("anchor must be t,lat,lon (e.g. 38.5,46.2079,6.1487)")
    return (t, la, lo)


def add_georef_args(p):
    p.add_argument("--uar", required=True, help="UAR of the video in the sheet")
    p.add_argument("--lat", type=float, help="latitude of the first image (sheet)")
    p.add_argument("--lon", type=float, help="longitude of the first image (sheet)")
    p.add_argument("--relative", action="store_true",
                   help="output x/y metres relative to the first view (no lat/lon/bearing needed); "
                        "Codec orients it with the sheet's position and bearing")
    p.add_argument("--bearing", type=float, help="bearing of the first image, degrees from north (sheet)")
    p.add_argument("--anchor", type=parse_anchor, action="append", default=[],
                   help="extra known position: t,lat,lon (seconds into the video). Repeatable. Recommended.")
    p.add_argument("--scale", type=float, help="metres per COLMAP unit, if known")
    p.add_argument("--camera-height", type=float,
                   help="estimate the scale assuming the camera is this many metres above ground (approximate)")
    p.add_argument("--smooth", type=int, default=1, help="moving-average window in frames (e.g. 3)")
    p.add_argument("-o", "--out", default=None, help="output CSV (default: WORKDIR/trajectory.csv)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("frames", help="extract frames")
    f.add_argument("video")
    f.add_argument("workdir")
    f.add_argument("--fps", type=float, default=3.0)

    c = sub.add_parser("colmap", help="run COLMAP on extracted frames")
    c.add_argument("workdir")
    c.add_argument("--colmap-bin", default="colmap")
    c.add_argument("--gpu", action="store_true")

    g = sub.add_parser("georef", help="georeference a COLMAP reconstruction")
    g.add_argument("workdir")
    add_georef_args(g)

    a = sub.add_parser("all", help="frames + colmap + georef")
    a.add_argument("video")
    a.add_argument("workdir")
    a.add_argument("--fps", type=float, default=3.0)
    a.add_argument("--colmap-bin", default="colmap")
    a.add_argument("--gpu", action="store_true")
    add_georef_args(a)

    args = ap.parse_args(argv)
    if args.cmd in ("frames", "all"):
        extract_frames(args.video, args.workdir, args.fps)
    if args.cmd in ("colmap", "all"):
        run_colmap(args.workdir, args.colmap_bin, args.gpu)
    if args.cmd in ("georef", "all"):
        out = args.out or str(Path(args.workdir) / "trajectory.csv")
        if not args.relative and (args.lat is None or args.lon is None):
            sys.exit("--lat and --lon are required (or use --relative)")
        georef(args.workdir, args.uar, args.lat, args.lon, args.bearing, args.anchor, args.scale,
               args.camera_height, args.smooth, out=out, relative=args.relative)


if __name__ == "__main__":
    main()
