#!/usr/bin/env python3
"""make_icon.py —— 生成 apps/desktop/assets/app.ico（作者 PT-dove）。

为什么不直接找现成图标：本机没有 Pillow，也不允许联网下载素材。图标用纯
Python 画出来：盾牌轮廓 + 勾，四倍超采样做抗锯齿，再自己写 ICO 容器。

用法：
    python scripts/desktop/make_icon.py [输出路径]

输出是标准 ICO：小尺寸用 32 位 BMP 条目（兼容性最好），128/256 用 PNG 条目。
"""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
PNG_SIZES = {128, 256}
SUPERSAMPLE = 4

# 品牌色：深蓝 → 亮蓝的竖向渐变，勾为白色。
TOP_COLOR = (58, 110, 240)
BOTTOM_COLOR = (26, 62, 168)
CHECK_COLOR = (255, 255, 255)


def _shield_half_width(y: float) -> float:
    """归一化坐标 [0,1] 下盾牌在纵坐标 y 处的半宽。"""
    top = 0.075
    shoulder = 0.44
    tip = 0.945
    if y < top or y > tip:
        return -1.0
    if y <= shoulder:
        # 上段：接近矩形，微小内收
        t = (y - top) / (shoulder - top)
        return 0.372 - 0.012 * t * t
    # 下段：椭圆收尖
    t = (y - shoulder) / (tip - shoulder)
    return 0.360 * math.sqrt(max(0.0, 1.0 - t * t))


def _seg_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


CHECK_POINTS = [(0.285, 0.500), (0.435, 0.652), (0.715, 0.340)]
CHECK_HALF_WIDTH = 0.062


def _sample(x: float, y: float) -> tuple[float, float, float, float] | None:
    """单点采样：返回 (r,g,b,a) 或 None 表示完全透明。坐标归一化到 [0,1]。"""
    half = _shield_half_width(y)
    inside_shield = half > 0 and abs(x - 0.5) <= half
    if not inside_shield:
        return None

    # 勾：两段折线，距离小于半宽即在笔画内
    distance = min(
        _seg_distance(x, y, *CHECK_POINTS[0], *CHECK_POINTS[1]),
        _seg_distance(x, y, *CHECK_POINTS[1], *CHECK_POINTS[2]),
    )
    if distance <= CHECK_HALF_WIDTH:
        r, g, b = CHECK_COLOR
    else:
        # 竖向渐变 + 极轻微的中心提亮
        t = max(0.0, min(1.0, (y - 0.06) / 0.90))
        lift = max(0.0, 1.0 - math.hypot(x - 0.5, y - 0.42) * 1.4) * 16
        r = TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * t + lift
        g = TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t + lift
        b = TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t + lift
    return (r, g, b, 1.0)


def render(size: int) -> list[tuple[int, int, int, int]]:
    """渲染为逐像素的 RGBA 列表（行优先，自上而下）。"""
    pixels: list[tuple[int, int, int, int]] = []
    step = 1.0 / (size * SUPERSAMPLE)
    for row in range(size):
        for col in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (col * SUPERSAMPLE + sx + 0.5) * step
                    y = (row * SUPERSAMPLE + sy + 0.5) * step
                    sample = _sample(x, y)
                    if sample is None:
                        continue
                    acc_r += sample[0]
                    acc_g += sample[1]
                    acc_b += sample[2]
                    acc_a += 1.0
            total = SUPERSAMPLE * SUPERSAMPLE
            if acc_a == 0:
                pixels.append((0, 0, 0, 0))
                continue
            pixels.append((
                int(round(acc_r / acc_a)),
                int(round(acc_g / acc_a)),
                int(round(acc_b / acc_a)),
                int(round(255 * acc_a / total)),
            ))
    return pixels


def to_bmp_entry(pixels: list[tuple[int, int, int, int]], size: int) -> bytes:
    header = struct.pack(
        "<IiiHHIIiiII",
        40,          # biSize
        size,        # biWidth
        size * 2,    # biHeight（XOR + AND 两张图叠加的高度）
        1,           # biPlanes
        32,          # biBitCount
        0,           # biCompression = BI_RGB
        0, 0, 0, 0, 0,
    )
    body = bytearray()
    for row in range(size - 1, -1, -1):  # BMP 自下而上
        for col in range(size):
            r, g, b, a = pixels[row * size + col]
            body += bytes((b, g, r, a))
    mask_stride = ((size + 31) // 32) * 4
    body += bytes(mask_stride * size)  # AND 掩码全 0：以 alpha 为准
    return header + bytes(body)


def to_png_entry(pixels: list[tuple[int, int, int, int]], size: int) -> bytes:
    raw = bytearray()
    for row in range(size):
        raw.append(0)  # filter: none
        for col in range(size):
            r, g, b, a = pixels[row * size + col]
            raw += bytes((r, g, b, a))

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def write_ico(path: Path) -> None:
    entries: list[tuple[int, bytes]] = []
    for size in SIZES:
        pixels = render(size)
        payload = to_png_entry(pixels, size) if size in PNG_SIZES else to_bmp_entry(pixels, size)
        entries.append((size, payload))

    offset = 6 + 16 * len(entries)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(entries)))
    blobs = bytearray()
    for size, payload in entries:
        dimension = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(payload), offset)
        blobs += payload
        offset += len(payload)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(directory) + bytes(blobs))


def main() -> int:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parents[2] / "apps" / "desktop" / "assets" / "app.ico"
    )
    write_ico(target)
    print(f"wrote {target} ({target.stat().st_size} bytes, sizes={SIZES})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
