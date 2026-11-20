"""Draws the app's home-screen icons (no extra Python packages needed).
Run from the app folder:  py tools\\make_icons.py"""
import math
import struct
import zlib
from pathlib import Path

BG = (11, 37, 69)       # navy
FG = (255, 255, 255)
ACC = (255, 196, 0)     # amber


def shade(x, y):
    """Colour at point (x, y) in a 0..1 square."""
    cx, cy = x - 0.5, y - 0.5
    r = math.hypot(cx, cy)
    # runway: rotated rectangle through the centre
    a = math.radians(-35)
    u = cx * math.cos(a) - cy * math.sin(a)
    v = cx * math.sin(a) + cy * math.cos(a)
    if abs(u) < 0.075 and abs(v) < 0.33:
        if abs(u) < 0.012 and (int((v + 0.33) / 0.06) % 2 == 0) and abs(v) < 0.27:
            return BG
        return FG
    if 0.36 < r < 0.40:      # compass ring
        return FG
    # north tick
    if abs(cx) < 0.02 and -0.47 < cy < -0.36:
        return ACC
    return BG


def png(size, path):
    rows = []
    ss = 3
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            acc = [0, 0, 0]
            for sj in range(ss):
                for si in range(ss):
                    c = shade((i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            row += bytes(int(v / (ss * ss)) for v in acc)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    Path(path).write_bytes(data)
    print("wrote", path)


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for s in (180, 192, 512):
        png(s, out / f"icon-{s}.png")
