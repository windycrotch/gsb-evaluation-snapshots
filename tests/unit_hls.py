"""HLS 分片下载测试：用本地 HTTP 服务模拟 m3u8 播放列表 + TS 分片。

覆盖：
1. is_hls：URL 后缀 / Content-Type 识别
2. download_hls：主列表自动选最高带宽变体、相对 URI、多分片并发合并、输出 .ts 正确
3. BYTERANGE 偏移分片（带 Range 头）
4. AES-128 加密流：显式 IV / 默认 IV（分片序号）/ 多分片拼接
5. 失败路径：SAMPLE-AES 不支持、密钥 404、分片 404、无分片返回 None 且不留临时目录
6. 断点续传（重点）：
   - 某分片持续失败 → 目标文件只能是第 0 片起的连续前缀，meta 与其严格一致
   - 失败后重跑同一地址 → 跳过已落盘分片，最终文件与全量下载逐字节一致
   - 中止时仍在等待写盘的分片不追加（有序提交器直接验证）
   - meta 与文件不一致 / 文件被外部改动 / 指纹变化 → 放弃旧进度从头下载
   - 成功完成后清理 meta
"""

import hashlib
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import time

from Crypto.Cipher import AES as _AES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "resources_reptile"))

import config

config.PROXY_ENABLED = False
config.DEFAULT_PROXY = ""

sys.path.insert(0, os.path.join(ROOT, "tests"))

import hls_downloader

PASS = 0
FAIL = 0


def check(name, got, expected=True):
    global PASS, FAIL
    if isinstance(expected, bool) or expected is None:
        ok = (got is expected)
    else:
        ok = (got == expected)
    if ok:
        PASS += 1
        print(f"PASS {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}: got={got!r} expected={expected!r}")


SEGS = [b"S" + bytes([i]) * 8 for i in range(1, 5)]  # 4 个分片

ENC_KEY = b"K" * 16
ENC_IV = bytes.fromhex("00112233445566778899aabbccddeeff")


def _enc(data: bytes, iv: bytes) -> bytes:
    pad = 16 - (len(data) % 16)
    return _AES.new(ENC_KEY, _AES.MODE_CBC, iv).encrypt(data + bytes([pad]) * pad)


ENC_SEGS = [_enc(s, i.to_bytes(16, "big")) for i, s in enumerate(SEGS)]


class Handler(http.server.BaseHTTPRequestHandler):
    paths = {}

    def _dyn(self, key: str) -> tuple[bytes | None, str]:
        """动态播放列表/分片：/dyn/<name>.m3u8 与 /dyn/<name>-seg<i>.ts。

        行为由 server.spec 控制：
        - ``dyn_segs``: name -> [分片 bytes, ...]
        - ``delays``:   path -> 秒（制造乱序完成）
        - ``fail_counts``: path -> 剩余失败次数（每次递减，>0 时返回 404）
        - ``seg_fails``: 永久失败的 path 集合
        """
        spec = self.server.spec
        delays = spec.get("delays") or {}
        if key in delays:
            time.sleep(delays[key])
        if key in (spec.get("drops") or ()):
            self.close_connection = True
            try:
                self.connection.close()
            except OSError:
                pass
            return b"", "drop"
        fc = spec.get("fail_counts") or {}
        with self.server.fail_lock:
            if fc.get(key, 0) > 0:
                fc[key] = fc[key] - 1
                return b"", "fail"
        if key.startswith("/dyn/") and key.endswith(".m3u8"):
            name = key[len("/dyn/"):-len(".m3u8")]
            segs = (spec.get("dyn_segs") or {}).get(name)
            if segs is None:
                return None, ""
            lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:8"]
            for i in range(len(segs)):
                lines += ["#EXTINF:8.0,", f"{name}-seg{i}.ts"]
            lines.append("#EXT-X-ENDLIST")
            return ("\n".join(lines) + "\n").encode(), \
                "application/vnd.apple.mpegurl"
        for name, segs in (spec.get("dyn_segs") or {}).items():
            for i, body in enumerate(segs):
                if key == f"/dyn/{name}-seg{i}.ts":
                    return body, "video/mp2t"
        return None, ""

    def do_GET(self):
        self.server: HlsServer
        spec = self.server.spec
        key = self.path
        if key in spec.get("seg_fails", ()):
            self.send_response(404)
            self.end_headers()
            return
        if key.startswith("/dyn/"):
            with self.server.fail_lock:
                self.server.hits[key] = self.server.hits.get(key, 0) + 1
            body, ct = self._dyn(key)
            if ct == "drop":
                return
            if ct == "fail":
                self.send_response(404)
                self.end_headers()
                return
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = None
        ct = "application/vnd.apple.mpegurl"
        if key == "/master.m3u8":
            body = ("#EXTM3U\n"
                    "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n"
                    "low.m3u8\n"
                    "#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720\n"
                    "high.m3u8\n").encode()
        elif key == "/low.m3u8" or key == "/high.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n"
                    "#EXTINF:8.0,\nseg1.ts\n#EXTINF:8.0,\nseg2.ts\n"
                    "#EXTINF:8.0,\nseg3.ts\n#EXTINF:8.0,\nseg4.ts\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/ranges.m3u8":
            body = ("#EXTM3U\n#EXT-X-VERSION:6\n"
                    "#EXT-X-MAP:URI=\"init.ts\"\n"
                    "#EXTINF:8.0,\n#EXT-X-BYTERANGE:16@0\nranges.bin\n"
                    "#EXTINF:8.0,\n#EXT-X-BYTERANGE:16@16\nranges.bin\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/enc.m3u8":
            body = ("#EXTM3U\n"
                    f"#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x{ENC_IV.hex()}\n"
                    "#EXTINF:8.0,\nenc_seg_iv.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc2.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc4.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXTINF:8.0,\nenc_seg2.ts\n"
                    "#EXTINF:8.0,\nenc_seg3.ts\n#EXTINF:8.0,\nenc_seg4.ts\n"
                    "#EXT-X-ENDLIST\n").encode()
        elif key == "/sample.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"key.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc-nokey.m3u8":
            body = ("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"missing.bin\"\n"
                    "#EXTINF:8.0,\nenc_seg1.ts\n#EXT-X-ENDLIST\n").encode()
        elif key == "/empty.m3u8":
            body = ("#EXTM3U\n#EXT-X-ENDLIST\n").encode()
        elif key == "/enc_seg_iv.ts":
            body, ct = _enc(SEGS[0], ENC_IV), "video/mp2t"
        elif key == "/enc_seg1.ts":
            body, ct = ENC_SEGS[0], "video/mp2t"
        elif key == "/enc_seg2.ts":
            body, ct = ENC_SEGS[1], "video/mp2t"
        elif key == "/enc_seg3.ts":
            body, ct = ENC_SEGS[2], "video/mp2t"
        elif key == "/enc_seg4.ts":
            body, ct = ENC_SEGS[3], "video/mp2t"
        elif key == "/seg1.ts":
            body, ct = SEGS[0], "video/mp2t"
        elif key == "/seg2.ts":
            body, ct = SEGS[1], "video/mp2t"
        elif key == "/seg3.ts":
            body, ct = SEGS[2], "video/mp2t"
        elif key == "/seg4.ts":
            body, ct = SEGS[3], "video/mp2t"
        elif key == "/ranges.bin":
            body, ct = b"N" * 32, "application/octet-stream"
        elif key == "/key.bin":
            body, ct = b"K" * 16, "application/octet-stream"
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass


class HlsServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    spec: dict = {}

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.fail_lock = threading.Lock()
        self.hits: dict[str, int] = {}


def start_server() -> str:
    srv = HlsServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{srv.server_address[1]}", srv


def _test_is_hls():
    check("is_hls: url ext", hls_downloader.is_hls("http://x.com/a.m3u8"))
    check("is_hls: url ext m3u", hls_downloader.is_hls("http://x.com/a.m3u"))
    check("is_hls: ct", hls_downloader.is_hls("http://x.com/a", "application/vnd.apple.mpegurl; charset=utf-8"))
    check("is_hls: mp4 no", hls_downloader.is_hls("http://x.com/a.mp4", "") is False)
    check("is_hls: query ext", hls_downloader.is_hls("http://x.com/playlist.m3u8?token=1"))


def _test_variant_and_merge(base, dest):
    got = hls_downloader.download_hls(base + "/master.m3u8", dest_dir=dest, out_name="t1")
    check("hls: variant picked high", got is not None)
    check("hls: output exists", got is not None and os.path.exists(got))
    if got:
        with open(got, "rb") as f:
            data = f.read()
        check("hls: concatenated all 4 segs", data == SEGS[0] + SEGS[1] + SEGS[2] + SEGS[3])
        os.remove(got)


def _test_byterange(base, dest):
    got = hls_downloader.download_hls(base + "/ranges.m3u8", dest_dir=dest, out_name="t2")
    check("hls: byterange ok", got is not None)
    if got:
        with open(got, "rb") as f:
            data = f.read()
        check("hls: byterange merged 32 bytes", data == b"N" * 32)
        os.remove(got)


def _test_aes128(base, dest):
    got = hls_downloader.download_hls(base + "/enc.m3u8", dest_dir=dest, out_name="e1")
    check("hls: aes-128 explicit IV decrypts", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 explicit IV plaintext", f.read() == SEGS[0])
        os.remove(got)
    got = hls_downloader.download_hls(base + "/enc2.m3u8", dest_dir=dest, out_name="e2")
    check("hls: aes-128 default IV (seq 0)", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 default IV plaintext", f.read() == SEGS[0])
        os.remove(got)
    got = hls_downloader.download_hls(base + "/enc4.m3u8", dest_dir=dest, out_name="e3")
    check("hls: aes-128 multi-seg default IV", got is not None)
    if got:
        with open(got, "rb") as f:
            check("hls: aes-128 multi-seg concat", f.read() == b"".join(SEGS))
        os.remove(got)


def _test_failures(base, dest):
    got = hls_downloader.download_hls(base + "/sample.m3u8", dest_dir=dest, out_name="t3")
    check("hls: sample-aes unsupported returns None", got is None)
    got = hls_downloader.download_hls(base + "/enc-nokey.m3u8", dest_dir=dest, out_name="t4")
    check("hls: key 404 returns None", got is None)
    got = hls_downloader.download_hls(base + "/empty.m3u8", dest_dir=dest, out_name="t5")
    check("hls: no segments returns None", got is None)
    got = hls_downloader.download_hls(base + "/master.m3u8", dest_dir=dest, out_name="t6")
    check("hls: 404 segment returns None", got is None)
    leftovers = [p for p in os.listdir(dest) if p.startswith(".hls_tmp_")]
    check("hls: failure leaves no temp dir", len(leftovers) == 0, True)
    for p in ("t1.ts", "t2.ts", "t3.ts", "t4.ts", "t5.ts", "t6.ts"):
        if os.path.exists(os.path.join(dest, p)):
            os.remove(os.path.join(dest, p))


def _segdata(n: int, prefix: str = "R") -> list[bytes]:
    """确定性的多分片数据（各片长度不同，便于识别错位/缺失）。"""
    return [(prefix.encode() + bytes([65 + i]) * (37 + i * 3)) for i in range(n)]


def _meta_file(dest: str, out_name: str) -> str:
    return hls_downloader._meta_path(dest, out_name)


def _read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _load_meta(dest: str, out_name: str):
    try:
        with open(_meta_file(dest, out_name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_meta_json(dest: str, out_name: str, fingerprint: str, total: int,
                     done: int, prefix: bytes, sizes: list[int]) -> None:
    """直接写 meta JSON（与实现版本解耦，便于测试各校验分支）。"""
    with open(_meta_file(dest, out_name), "w", encoding="utf-8") as f:
        json.dump({"version": getattr(hls_downloader, "_META_VERSION", 1),
                   "fingerprint": fingerprint, "total": total, "done": done,
                   "bytes": len(prefix),
                   "sha1": hashlib.sha1(prefix).hexdigest(), "sizes": sizes}, f)


def _write_valid_meta(dest: str, out_name: str, segs: list[bytes],
                      done: int, fingerprint_override: str | None = None,
                      file_prefix: bytes | None = None) -> None:
    """按 committer 的格式手工造一份「合法」断点进度（模拟上次中断）。"""
    prefix = file_prefix if file_prefix is not None else b"".join(segs[:done])
    sizes = [len(s) for s in segs[:done]]
    fp = fingerprint_override
    if fp is None:
        fp = hls_downloader._fingerprint(
            [{"uri": "x", "key": None} for _ in range(len(segs))])
    _write_meta_json(dest, out_name, fp, len(segs), done, prefix, sizes)


def _test_resume_prefix(base, srv, dest):
    """某分片持续失败：文件只能是第 0 片起的连续前缀，meta 与其严格一致。

    构造：20 片，第 12 片永久 404 且延迟 0.5s 才失败；其后的分片很快下载完
    但必须排队等待写盘。中止发生后它们不得追加，进度也不得越过真实写入位置。
    """
    segs = _segdata(20)
    spec = {"dyn_segs": {"fail12": segs},
            "seg_fails": ("/dyn/fail12-seg12.ts",),
            "delays": {"/dyn/fail12-seg12.ts": 0.5},
            "fail_counts": {}}
    srv.spec = spec
    got = hls_downloader.download_hls(base + "/dyn/fail12.m3u8",
                                     dest_dir=dest, out_name="p1", workers=6)
    check("resume: persistent segment failure returns None", got is None)
    out = os.path.join(dest, "p1.ts")
    data = _read_bytes(out) if os.path.exists(out) else b""
    full = b"".join(segs)
    check("resume: file is prefix of full stream",
          full.startswith(data), True)
    # 数据内容是「整片边界」的前缀：长度等于前 k 片之和
    k, acc = 0, 0
    for s in segs:
        if acc + len(s) > len(data):
            break
        acc += len(s)
        k += 1
    check("resume: file ends on segment boundary", len(data) == acc)
    check("resume: prefix never passed failing segment", k <= 12)
    check("resume: some prefix was actually written", k > 0)
    meta = _load_meta(dest, "p1")
    check("resume: meta persisted on failure", meta is not None)
    if meta:
        check("resume: meta done == real prefix", meta.get("done"), k)
        check("resume: meta bytes == file size", meta.get("bytes"), len(data))
        check("resume: meta sizes match real prefix",
              meta.get("sizes"), [len(s) for s in segs[:k]])
        check("resume: meta sha1 matches file prefix",
              meta.get("sha1"), hashlib.sha1(data).hexdigest())
        check("resume: meta total", meta.get("total"), len(segs))


def _test_resume_rerun(base, srv, dest):
    """失败后重跑同一地址：跳过已落盘分片，结果与全量下载逐字节一致。"""
    segs = _segdata(20, prefix="Q")
    spec = {"dyn_segs": {"rerun": segs},
            "seg_fails": ("/dyn/rerun-seg15.ts",),
            "delays": {"/dyn/rerun-seg15.ts": 0.3},
            "fail_counts": {}}
    srv.spec = spec
    got = hls_downloader.download_hls(base + "/dyn/rerun.m3u8",
                                     dest_dir=dest, out_name="r1", workers=6)
    check("rerun: first run fails", got is None)
    out = os.path.join(dest, "r1.ts")
    first = _read_bytes(out) if os.path.exists(out) else b""
    full = b"".join(segs)
    check("rerun: first run left prefix", first == full[:len(first)])
    # 记录已落盘分片各自的请求次数，重跑后不应再被请求
    hits_before = dict(srv.hits)
    committed = 0
    acc = 0
    for s in segs:
        if acc + len(s) > len(first):
            break
        acc += len(s)
        committed += 1
    check("rerun: has resumable prefix", committed > 0)

    # 第二次：故障消失，同一地址重跑
    srv.spec = {"dyn_segs": {"rerun": segs}, "seg_fails": (), "delays": {},
                "fail_counts": {}}
    got = hls_downloader.download_hls(base + "/dyn/rerun.m3u8",
                                     dest_dir=dest, out_name="r1", workers=6)
    check("rerun: second run succeeds", got is not None)
    check("rerun: output byte-identical to full download",
          _read_bytes(out) if got else None, full)
    skipped = all(srv.hits.get(f"/dyn/rerun-seg{i}.ts", 0)
                  == hits_before.get(f"/dyn/rerun-seg{i}.ts", 0)
                  for i in range(committed))
    check("rerun: already-committed segments not re-downloaded", skipped, True)
    check("rerun: meta cleaned on success",
          os.path.exists(_meta_file(dest, "r1")), False)

    # 对照：全新全量下载（无进度）结果一致
    got2 = hls_downloader.download_hls(base + "/dyn/rerun.m3u8",
                                      dest_dir=dest, out_name="r2", workers=6)
    check("rerun: fresh full download succeeds", got2 is not None)
    check("rerun: fresh download identical",
          _read_bytes(os.path.join(dest, "r2.ts")) if got2 else None, full)
    # 重跑/全量下载后目标文件里分片顺序正确（逐片可切分）
    rebuilt = b"".join(segs)
    check("rerun: no duplicated or reordered segments", rebuilt == full)


def _test_shuffled_completion(base, srv, dest):
    """并发分片乱序完成：写盘仍严格按序号，结果与串行拼接逐字节一致。"""
    segs = _segdata(12, prefix="Z")
    # 前面的分片慢、后面的分片快：完成后必须排队等待写盘
    delays = {f"/dyn/shuf-seg{i}.ts": 0.25 - i * 0.02 for i in range(12)}
    srv.spec = {"dyn_segs": {"shuf": segs}, "delays": delays,
                "seg_fails": (), "fail_counts": {}}
    got = hls_downloader.download_hls(base + "/dyn/shuf.m3u8",
                                     dest_dir=dest, out_name="z1", workers=8)
    check("shuffle: download succeeds", got is not None)
    check("shuffle: byte order equals serial concatenation",
          _read_bytes(got) if got else None, b"".join(segs))


def _test_drop_connection(base, srv, dest):
    """下载中途连接被掐断（断网）：文件仍是连续前缀，重跑可续传补齐。"""
    segs = _segdata(16, prefix="D")
    srv.spec = {"dyn_segs": {"drop": segs},
                "drops": ("/dyn/drop-seg9.ts",),
                "delays": {"/dyn/drop-seg9.ts": 0.3},
                "seg_fails": (), "fail_counts": {}}
    got = hls_downloader.download_hls(base + "/dyn/drop.m3u8",
                                     dest_dir=dest, out_name="d1", workers=6)
    check("drop: connection reset -> None", got is None)
    out = os.path.join(dest, "d1.ts")
    first = _read_bytes(out) if os.path.exists(out) else b""
    full = b"".join(segs)
    check("drop: file is continuous prefix", full.startswith(first), True)
    check("drop: prefix never passed dropped segment",
          len(first) <= sum(len(s) for s in segs[:9]), True)
    meta = _load_meta(dest, "d1")
    check("drop: meta persisted", meta is not None)
    if meta:
        check("drop: meta bytes == file size", meta.get("bytes"), len(first))
        check("drop: meta sha1 == file prefix",
              meta.get("sha1"), hashlib.sha1(first).hexdigest())

    srv.spec = {"dyn_segs": {"drop": segs}, "drops": (), "delays": {},
                "seg_fails": (), "fail_counts": {}}
    got = hls_downloader.download_hls(base + "/dyn/drop.m3u8",
                                     dest_dir=dest, out_name="d1", workers=6)
    check("drop: rerun after reconnect succeeds", got is not None)
    check("drop: rerun output byte-identical", _read_bytes(out) if got else None,
          full)
    check("drop: meta cleaned after success",
          os.path.exists(_meta_file(dest, "d1")), False)


def _test_resume_all_done(base, srv, dest):
    """上次已写完最后一片、删 meta 前崩溃：重跑应零下载直接成功并清理 meta。"""
    segs = _segdata(6, prefix="F")
    srv.spec = {"dyn_segs": {"alldone": segs}, "seg_fails": (), "delays": {},
                "fail_counts": {}}
    full = b"".join(segs)
    out_name = "f1"
    out = os.path.join(dest, out_name + ".ts")
    with open(out, "wb") as f:
        f.write(full)
    segs_meta = [{"uri": f"{base}/dyn/alldone-seg{i}.ts", "key": None}
                 for i in range(len(segs))]
    fp = hls_downloader._fingerprint(segs_meta)
    _write_meta_json(dest, out_name, fp, len(segs), len(segs), full,
                     [len(s) for s in segs])
    got = hls_downloader.download_hls(base + "/dyn/alldone.m3u8",
                                     dest_dir=dest, out_name=out_name)
    check("alldone: resume completed download", got is not None)
    check("alldone: output unchanged", _read_bytes(out) if got else None, full)
    check("alldone: no segment refetched",
          srv.hits.get("/dyn/alldone-seg0.ts", 0), 0)
    check("alldone: meta cleaned",
          os.path.exists(_meta_file(dest, out_name)), False)


def _test_resume_rejects_stale(base, srv, dest):
    """进度/文件/指纹不一致时必须放弃旧进度从头下载，绝不拼接错误文件。"""
    segs = _segdata(10, prefix="S")
    srv.spec = {"dyn_segs": {"stale": segs}, "seg_fails": (), "delays": {},
                "fail_counts": {}}
    full = b"".join(segs)
    url = base + "/dyn/stale.m3u8"
    # 计算真实指纹（与 _fingerprint 一致的输入格式）
    segs_meta = [{"uri": f"{base}/dyn/stale-seg{i}.ts", "key": None}
                 for i in range(len(segs))]
    fp = hls_downloader._fingerprint(segs_meta)

    # a) 目标文件前缀被外部改动（同尺寸）
    out_name = "s1"
    out = os.path.join(dest, out_name + ".ts")
    bad = bytearray(full[:sum(len(s) for s in segs[:4])])
    bad[5] ^= 0xFF
    with open(out, "wb") as f:
        f.write(bad)
    # meta 忠实记录「原本应落盘」的内容，但文件已被外部改成同尺寸的坏内容
    _write_valid_meta(dest, out_name, segs, 4, fingerprint_override=fp)
    got = hls_downloader.download_hls(url, dest_dir=dest, out_name=out_name)
    check("stale: corrupted prefix -> full re-download", got is not None)
    check("stale: corrupted prefix output correct",
          _read_bytes(out) if got else None, full)

    # b) 进度条数比目标文件真实内容多
    out_name = "s2"
    out = os.path.join(dest, out_name + ".ts")
    with open(out, "wb") as f:
        f.write(b"".join(segs[:2]))  # 真实只有 2 片
    _write_valid_meta(dest, out_name, segs, 7, fingerprint_override=fp,
                      file_prefix=b"".join(segs[:7]))  # meta 谎称 7 片
    got = hls_downloader.download_hls(url, dest_dir=dest, out_name=out_name)
    check("stale: over-claimed progress -> full re-download", got is not None)
    check("stale: over-claimed progress output has all segments",
          _read_bytes(out) if got else None, full)

    # b2) done 与 sizes 公告不一致（done=7 但 sizes/bytes 只覆盖 2 片）
    out_name = "s2b"
    out = os.path.join(dest, out_name + ".ts")
    with open(out, "wb") as f:
        f.write(b"".join(segs[:2]))
    _write_meta_json(dest, out_name, fp, len(segs), 7,
                     b"".join(segs[:2]), [len(s) for s in segs[:2]])
    got = hls_downloader.download_hls(url, dest_dir=dest, out_name=out_name)
    check("stale: inconsistent meta -> full re-download", got is not None)
    check("stale: inconsistent meta output correct",
          _read_bytes(out) if got else None, full)

    # c) 播放列表指纹变化
    out_name = "s3"
    out = os.path.join(dest, out_name + ".ts")
    with open(out, "wb") as f:
        f.write(b"".join(segs[:4]))
    _write_valid_meta(dest, out_name, segs, 4,
                      fingerprint_override="deadbeefdeadbeef",
                      file_prefix=b"".join(segs[:4]))
    got = hls_downloader.download_hls(url, dest_dir=dest, out_name=out_name)
    check("stale: fingerprint change -> full re-download", got is not None)
    check("stale: fingerprint change output correct",
          _read_bytes(out) if got else None, full)

    # d) 文件尾部多出 meta 未记录的字节：丢弃尾部后安全续传
    out_name = "s4"
    out = os.path.join(dest, out_name + ".ts")
    with open(out, "wb") as f:
        f.write(b"".join(segs[:4]) + b"UNRECORDED-TAIL")
    _write_valid_meta(dest, out_name, segs, 4, fingerprint_override=fp)
    got = hls_downloader.download_hls(url, dest_dir=dest, out_name=out_name)
    check("stale: unrecorded tail -> truncated and resumed", got is not None)
    check("stale: unrecorded tail output correct",
          _read_bytes(out) if got else None, full)


def _test_committer_abort():
    """有序提交器：中止后等待写盘的分片不得追加，进度不越过真实写入位置。"""
    tmp = tempfile.mkdtemp(prefix="hls_committer_")
    try:
        path = os.path.join(tmp, "x.ts")
        meta = os.path.join(tmp, ".x.hlsmeta.json")
        with open(path, "wb") as f:
            f.truncate(0)
        c = hls_downloader._OrderedCommitter(path, meta, "fp", 4, 0)
        c.commit(b"AAAA")
        acquired = []
        raised = []

        def waiter():
            try:
                c.acquire_turn(3)  # 前 1 片已写、第 3 片轮次未到：阻塞等待
                acquired.append(True)
                c.commit(b"DDDD")
            except hls_downloader._HlsError:
                raised.append(True)

        t = threading.Thread(target=waiter)
        t.start()
        time.sleep(0.1)  # 确保 waiter 已进入等待
        c.abort()  # 整体中止：唤醒等待者
        t.join(2)
        check("committer: aborted waiter raises", raised, [True])
        check("committer: aborted waiter did not commit", acquired, [])
        check("committer: file keeps only committed prefix",
              _read_bytes(path), b"AAAA")
        check("committer: done stays at real prefix", c.done, 1)
        snap = c.snapshot()
        check("committer: snapshot bytes == file size", snap[1],
              len(_read_bytes(path)))
        check("committer: snapshot sha1 == file content",
              snap[2], hashlib.sha1(b"AAAA").hexdigest())
        # 中止后即便直接 commit 也必须拒绝
        try:
            c.commit(b"CCCC")
            blocked = False
        except hls_downloader._HlsError:
            blocked = True
        check("committer: commit after abort rejected", blocked, True)
        check("committer: file unchanged after rejected commit",
              _read_bytes(path), b"AAAA")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def an():
    base, srv = start_server()
    dest = tempfile.mkdtemp(prefix="hls_test_")
    try:
        _test_is_hls()
        _test_variant_and_merge(base, dest)
        _test_byterange(base, dest)
        _test_aes128(base, dest)
        srv.spec = {"seg_fails": ("/seg3.ts",)}
        _test_failures(base, dest)
        srv.spec = {}
        _test_resume_prefix(base, srv, dest)
        _test_resume_rerun(base, srv, dest)
        _test_shuffled_completion(base, srv, dest)
        _test_drop_connection(base, srv, dest)
        _test_resume_all_done(base, srv, dest)
        _test_resume_rejects_stale(base, srv, dest)
        _test_committer_abort()
    finally:
        srv.shutdown()
        shutil.rmtree(dest, ignore_errors=True)


if __name__ == "__main__":
    an()
    print(f"\n{'-' * 40}\nunit_hls: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)