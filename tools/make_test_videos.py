#!/usr/bin/env python3
"""Generate synthetic test clips with the absolute event clock burned into the image.

Each clip shows its own UAR and the wall-clock time (HH:MM:SS.mmm) at which
the frame is supposed to have been filmed. When Codec's synchronised playback
works, every visible clip shows the same time as the transport clock.

Usage: python3 tools/make_test_videos.py testdata/
"""
import subprocess, sys, pathlib

CLIPS = [
    # UAR, start (HH:MM:SS.s), duration (s), colour
    ("GE0210-T01", "20:47:00.0", 30, "0x803030"),
    ("GE0210-T02", "20:47:12.4", 25, "0x305080"),
    ("GE0210-T03", "20:47:20.0", 20, "0x307040"),
]

def secs(hms):
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)

def main(out):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    font = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
    for uar, start, dur, col in CLIPS:
        off = secs(start)
        vf = (
            f"drawtext=fontfile={font}:text='{uar}':x=20:y=20:fontsize=28:fontcolor=white,"
            f"drawtext=fontfile={font}:text='%{{pts\\:hms\\:{off}}}':x=20:y=150:fontsize=64:fontcolor=white"
        )
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c={col}:s=640x360:r=30:d={dur}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
            "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
            "-c:a", "aac", "-shortest", "-movflags", "+faststart",
            str(out / f"{uar}.mp4"),
        ]
        subprocess.run(cmd, check=True)
        print("wrote", out / f"{uar}.mp4")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "testdata")
