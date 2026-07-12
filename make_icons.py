#!/usr/bin/env python3
"""Generate the Garbicz DJ app icon as a PNG, no third-party deps.

Draws a warm lakeside/forest emblem: golden sun over layered forest hills
with a lake reflection. Full-bleed square (iOS masks its own corners).
"""
import zlib
import struct
import math
import sys

W = H = 512

# Dark Garbicz '26 palette (placeholder until the neon logo art is supplied)
SKY_TOP = (46, 26, 78)      # #2E1A4E deep violet sky
SKY_HORIZON = (26, 14, 42)  # #1A0E2A deeper indigo at horizon
SUN = (226, 85, 166)        # #E255A6 magenta sun
SUN_GLOW = (255, 138, 205)  # #FF8ACD
HILL_BACK = (74, 42, 118)   # #4A2A76 violet
HILL_FRONT = (44, 26, 78)   # #2C1A4E darker violet
LAKE = (30, 18, 60)         # #1E123C indigo water
LAKE_SHIMMER = (139, 92, 255)
CREAM = (240, 210, 240)     # pale magenta horizon line

HORIZON = 322  # y of waterline

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

# framebuffer: list of [r,g,b] rows
px = [[[0, 0, 0] for _ in range(W)] for _ in range(H)]

def set_px(x, y, color, alpha=1.0):
    if 0 <= x < W and 0 <= y < H:
        if alpha >= 1.0:
            px[y][x] = list(color)
        else:
            cur = px[y][x]
            px[y][x] = [max(0, min(255, int(round(cur[i] + (color[i] - cur[i]) * alpha)))) for i in range(3)]

# 1) Sky gradient (top -> horizon)
for y in range(0, HORIZON):
    t = y / HORIZON
    c = lerp(SKY_TOP, SKY_HORIZON, t)
    for x in range(W):
        px[y][x] = list(c)

# 2) Lake (horizon -> bottom), subtle vertical shimmer bands
for y in range(HORIZON, H):
    t = (y - HORIZON) / (H - HORIZON)
    base = lerp(LAKE, (36, 56, 54), t)
    for x in range(W):
        px[y][x] = list(base)

# 3) Sun with soft glow, sits above horizon and reflects into lake
sun_cx, sun_cy, sun_r = 300, 196, 92
for y in range(H):
    for x in range(W):
        dx = x - sun_cx
        dy = y - sun_cy
        d = math.sqrt(dx * dx + dy * dy)
        if y < HORIZON:
            if d <= sun_r:
                # radial fill from bright center to warm edge
                tt = d / sun_r
                set_px(x, y, lerp(SUN_GLOW, SUN, tt))
            elif d <= sun_r + 46:
                # glow halo, fades out
                a = max(0.0, 1.0 - (d - sun_r) / 46.0) * 0.45
                set_px(x, y, SUN_GLOW, a)

# Sun reflection on the lake (mirrored, dimmer, broken into ripples)
for y in range(HORIZON, min(H, HORIZON + 150)):
    mirror = HORIZON + (HORIZON - (sun_cy)) * 0  # anchor near horizon
    ry = HORIZON + (y - HORIZON)
    # reflected sun column band around sun_cx
    band = sun_r * (1.0 - (y - HORIZON) / 150.0)
    if band <= 0:
        continue
    # ripple gaps
    if ((y - HORIZON) // 7) % 2 == 0:
        continue
    for x in range(int(sun_cx - band), int(sun_cx + band)):
        if 0 <= x < W:
            edge = 1.0 - abs(x - sun_cx) / max(1.0, band)
            set_px(x, y, SUN_GLOW, 0.28 * edge)

# 4) Cream horizon line (thin)
for x in range(W):
    for y in range(HORIZON - 2, HORIZON + 1):
        set_px(x, y, CREAM, 0.7)

# 5) Forest hills silhouettes rising from the horizon (drawn above waterline)
def hill(color, amp, base_y, freq, phase):
    for x in range(W):
        h = base_y - amp * (0.5 + 0.5 * math.sin(freq * (x / W) * math.pi * 2 + phase))
        for y in range(int(h), HORIZON):
            set_px(x, y, color)

# back range (taller, lighter), then front range (lower, darker) for depth
hill(HILL_BACK, 66, HORIZON, 1.3, 0.6)
hill(HILL_FRONT, 40, HORIZON, 2.1, 2.4)

# tiny pine trees on the front ridge for a handmade forest feel
def pine(cx, base_y, size, color):
    # three stacked tiers, each a triangle that is narrow at top, wide at base
    tier_h = size // 3
    for lvl in range(3):
        top = base_y - size + lvl * tier_h
        half = int((lvl + 1) * (size / 7)) + 2
        for y in range(top, top + tier_h + 1):
            span = int(half * ((y - top) / max(1, tier_h)))
            for x in range(cx - span, cx + span + 1):
                set_px(x, y, color)
    # trunk
    for y in range(base_y, base_y + 5):
        for x in range(cx - 2, cx + 2):
            set_px(x, y, (70, 40, 90))

for tx in (118, 176, 250, 358, 430):
    ridge = int(HORIZON - 40 * (0.5 + 0.5 * math.sin(2.1 * (tx / W) * math.pi * 2 + 2.4)))
    pine(tx, ridge + 6, 34, (26, 14, 48))

# --- encode PNG ---
def write_png(path, pixels):
    raw = bytearray()
    for y in range(H):
        raw.append(0)  # filter type 0
        for x in range(W):
            raw.extend(pixels[y][x])
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        c += struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
        return c

    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)  # 8-bit RGB
    with open(path, 'wb') as f:
        f.write(sig)
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))

out = sys.argv[1] if len(sys.argv) > 1 else 'icon-512.png'
write_png(out, px)
print('wrote', out)
