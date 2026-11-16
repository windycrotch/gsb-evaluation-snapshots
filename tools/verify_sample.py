#!/usr/bin/env python3
"""独立交叉核对（仅用 Python 标准库，与 JS 实现互不共享代码）。

读取 sample/ 下由 Node 工具链生成的 PNG 图集与 JSON 清单：
  1. 自行解码 PNG（zlib + struct，支持 0-4 号行过滤器）；
  2. 逐像素核对 PNG 与清单 cells/palette 完全一致；
  3. 核对清单结构：种子、行列、单元格尺寸、调色板、索引范围；
  4. 核对每种调色板颜色都至少出现一次；
  5. 核对相邻格子（上下左右、含首尾环绕）索引不同。

用法： python -I tools/verify_sample.py
"""
import json
import struct
import sys
import zlib
from pathlib import Path


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def decode_png(data: bytes):
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("不是 PNG 文件")
    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, *_ = struct.unpack(">IIBBBBB", body)
        elif ctype == b"IDAT":
            idat.extend(body)
        elif ctype == b"IEND":
            break
    if bit_depth != 8 or color_type != 2:
        raise ValueError(f"仅支持 RGB 8-bit PNG，实际 depth={bit_depth} type={color_type}")
    raw = zlib.decompress(bytes(idat))
    channels = 3
    stride = width * channels
    out = bytearray(stride * height)
    rp = 0
    for y in range(height):
        ftype = raw[rp]
        rp += 1
        for x in range(stride):
            v = raw[rp]
            rp += 1
            a = out[y * stride + x - channels] if x >= channels else 0
            b = out[(y - 1) * stride + x] if y > 0 else 0
            c = out[(y - 1) * stride + x - channels] if y > 0 and x >= channels else 0
            if ftype == 0:
                val = v
            elif ftype == 1:
                val = (v + a) & 0xFF
            elif ftype == 2:
                val = (v + b) & 0xFF
            elif ftype == 3:
                val = (v + ((a + b) >> 1)) & 0xFF
            elif ftype == 4:
                val = (v + paeth(a, b, c)) & 0xFF
            else:
                raise ValueError(f"未知行过滤器 {ftype}")
            out[y * stride + x] = val
    return width, height, bytes(out)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "sample" / "sample-manifest.json").read_text(encoding="utf-8"))
    png_bytes = (root / "sample" / "sample-atlas.png").read_bytes()

    errors = []

    required = ["format", "seed", "rows", "columns", "cellSize", "palette", "cells", "atlas", "colorUsage"]
    for key in required:
        if key not in manifest:
            errors.append(f"清单缺少字段 {key}")
    if errors:
        for e in errors:
            print("FAIL:", e)
        return 1

    rows, cols, cell = manifest["rows"], manifest["columns"], manifest["cellSize"]
    palette, cells = manifest["palette"], manifest["cells"]

    if not (1 <= rows <= 64 and 1 <= cols <= 64):
        errors.append(f"行列越界：{rows}x{cols}")
    if not (4 <= cell <= 32):
        errors.append(f"单元格尺寸越界：{cell}")
    if len(cells) != rows * cols:
        errors.append(f"cells 长度 {len(cells)} != {rows}x{cols}")
    if any(not (0 <= i < len(palette)) for i in cells):
        errors.append("存在越界颜色索引")

    usage = [0] * len(palette)
    for i in cells:
        if 0 <= i < len(palette):
            usage[i] += 1
    for idx, count in enumerate(usage):
        if count == 0:
            errors.append(f"调色板颜色 {idx} ({palette[idx]}) 从未出现")
    if manifest.get("colorUsage") != usage:
        errors.append("清单 colorUsage 与实际统计不符")

    # 相邻格（含首尾环绕）不得同色
    for r in range(rows):
        for c in range(cols):
            cur = cells[r * cols + c]
            for nr, nc in ((r, (c + 1) % cols), ((r + 1) % rows, c)):
                if nr == r and nc == c:
                    continue
                if cells[nr * cols + nc] == cur:
                    errors.append(f"相邻格同色：({r},{c}) 与 ({nr},{nc}) 索引均为 {cur}")

    width, height, rgb = decode_png(png_bytes)
    if width != cols * cell or height != rows * cell:
        errors.append(f"PNG 尺寸 {width}x{height} 与清单 {cols * cell}x{rows * cell} 不符")
    if manifest["atlas"] != {"width": cols * cell, "height": rows * cell}:
        errors.append("清单 atlas 尺寸字段不符")

    def hex_to_rgb(h):
        return struct.unpack("BBB", bytes.fromhex(h.lstrip("#")))

    bad = 0
    for r in range(rows):
        for c in range(cols):
            want = hex_to_rgb(palette[cells[r * cols + c]])
            for dy in range(cell):
                for dx in range(cell):
                    x, y = c * cell + dx, r * cell + dy
                    off = (y * width + x) * 3
                    if tuple(rgb[off:off + 3]) != want:
                        bad += 1
    if bad:
        errors.append(f"PNG 有 {bad} 个像素与清单索引不符")

    print(f"样例参数：seed={manifest['seed']!r} {rows}x{cols} cell={cell}px 颜色数={len(palette)}")
    print("格子索引：")
    for r in range(rows):
        print("  " + " ".join(str(i) for i in cells[r * cols:(r + 1) * cols]))
    print(f"颜色使用次数：{usage}")
    print(f"PNG：{width}x{height}，{len(png_bytes)} 字节")

    if errors:
        for e in errors:
            print("FAIL:", e)
        return 1
    print("PASS: Python 独立核对全部通过（像素与清单一致、环绕异色、颜色全覆盖、字段完整）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
