#!/usr/bin/env python3
"""
vggt_poses.py - camera poses of extracted video frames with VGGT, written as a
COLMAP text model so that colmap_track.py georef can use them.

VGGT (Meta, CVPR 2025) is a neural network that estimates camera poses and
depth from images directly. It is usually more robust than COLMAP on hard
footage (night, smoke, shaking), but less precise on long sequences.

Usage (from the python environment where VGGT is installed, e.g. gvhmr):
    python3 tools/colmap_track.py frames video.mp4 work/0042 --fps 2
    python3 tools/vggt_poses.py work/0042 --vggt-repo ~/COPWATCH_3D/gvhmr/third-party/vggt
    python3 tools/colmap_track.py georef work/0042 --uar GE-0042 --relative

Writes work/0042/sparse/0/{cameras,images,points3D}.txt
Memory: VGGT-1B processes all frames at once; --max-frames (default 48) keeps it
reasonable on a laptop (Apple Silicon: uses "mps", otherwise CPU, or CUDA).
"""
import argparse
import csv
import sys
from pathlib import Path

import numpy as np


def rotmat_to_qvec(R):
    Rxx, Ryx, Rzx, Rxy, Ryy, Rzy, Rxz, Ryz, Rzz = R.flat
    K = np.array([
        [Rxx - Ryy - Rzz, 0, 0, 0],
        [Ryx + Rxy, Ryy - Rxx - Rzz, 0, 0],
        [Rzx + Rxz, Rzy + Ryz, Rzz - Rxx - Ryy, 0],
        [Ryz - Rzy, Rzx - Rxz, Rxy - Ryx, Rxx + Ryy + Rzz],
    ]) / 3.0
    vals, vecs = np.linalg.eigh(K)
    q = vecs[[3, 0, 1, 2], np.argmax(vals)]
    return q if q[0] >= 0 else -q


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workdir", help="folder with images/ and frames.csv (from colmap_track.py frames)")
    ap.add_argument("--vggt-repo", help="path to the cloned vggt repository (if not pip-installed)")
    ap.add_argument("--max-frames", type=int, default=48)
    ap.add_argument("--conf-percentile", type=float, default=50, help="keep 3D points above this confidence percentile")
    ap.add_argument("--max-points", type=int, default=60000)
    ap.add_argument("--device", default=None, help="cuda / mps / cpu (default: best available)")
    args = ap.parse_args()

    if args.vggt_repo:
        sys.path.insert(0, str(Path(args.vggt_repo).expanduser()))
    try:
        import torch
        from vggt.models.vggt import VGGT
        from vggt.utils.load_fn import load_and_preprocess_images
        from vggt.utils.pose_enc import pose_encoding_to_extri_intri
    except ImportError as e:
        sys.exit(f"VGGT not importable ({e}). Activate the environment where it is installed "
                 "and/or pass --vggt-repo /path/to/vggt")

    work = Path(args.workdir)
    with open(work / "frames.csv") as fh:
        frames = [r["image"] for r in csv.DictReader(fh)]
    if len(frames) > args.max_frames:
        idx = np.linspace(0, len(frames) - 1, args.max_frames).round().astype(int)
        frames = [frames[i] for i in sorted(set(idx))]
        print(f"[vggt] using {len(frames)} evenly spaced frames (--max-frames)")
    paths = [str(work / "images" / f) for f in frames]

    device = args.device or ("cuda" if torch.cuda.is_available()
                             else "mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()
                             else "cpu")
    print(f"[vggt] device {device}, {len(paths)} frames")
    model = VGGT.from_pretrained("facebook/VGGT-1B").to(device).eval()
    images = load_and_preprocess_images(paths).to(device)
    with torch.no_grad():
        if device == "cuda":
            dtype = torch.bfloat16 if torch.cuda.get_device_capability()[0] >= 8 else torch.float16
            with torch.cuda.amp.autocast(dtype=dtype):
                pred = model(images)
        else:
            pred = model(images)
    extrinsic, intrinsic = pose_encoding_to_extri_intri(pred["pose_enc"], images.shape[-2:])
    E = extrinsic.squeeze(0).float().cpu().numpy()  # S x 3 x 4, camera-from-world (OpenCV)
    K = intrinsic.squeeze(0).float().cpu().numpy()
    pts = pred["world_points"].squeeze(0).float().cpu().numpy().reshape(-1, 3)
    conf = pred["world_points_conf"].squeeze(0).float().cpu().numpy().reshape(-1)
    keep = conf >= np.percentile(conf, args.conf_percentile)
    pts = pts[keep]
    if len(pts) > args.max_points:
        pts = pts[np.random.default_rng(0).choice(len(pts), args.max_points, replace=False)]

    out = work / "sparse" / "0"
    out.mkdir(parents=True, exist_ok=True)
    H, W = images.shape[-2:]
    with open(out / "cameras.txt", "w") as fh:
        fh.write("# CAMERA_ID MODEL WIDTH HEIGHT PARAMS[]\n")
        fx, fy, cx, cy = K[0, 0, 0], K[0, 1, 1], K[0, 0, 2], K[0, 1, 2]
        fh.write(f"1 PINHOLE {W} {H} {fx} {fy} {cx} {cy}\n")
    with open(out / "images.txt", "w") as fh:
        fh.write("# IMAGE_ID QW QX QY QZ TX TY TZ CAMERA_ID NAME\n")
        for i, (name, M) in enumerate(zip(frames, E)):
            R, t = M[:, :3], M[:, 3]
            q = rotmat_to_qvec(R)
            fh.write(f"{i + 1} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} 1 {name}\n\n")
    with open(out / "points3D.txt", "w") as fh:
        fh.write("# POINT3D_ID X Y Z R G B ERROR TRACK[]\n")
        for i, p in enumerate(pts):
            fh.write(f"{i + 1} {p[0]} {p[1]} {p[2]} 128 128 128 0\n")
    print(f"[vggt] wrote {out} ({len(frames)} poses, {len(pts)} points)")


if __name__ == "__main__":
    main()
