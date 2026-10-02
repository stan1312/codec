"""Synthetic test for tools/colmap_track.py georef: build a fake COLMAP binary model
from a known walk in metres, scrambled into an arbitrary frame, and check that the
georeferencing recovers positions and bearings."""
import csv, math, struct, sys, tempfile
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import colmap_track as ct

LAT0, LON0 = 46.20851, 6.14912

def rotmat2qvec(R):
    # robust conversion (same convention as COLMAP)
    Rxx, Ryx, Rzx, Rxy, Ryy, Rzy, Rxz, Ryz, Rzz = R.flat
    K = np.array([[Rxx - Ryy - Rzz, 0, 0, 0], [Ryx + Rxy, Ryy - Rxx - Rzz, 0, 0],
                  [Rzx + Rxz, Rzy + Ryz, Rzz - Rxx - Ryy, 0], [Ryz - Rzy, Rzx - Rxz, Rxy - Ryx, Rxx + Ryy + Rzz]]) / 3.0
    vals, vecs = np.linalg.eigh(K)
    q = vecs[[3, 0, 1, 2], np.argmax(vals)]
    return q if q[0] >= 0 else -q

def rot(axis, deg):
    a = math.radians(deg); c, s = math.cos(a), math.sin(a)
    x, y, z = axis
    return np.array([[c + x*x*(1-c), x*y*(1-c) - z*s, x*z*(1-c) + y*s],
                     [y*x*(1-c) + z*s, c + y*y*(1-c), y*z*(1-c) - x*s],
                     [z*x*(1-c) - y*s, z*y*(1-c) + x*s, c + z*z*(1-c)]])

def make_scene(tmp, fps=3, dur=40, seed=1):
    rng = np.random.default_rng(seed)
    ts = np.arange(0, dur, 1 / fps)
    # walk: 20 s heading 200 deg at 1.3 m/s, then turn to 250 deg
    E, N, H = [0.0], [0.0], []
    for i, t in enumerate(ts):
        head = 200 if t < 20 else 200 + min(50, (t - 20) * 10)
        H.append(head + 15 * math.sin(t / 3))  # panning while walking
        if i:
            d = 1.3 / fps
            E.append(E[-1] + d * math.sin(math.radians(head)))
            N.append(N[-1] + d * math.cos(math.radians(head)))
    E, N, H = np.array(E), np.array(N), np.array(H)
    Z = 1.6 + 0.03 * np.sin(ts * 5)
    # scrambling: ENU -> model
    s_m = 0.137
    Rw = rot(normalize(np.array([0.3, -0.5, 0.8])), 73)
    tw = np.array([4.0, -2.0, 7.5])
    to_model = lambda X: s_m * (Rw @ X) + tw
    names, lines = [], []
    images = []
    for i, t in enumerate(ts):
        head, pitch, roll = math.radians(H[i]), math.radians(-5 + 3 * math.sin(t)), math.radians(2 * math.sin(t * 1.7))
        f = np.array([math.sin(head) * math.cos(pitch), math.cos(head) * math.cos(pitch), math.sin(pitch)])
        r = np.cross(f, [0, 0, 1]); r /= np.linalg.norm(r)
        d = np.cross(f, r)  # down
        # roll around forward
        Rr = rot(f, math.degrees(roll)); r, d = Rr @ r, Rr @ d
        Rc2w = np.column_stack([r, d, f])  # camera axes X=right, Y=down, Z=forward in ENU
        Rc2w_m = Rw @ Rc2w
        C = to_model(np.array([E[i], N[i], Z[i]]))
        R = Rc2w_m.T
        tv = -R @ C
        name = f"frame_{i:06d}.jpg"
        images.append((i + 1, rotmat2qvec(R), tv, name))
        names.append((name, i / fps))
    # 3D points: ground + a facade
    g = np.column_stack([rng.uniform(-60, 30, 4000), rng.uniform(-60, 30, 4000), rng.normal(0, 0.03, 4000)])
    fac = np.column_stack([np.full(2000, -25.0), rng.uniform(-60, 30, 2000), rng.uniform(0, 15, 2000)])
    pts = np.array([to_model(p) for p in np.vstack([g, fac])])
    mdir = Path(tmp) / "sparse" / "0"; mdir.mkdir(parents=True)
    with open(mdir / "images.bin", "wb") as fh:
        fh.write(struct.pack("<Q", len(images)))
        for iid, q, tv, name in images:
            fh.write(struct.pack("<I", iid)); fh.write(struct.pack("<4d", *q)); fh.write(struct.pack("<3d", *tv))
            fh.write(struct.pack("<I", 1)); fh.write(name.encode() + b"\x00")
            fh.write(struct.pack("<Q", 2)); fh.write(struct.pack("<ddq", 1.0, 2.0, -1) * 2)
    with open(mdir / "points3D.bin", "wb") as fh:
        fh.write(struct.pack("<Q", len(pts)))
        for k, p in enumerate(pts):
            fh.write(struct.pack("<Q3d3Bd", k + 1, *p, 0, 0, 0, 0.5)); fh.write(struct.pack("<Q", 1)); fh.write(struct.pack("<II", 1, 0))
    # a smaller second model to check the largest one is picked
    m1 = Path(tmp) / "sparse" / "1"; m1.mkdir()
    with open(m1 / "images.txt", "w") as fh:
        fh.write("1 1 0 0 0 0 0 0 1 frame_000000.jpg\n\n")
    with open(Path(tmp) / "frames.csv", "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["image", "t"]); w.writerows(names)
    return ts, E, N, H, s_m

def normalize(v): return v / np.linalg.norm(v)

def errors(rows, E, N, H):
    pe, be = [], []
    for row, e, n, h in zip(rows, E, N, H):
        la, lo, b = float(row[2]), float(row[3]), float(row[4])
        ee, nn = ct.latlon_to_en(la, lo, LAT0, LON0)
        pe.append(math.hypot(ee - e, nn - n))
        be.append(abs(((b - h + 540) % 360) - 180))
    return max(pe), max(be)

def main():
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        ts, E, N, H, s_m = make_scene(tmp)
        b0 = H[0] % 360
        # 1. exact first-image bearing + known scale
        rows = ct.georef(tmp, "T", LAT0, LON0, b0, scale=1 / s_m)
        pe, be = errors(rows, E, N, H)
        print(f"known scale: max position error {pe:.3f} m, max bearing error {be:.2f} deg")
        ok &= pe < 0.5 and be < 3
        # 2. second anchor at the end instead of the scale
        la, lo = ct.en_to_latlon(E[-1], N[-1], LAT0, LON0)
        rows = ct.georef(tmp, "T", LAT0, LON0, b0, anchors=[(ts[-1], la, lo)])
        pe, be = errors(rows, E, N, H)
        print(f"2 anchors:   max position error {pe:.3f} m, max bearing error {be:.2f} deg")
        ok &= pe < 0.8 and be < 3
        # 3. camera-height heuristic
        rows = ct.georef(tmp, "T", LAT0, LON0, b0, camera_height=1.6)
        pe, be = errors(rows, E, N, H)
        path = float(np.sum(np.hypot(np.diff(E), np.diff(N))))
        print(f"height heur: max position error {pe:.2f} m on a {path:.0f} m path, bearing {be:.2f} deg")
        ok &= pe < 0.15 * path and be < 3
        # 4. a wrong first bearing (10 deg off) is corrected by 2 anchors
        rows = ct.georef(tmp, "T", LAT0, LON0, b0 + 10, anchors=[(ts[-1], la, lo)])
        pe, _ = errors(rows, E, N, H)
        ok &= pe < 0.8
        # 5. relative output, then oriented like Codec does (rotate by bearing, offset by origin)
        rows = ct.georef(tmp, "T", None, None, None, scale=1 / s_m, relative=True)
        pe = be = 0.0
        b = math.radians(b0)
        for row, e, n, h in zip(rows, E, N, H):
            x, y = float(row[2]), float(row[3])
            ee = x * math.cos(b) + y * math.sin(b)
            nn = -x * math.sin(b) + y * math.cos(b)
            pe = max(pe, math.hypot(ee - e, nn - n))
            be = max(be, abs(((float(row[4]) + b0 - h + 540) % 360) - 180))
        print(f"relative:    max position error {pe:.3f} m, max bearing error {be:.2f} deg")
        ok &= pe < 0.05 and be < 1
    # 6. same scene as a COLMAP *text* model (format written by tools/vggt_poses.py)
    with tempfile.TemporaryDirectory() as tmp2:
        ts, E, N, H, s_m = make_scene(tmp2)
        imgs = ct.read_images_bin(Path(tmp2) / "sparse/0/images.bin")
        pts = ct.read_points_bin(Path(tmp2) / "sparse/0/points3D.bin")
        import shutil
        shutil.rmtree(Path(tmp2) / "sparse")
        d = Path(tmp2) / "sparse/0"; d.mkdir(parents=True)
        with open(d / "images.txt", "w") as fh:
            fh.write("# header\n")
            for iid, (name, q, t) in imgs.items():
                fh.write(f"{iid} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} 1 {name}\n\n")
        with open(d / "points3D.txt", "w") as fh:
            for i, p in enumerate(pts):
                fh.write(f"{i+1} {p[0]} {p[1]} {p[2]} 128 128 128 0\n")
        rows = ct.georef(tmp2, "T", None, None, None, camera_height=1.6, relative=True)
        path = float(np.sum(np.hypot(np.diff(E), np.diff(N))))
        last = rows[-1]
        got = math.hypot(float(last[2]), float(last[3]))
        want = math.hypot(E[-1], N[-1])
        print(f"text model + height scale: end distance {got:.2f} m vs {want:.2f} m")
        ok &= abs(got - want) < 0.05 * want
    print("ALL PASSED" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
