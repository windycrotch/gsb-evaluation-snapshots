"""HLS 分片下载测试：用本地 HTTP 服务模拟 m3u8 播放列表 + TS 分片。

覆盖：
1. is_hls：URL 后缀 / Content-Type 识别
2. download_hls：主列表自动选最高带宽变体、相对 URI、多分片并发合并、输出 .ts 正确
3. BYTERANGE 偏移分片（带 Range 头）
4. AES-128 加密流：显式 IV / 默认 IV（分片序号）/ 多分片拼接
5. 失败路径：SAMPLE-AES 不支持、密钥 404、分片 404、无分片返回 None 且不留临时目录
6. 断点续传：正常合并；失败后重跑只补缺失分片；多轮失败-续传；resume=False
   强制全量；播放列表变化触发全量重下；目标文件被外部改写（同尺寸内容篡改 /
   追加脏字节 / 进度越界 / 文件被删）时丢弃进度
"""

import http.server
import json
import os
import shutil
import sys
import tempfile
import threading

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

    def do_GET(self):
        self.server: HlsServer
        spec = self.server.spec
        key = self.path
        hits = spec.setdefault("hits", {})
        hits[key] = hits.get(key, 0) + 1
        # 瞬时失败模拟：先返回 N 次 500，之后正常（用于验证单分片重试）
        flaky = spec.get("flaky", {})
        if flaky.get(key, 0) > 0:
            flaky[key] -= 1
            self.send_response(500)
            self.end_headers()
            return
        if key in spec.get("seg_fails", ()):
            self.send_response(404)
            self.end_headers()
            return
        body = None
        ct = "application/vnd.apple.mpegurl"
        # 测试注入的动态播放列表/分片优先于内置固定资源
        if key in spec.get("playlists", {}):
            body = spec["playlists"][key]
        elif key in spec.get("bodies", {}):
            body, ct = spec["bodies"][key], "video/mp2t"
        elif key == "/master.m3u8":
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
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class HlsServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    spec: dict = {}


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


def _make_stream(srv, prefix, count, tag=""):
    """注册一套自造播放列表 + 分片（内容按序号可区分），返回分片字节列表。"""
    bodies = [f"{prefix}{tag}#{i}".encode() * 7 for i in range(count)]
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:8"]
    for i in range(count):
        lines += ["#EXTINF:8.0,", f"{prefix}_s{i}.ts"]
        srv.spec.setdefault("bodies", {})[f"/{prefix}_s{i}.ts"] = bodies[i]
    lines.append("#EXT-X-ENDLIST")
    srv.spec.setdefault("playlists", {})[f"/{prefix}.m3u8"] = \
        ("\n".join(lines) + "\n").encode()
    return bodies


def _read_file(path):
    with open(path, "rb") as f:
        return f.read()


def _read_meta(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _test_resume_merge(base, srv, dest):
    """正常合并：全部成功、内容与播放列表一一对应、进度文件被删除。"""
    srv.spec = {}
    bodies = _make_stream(srv, "merge", 6)
    got = hls_downloader.download_hls(base + "/merge.m3u8", dest_dir=dest,
                                      out_name="m1", workers=4)
    check("hls resume: merge ok", got is not None)
    if got:
        check("hls resume: merge content exact", _read_file(got),
              b"".join(bodies))
    check("hls resume: merge meta removed",
          os.path.exists(os.path.join(dest, ".m1.hlsmeta.json")), False)

    # 单分片瞬时失败（500）重试后应成功
    bodies = _make_stream(srv, "flaky", 5)
    srv.spec["flaky"] = {"/flaky_s2.ts": 2}
    got = hls_downloader.download_hls(base + "/flaky.m3u8", dest_dir=dest,
                                      out_name="m2", workers=1)
    check("hls resume: transient 500 retried", got is not None)
    check("hls resume: transient retry content exact",
          _read_file(got) == b"".join(bodies) if got else False)


def _hits(srv, seg):
    return srv.spec.setdefault("hits", {}).get(seg, 0)


def _test_resume_after_failure(base, srv, dest):
    """失败后重跑：失败返回 None，旧进度保留；重跑只补缺失分片并最终成功。"""
    srv.spec = {}
    bodies = _make_stream(srv, "rf", 6)
    srv.spec["seg_fails"] = ("/rf_s4.ts",)
    meta = os.path.join(dest, ".rf.hlsmeta.json")
    out = os.path.join(dest, "rf.ts")
    got = hls_downloader.download_hls(base + "/rf.m3u8", dest_dir=dest,
                                      out_name="rf", workers=1)
    check("hls resume: failed run returns None", got is None)
    check("hls resume: failed run keeps meta", os.path.exists(meta))
    check("hls resume: failed run keeps prefix bytes",
          _read_file(out) == b"".join(bodies[:4]) if os.path.exists(out)
          else False)
    m = _read_meta(meta)
    check("hls resume: meta done == committed prefix", m.get("done"), 4)
    check("hls resume: meta bytes == real size",
          m.get("bytes"), os.path.getsize(out))
    check("hls resume: failure hit prefix once",
          [_hits(srv, f"/rf_s{i}.ts") for i in range(4)], [1, 1, 1, 1])
    check("hls resume: failure hit missing seg", _hits(srv, "/rf_s4.ts"), 1)

    # 重跑：清掉故障，已提交的 4 片不应再请求
    srv.spec["seg_fails"] = ()
    before = {i: _hits(srv, f"/rf_s{i}.ts") for i in range(6)}
    got = hls_downloader.download_hls(base + "/rf.m3u8", dest_dir=dest,
                                      out_name="rf", workers=1)
    check("hls resume: retry succeeds", got is not None)
    check("hls resume: retry content exact",
          _read_file(got) == b"".join(bodies) if got else False)
    check("hls resume: retry did not refetch prefix",
          [_hits(srv, f"/rf_s{i}.ts") - before[i] for i in range(4)],
          [0, 0, 0, 0])
    check("hls resume: retry fetched missing+rest",
          [_hits(srv, f"/rf_s{i}.ts") - before[i] for i in (4, 5)], [1, 1])
    check("hls resume: retry removes meta", os.path.exists(meta), False)

    # 并发场景：8 线程里第 12 片失败，已落盘内容仍须是连续前缀、进度可直接续传
    srv.spec = {}
    bodies = _make_stream(srv, "cc", 20)
    srv.spec["seg_fails"] = ("/cc_s12.ts",)
    cmeta = os.path.join(dest, ".cc.hlsmeta.json")
    cout = os.path.join(dest, "cc.ts")
    got = hls_downloader.download_hls(base + "/cc.m3u8", dest_dir=dest,
                                      out_name="cc", workers=8)
    check("hls resume: concurrent failure returns None", got is None)
    prefix = _read_file(cout) if os.path.exists(cout) else b""
    n = 0
    acc = b""
    while n < len(bodies) and len(acc) < len(prefix):
        acc += bodies[n]
        n += 1
    check("hls resume: concurrent failure leaves continuous prefix",
          acc == prefix and len(prefix) % 7 == 0)
    check("hls resume: concurrent failure prefix not whole", n < 20)
    m = _read_meta(cmeta)
    check("hls resume: concurrent meta matches file",
          (m.get("done"), m.get("bytes")), (n, len(prefix)))
    srv.spec["seg_fails"] = ()
    got = hls_downloader.download_hls(base + "/cc.m3u8", dest_dir=dest,
                                      out_name="cc", workers=8)
    check("hls resume: concurrent retry succeeds", got is not None)
    check("hls resume: concurrent retry content exact",
          _read_file(got) == b"".join(bodies) if got else False)

    # 重试耗尽：同一分片连续 5xx 超过重试次数 → 失败
    srv.spec = {}
    _make_stream(srv, "ex", 4)
    srv.spec["flaky"] = {"/ex_s1.ts": 99}
    got = hls_downloader.download_hls(base + "/ex.m3u8", dest_dir=dest,
                                      out_name="ex", workers=1)
    check("hls resume: retries exhausted returns None", got is None)


def _test_resume_multiple_rounds(base, srv, dest):
    """多次失败-续传：每一轮的进度都对齐真实文件，可反复续传至成功。"""
    srv.spec = {}
    bodies = _make_stream(srv, "mr", 12)
    meta = os.path.join(dest, ".mr.hlsmeta.json")
    out = os.path.join(dest, "mr.ts")
    for fail_at, expected in ((5, 5), (9, 9)):
        srv.spec["seg_fails"] = (f"/mr_s{fail_at}.ts",)
        got = hls_downloader.download_hls(base + "/mr.m3u8", dest_dir=dest,
                                          out_name="mr", workers=1)
        check(f"hls resume: round fail {fail_at}", got is None)
        m = _read_meta(meta)
        check(f"hls resume: round {fail_at} meta aligns",
              (m.get("done"), m.get("bytes")),
              (expected, os.path.getsize(out)))
        check(f"hls resume: round {fail_at} content is prefix",
              _read_file(out), b"".join(bodies[:expected]))
    srv.spec["seg_fails"] = ()
    got = hls_downloader.download_hls(base + "/mr.m3u8", dest_dir=dest,
                                      out_name="mr", workers=1)
    check("hls resume: multi-round final exact",
          _read_file(got) == b"".join(bodies) if got else False)


def _test_resume_disabled(base, srv, dest):
    """resume=False：即便进度可用也必须全量重下。"""
    srv.spec = {}
    bodies = _make_stream(srv, "rd", 5)
    srv.spec["seg_fails"] = ("/rd_s3.ts",)
    out = os.path.join(dest, "rd.ts")
    got = hls_downloader.download_hls(base + "/rd.m3u8", dest_dir=dest,
                                      out_name="rd", workers=1)
    check("hls resume: disabled setup fails", got is None)
    srv.spec["seg_fails"] = ()
    before = _hits(srv, "/rd_s0.ts")
    got = hls_downloader.download_hls(base + "/rd.m3u8", dest_dir=dest,
                                      out_name="rd", workers=1, resume=False)
    check("hls resume: disabled redownloads",
          _hits(srv, "/rd_s0.ts") - before, 1)
    check("hls resume: disabled content exact",
          _read_file(out) == b"".join(bodies) if got else False)


def _test_resume_playlist_changed(base, srv, dest):
    """播放列表换内容：旧进度/旧文件一律丢弃，按新列表全量重下。"""
    srv.spec = {}
    _make_stream(srv, "old", 6)
    srv.spec["seg_fails"] = ("/old_s4.ts",)
    meta = os.path.join(dest, ".pc.hlsmeta.json")
    out = os.path.join(dest, "pc.ts")
    got = hls_downloader.download_hls(base + "/old.m3u8", dest_dir=dest,
                                      out_name="pc", workers=1)
    check("hls resume: changed run1 fails", got is None)
    check("hls resume: changed run1 leaves prefix",
          _read_file(out) == b"".join(
              [f"old#{i}".encode() * 7 for i in range(4)]))

    # 同输出名、不同分片 URI 的新播放列表
    new_bodies = _make_stream(srv, "new", 5, tag="v2")
    srv.spec["seg_fails"] = ()
    old0_before = _hits(srv, "/old_s0.ts")
    got = hls_downloader.download_hls(base + "/new.m3u8", dest_dir=dest,
                                      out_name="pc", workers=1)
    check("hls resume: changed playlist redownloads", got is not None)
    check("hls resume: changed playlist content exact",
          _read_file(got) == b"".join(new_bodies) if got else False)
    check("hls resume: old segments not reused",
          _hits(srv, "/old_s0.ts") - old0_before, 0)
    check("hls resume: new segments all fetched",
          [_hits(srv, f"/new_s{i}.ts") for i in range(5)], [1] * 5)
    check("hls resume: changed playlist removes meta",
          os.path.exists(meta), False)


def _test_resume_target_tampered(base, srv, dest):
    """目标文件被外部改写：同尺寸篡改 / 追加脏字节 / 进度越界 / 删文件均丢弃进度。"""
    srv.spec = {}
    bodies = _make_stream(srv, "tp", 6)
    meta = os.path.join(dest, ".tp.hlsmeta.json")
    out = os.path.join(dest, "tp.ts")

    def fail_then(label):
        srv.spec["seg_fails"] = ("/tp_s4.ts",)
        got = hls_downloader.download_hls(base + "/tp.m3u8", dest_dir=dest,
                                          out_name="tp", workers=1)
        srv.spec["seg_fails"] = ()
        check(label + ": failed run", got is None)

    def rerun_and_check(label):
        before = _hits(srv, "/tp_s0.ts")
        got = hls_downloader.download_hls(base + "/tp.m3u8", dest_dir=dest,
                                          out_name="tp", workers=1)
        check(label + ": redownloads", got is not None)
        check(label + ": content exact",
              _read_file(got) == b"".join(bodies) if got else False)
        check(label + ": refetched first seg",
              _hits(srv, "/tp_s0.ts") - before, 1)

    # ① 同尺寸内容篡改（大小一致，只有摘要能发现）
    fail_then("hls resume: tamper setup")
    prefix = _read_file(out)
    with open(out, "r+b") as f:
        f.seek(0)
        f.write(bytes([prefix[0] ^ 0xFF]) + prefix[1:])
    rerun_and_check("hls resume: same-size tamper")

    # ② 追加脏字节（大小对不上）
    fail_then("hls resume: append setup")
    with open(out, "ab") as f:
        f.write(b"GARBAGE")
    rerun_and_check("hls resume: appended garbage")

    # ③ 进度越界：done 超出当前分片总数
    fail_then("hls resume: out-of-range setup")
    m = _read_meta(meta)
    m["done"] = 999
    with open(meta, "w", encoding="utf-8") as f:
        json.dump(m, f)
    rerun_and_check("hls resume: out-of-range")

    # ④ 目标文件被删除：进度不可信，全量重下
    fail_then("hls resume: missing target setup")
    os.remove(out)
    rerun_and_check("hls resume: missing target")
    check("hls resume: missing target removes meta", os.path.exists(meta),
          False)


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
        _test_resume_merge(base, srv, dest)
        _test_resume_after_failure(base, srv, dest)
        _test_resume_multiple_rounds(base, srv, dest)
        _test_resume_disabled(base, srv, dest)
        _test_resume_playlist_changed(base, srv, dest)
        _test_resume_target_tampered(base, srv, dest)
    finally:
        srv.shutdown()
        shutil.rmtree(dest, ignore_errors=True)


if __name__ == "__main__":
    an()
    print(f"\n{'-' * 40}\nunit_hls: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)