"""HLS（m3u8）流媒体下载器：纯 Python 实现，免 ffmpeg 依赖。

背景：很多视频站（尤其直播回放/点播平台）只给 m3u8 分片流，直链下载器
拿不到。本模块把「播放列表 + TS 分片」下载后**流式写入**单个目标 .ts 文件
（视频/音频 TS 分片可被主流播放器直接播放，也可用 ffmpeg -i 转 mp4），
并支持**断点续传**（中断后重跑同一 URL/文件名，已落盘分片不重复下载）。

能力与边界：
- 支持主播放列表（#EXT-X-STREAM-INF 多清晰度变速）→ 自动选最高带宽变体
- 支持相对/绝对分片 URI、#EXT-X-BYTERANGE 偏移分片、注释行
- 支持 AES-128 加密流（#EXT-X-KEY:METHOD=AES-128，pycryptodome 解密；
  IV 未声明时按分片序号作默认 IV；密钥按 URI 缓存复用）
- 分片并发下载（默认 8 线程）+ 单分片重试；下载完成按序号**有序提交**，
  直接追加写入目标文件（不留整目录临时分片）。目标文件里的内容永远是从
  第 0 片开始的连续前缀：整体中止后，仍在等待写盘的分片一律丢弃
- 断点续传：进度记在 ``dest_dir/.{out_name}.hlsmeta.json``（分片指纹 +
  已提交数 + 已写入字节数 + 前缀 SHA-1）。进度只在写盘成功后推进，并在
  锁内取**一致快照**落盘，因此 meta 记录的字节数永远不超过文件真实内容；
  失败返回前强制落盘一次，成功完成后自动删除
- 续传前校验：分片指纹、分片总数、文件字节数、文件内容前缀 SHA-1 必须与
  meta 完全吻合，任一不符（播放列表变化 / 目标文件被外部改动 / 进度与
  文件不一致）都放弃旧进度，从头全量下载，绝不拼接出错误文件
- 不支持：SAMPLE-AES 等其它加密方式、加密分片的 BYTERANGE 变体、
  直播流（无 #EXT-X-ENDLIST 且数量无限），报明确错误而不是卡死

用法：
    from hls_downloader import download_hls, is_hls
    path = download_hls("https://example.com/master.m3u8",
                        dest_dir="videos", out_name="clip")
    # -> videos/clip.ts
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.parse import urlparse

_M3U8_EXTS = (".m3u8", ".m3u")
_M3U8_CTS = ("application/vnd.apple.mpegurl", "application/x-mpegurl",
             "audio/mpegurl", "audio/x-mpegurl")
_EXTINF_RE = re.compile(r"#EXTINF:\s*([\d.]+)")
_BYTERANGE_RE = re.compile(r"#EXT-X-BYTERANGE:\s*(\d+)(?:@(\d+))?")
_KEY_ATTR_RE = re.compile(r'(\w+)=(?:"([^"]+)"|([^,"\s]+))')
#: 密钥缓存：URI -> (bytes, 时间戳)；TTL 内复用，过期重取（CDN 签名 token
#: 有时效性，永久缓存会拿着过期密钥反复解密失败）
_KEY_CACHE: dict[str, tuple[bytes, float]] = {}
_KEY_CACHE_TTL = 6 * 3600  # 6 小时
_KEY_CACHE_MAX = 128       # 最多缓存 128 个密钥，防进程内无限膨胀
_KEY_CACHE_LOCK = threading.Lock()

_META_VERSION = 3
_META_BATCH = 16  # 每提交 N 片落盘一次断点进度
_HASH_CHUNK = 1 << 20  # 读取/校验已落盘前缀的分块大小


def is_hls(url: str, content_type: str = "") -> bool:
    """URL 或 Content-Type 是否指向 HLS 播放列表。"""
    if url:
        path = urlparse(url).path.lower()
        if path.endswith(_M3U8_EXTS):
            return True
    ct = (content_type or "").split(";")[0].strip().lower()
    return ct in _M3U8_CTS


class _HlsError(Exception):
    """HLS 下载失败（原因可读）。"""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _fetch(url: str, referer: str = "", timeout: int = 20) -> bytes:
    """拉取播放列表（含重试的常规 GET；会话用完即关，不积累连接）。"""
    from gui_fetch import FetchSession
    hdrs = {"Referer": referer} if referer else {}
    last = None
    for _ in range(2):
        try:
            with FetchSession() as s:
                resp = s.get(url, headers=hdrs, timeout=timeout)
            if resp.status_code >= 400:
                raise _HlsError(f"HTTP {resp.status_code}: {url}")
            data = resp.content
            if not data:
                raise _HlsError(f"空响应: {url}")
            return data
        except _HlsError:
            raise
        except Exception as exc:
            last = exc
    raise _HlsError(f"拉取失败: {last}")


def _resolve_uri(base: str, uri: str) -> str:
    """分片 URI 相对/绝对/锚点解析。"""
    uri = uri.strip()
    if not uri:
        return ""
    if uri.startswith("//"):
        return f"{urlparse(base).scheme or 'https'}:{uri}"
    if "://" in uri:
        return uri
    from urllib.parse import urljoin
    return urljoin(base, uri)


def _pick_variant(master: bytes, master_url: str) -> str:
    """含 #EXT-X-STREAM-INF 的主列表：挑最高带宽变体，返回其子列表 URL。"""
    text = master.decode("utf-8", "replace")
    best_url, best_bw = "", -1
    pending: int | None = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-STREAM-INF"):
            m = re.search(r"BANDWIDTH\s*=\s*(\d+)", line)
            pending = int(m.group(1)) if m else 0
        elif line and not line.startswith("#"):
            if pending is not None and pending > best_bw:
                best_bw, best_url = pending, line
            pending = None
    return _resolve_uri(master_url, best_url) if best_url else ""


def _parse_key(line: str, playlist_url: str) -> dict | None:
    """解析 #EXT-X-KEY 行 -> {uri, iv}；iv 为 bytes 或 None（用分片序号）。

    METHOD=NONE 或无 METHOD 表示清除密钥；AES-128 之外的方法明确报错。
    """
    attrs: dict[str, str] = {}
    for k, v1, v2 in _KEY_ATTR_RE.findall(line):
        attrs[k.upper()] = v1 or v2
    method = attrs.get("METHOD", "").strip().upper()
    if not method or method == "NONE":
        return None
    if method != "AES-128":
        raise _HlsError(f"暂不支持的加密方式: {method}")
    uri = (attrs.get("URI") or "").strip()
    iv: bytes | None = None
    iv_hex = (attrs.get("IV") or "").strip()
    if iv_hex:
        h = iv_hex[2:] if iv_hex.lower().startswith("0x") else iv_hex
        if len(h) % 2:
            h = "0" + h
        try:
            iv = bytes.fromhex(h)
        except ValueError:
            raise _HlsError(f"非法的 IV: {iv_hex}")
    return {"uri": _resolve_uri(playlist_url, uri) if uri else "", "iv": iv}


def _parse_segments(playlist: bytes, playlist_url: str) -> list[dict]:
    """解析播放列表为 [{uri, length, offset, key}, ...]。

    key 为当前生效的加密规格（#EXT-X-KEY），无加密时为 None。
    """
    text = playlist.decode("utf-8", "replace")
    segs: list[dict] = []
    key: dict | None = None
    pending_range: tuple[int, int] | None = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#"):
            if line.startswith("#EXT-X-KEY"):
                key = _parse_key(line, playlist_url)
                continue
            m = _BYTERANGE_RE.search(line)
            if m:
                pending_range = (int(m.group(1)), int(m.group(2) or 0))
            continue
        if not line:
            continue
        uri = _resolve_uri(playlist_url, line)
        if not uri:
            continue
        if pending_range:
            seg = {"uri": uri, "len": pending_range[0],
                   "offset": pending_range[1], "key": key}
            pending_range = None
        else:
            seg = {"uri": uri, "len": 0, "offset": 0, "key": key}
        if key and seg["len"]:
            raise _HlsError("加密分片暂不支持 BYTERANGE 变体")
        segs.append(seg)
    if not segs:
        raise _HlsError("播放列表无分片")
    return segs


def _fetch_key(key_uri: str) -> bytes:
    """获取 AES-128 密钥（按 URI 缓存复用，TTL/条数双限；失败抛 _HlsError）。"""
    if not key_uri:
        raise _HlsError("缺少密钥 URI")
    now = time.time()
    with _KEY_CACHE_LOCK:
        hit = _KEY_CACHE.get(key_uri)
        if hit and now - hit[1] < _KEY_CACHE_TTL:
            return hit[0]
    key = _fetch(key_uri, referer="", timeout=20)
    if len(key) not in (16, 24, 32):
        raise _HlsError(f"密钥长度非法（{len(key)} 字节）")
    with _KEY_CACHE_LOCK:
        _KEY_CACHE[key_uri] = (key, now)
        # 超出条数上限：淘汰最旧（按时间戳），只保留最新一半
        if len(_KEY_CACHE) > _KEY_CACHE_MAX:
            for old in sorted(_KEY_CACHE, key=lambda k: _KEY_CACHE[k][1])[
                    :len(_KEY_CACHE) - _KEY_CACHE_MAX // 2]:
                _KEY_CACHE.pop(old, None)
    return key


def _decrypt_segment(data: bytes, key_spec: dict, seq: int) -> bytes:
    """AES-128-CBC 解密单个分片（PKCS7 去填充）。"""
    try:
        from Crypto.Cipher import AES
    except ImportError:
        raise _HlsError("缺少 pycryptodome 库（pip install pycryptodome）")
    if len(data) % 16:
        raise _HlsError("分片长度非 16 对齐（加密流异常）")
    key = _fetch_key(key_spec["uri"])
    iv = key_spec["iv"] if key_spec["iv"] is not None else seq.to_bytes(16, "big")
    if len(iv) != 16:
        raise _HlsError("非法 IV 长度")
    plain = AES.new(key, AES.MODE_CBC, iv).decrypt(data)
    n = plain[-1]
    if n < 1 or n > 16 or plain[-n:] != bytes([n]) * n:
        raise _HlsError("分片 PKCS7 填充校验失败")
    return plain[:-n]


class _ThreadSessions:
    """每线程一个 FetchSession 的会话池（下载结束统一 close_all）。

    原来每个分片都 new 一个 session 且不 close：8 线程 × N 分片叠加成
    数十个未关闭会话，长任务会耗尽 socket/FD。改为每线程复用 1 个会话，
    最多 workers 个常驻期间存活，任务结束全部关闭。
    """

    def __init__(self):
        self._local = threading.local()
        self._all: list = []
        self._lock = threading.Lock()

    def get(self):
        s = getattr(self._local, "session", None)
        if s is None:
            from gui_fetch import FetchSession
            s = FetchSession()
            self._local.session = s
            with self._lock:
                self._all.append(s)
        return s

    def close_all(self) -> None:
        with self._lock:
            for s in self._all:
                try:
                    s.close()
                except Exception:
                    pass
            self._all.clear()


def _download_segment(url: str, referer: str, offset: int, length: int,
                      key: dict | None = None, seq: int = 0,
                      sessions: _ThreadSessions | None = None) -> bytes:
    """下载单个分片（BYTERANGE 时带 Range 头；加密流解密后返回明文）。"""
    hdrs = {"Referer": referer} if referer else {}
    if length > 0:
        hdrs["Range"] = f"bytes={offset}-{offset + length - 1}"
    if sessions is not None:
        resp = sessions.get().get(url, headers=hdrs, timeout=30)
    else:  # 无会话池（直接调用/测试）：一次性会话，用完即关
        from gui_fetch import FetchSession
        with FetchSession() as s:
            resp = s.get(url, headers=hdrs, timeout=30)
    if resp.status_code >= 400:
        raise _HlsError(f"分片 HTTP {resp.status_code}: {url}")
    data = resp.content
    if not data:
        raise _HlsError(f"分片空响应: {url}")
    if length > 0:
        # 服务器若不支持 Range（仍回 200 全文），截断到请求长度防重复
        data = data[:length]
    if key:
        data = _decrypt_segment(data, key, seq)
    return data


# ---------------------------------------------------------------------------
# 断点续传：进度 meta 文件（fingerprint + 已提交数 + 字节数）
# ---------------------------------------------------------------------------

def _meta_path(dest_dir: str, out_name: str) -> str:
    return os.path.join(dest_dir, f".{out_name}.hlsmeta.json")


def _fingerprint(segs: list[dict]) -> str:
    """分片/密钥 URI 指纹：任一变化即判定播放列表不同，全量重下。"""
    h = hashlib.sha1()
    for i, s in enumerate(segs):
        h.update(f"{i}:{s['uri']}:{(s.get('key') or {}).get('uri', '')}:".encode())
    return h.hexdigest()[:16]


def _prefix_digest(path: str, limit: int) -> tuple[str, int, Any]:
    """计算文件前 limit 字节的 SHA-1，返回 (hexdigest, 实际读取字节数, hasher)。

    文件短于 limit 时按实际长度计算（调用方据此发现长度不符）。hasher 已吞入
    该前缀内容，可供续传时继续增量计算完整前缀摘要，无需二次读盘。
    """
    h = hashlib.sha1()
    read = 0
    with open(path, "rb") as f:
        while read < limit:
            chunk = f.read(min(_HASH_CHUNK, limit - read))
            if not chunk:
                break
            h.update(chunk)
            read += len(chunk)
    return h.hexdigest(), read, h


def _read_meta(path: str, total: int, fingerprint: str,
               dest: str) -> tuple[int, Any, list[int]]:
    """读取续传进度，返回 (done, prefix_hasher, sizes)；不可用时返回 (0, None, [])。

    可用条件（全部满足才续传，否则从头全量重下）：
    - 版本、分片指纹、分片总数一致
    - 进度自洽：done 与 sizes 长度一致，bytes 恰为 sizes 之和
    - 目标文件存在，且字节数不小于 meta 记录（多出来的部分视为未记录写入）
    - 目标文件中前 ``bytes`` 字节的内容 SHA-1 与 meta 记录严格一致

    ``sizes`` 记录已提交分片各自的字节数，用来保证「进度条数」与「文件字节
    数」严格对应——即便进度被改成比真实内容大的数，也会因长度/和值不合而
    被识破，绝不跳过尚未写入的分片。
    """
    try:
        with open(path, encoding="utf-8") as f:
            m = json.load(f)
        if m.get("version") != _META_VERSION:
            return 0, None, []
        if m.get("fingerprint") != fingerprint:
            return 0, None, []
        if int(m.get("total", -1)) != total:
            return 0, None, []
        done, bytes_done = int(m.get("done", 0)), int(m.get("bytes", 0))
        digest = str(m.get("sha1", ""))
        sizes = m.get("sizes")
        if not isinstance(sizes, list):
            return 0, None, []
        sizes = [int(s) for s in sizes]
        if done <= 0 or done > total or bytes_done <= 0 or not digest:
            return 0, None, []
        if len(sizes) != done or sum(sizes) != bytes_done or min(sizes) <= 0:
            return 0, None, []  # 进度与字节数不自洽
        if not os.path.exists(dest):
            return 0, None, []
        size = os.path.getsize(dest)
        if size < bytes_done:
            return 0, None, []  # 文件比记录的短：进度超出真实内容，不可信
        actual, read, hasher = _prefix_digest(dest, bytes_done)
        if read != bytes_done or actual != digest:
            return 0, None, []  # 内容前缀被外部改动，放弃旧进度
        if size != bytes_done:
            # 文件尾部有 meta 未记录的字节（上次崩溃在写盘后、落盘前）。
            # 无法确认这些字节是完整分片，丢弃尾部，回到最后一次可信进度。
            with open(dest, "r+b") as f:
                f.truncate(bytes_done)
        return done, hasher, sizes
    except (OSError, ValueError, TypeError):
        return 0, None, []


def _write_meta(path: str, fingerprint: str, total: int, done: int,
                bytes_done: int, digest: str, sizes: list[int]) -> None:
    """原子落盘断点进度（先写 .tmp 再 os.replace，避免半截 JSON）。

    失败静默——不影响主流程，最多丢一点进度（重跑会从头/回退到可信前缀）。
    """
    tmp = f"{path}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": _META_VERSION, "fingerprint": fingerprint,
                       "total": total, "done": done, "bytes": bytes_done,
                       "sha1": digest, "sizes": sizes}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


class _OrderedCommitter:
    """有序提交器：并发下载、按分片序号顺序追加写入目标文件。

    worker i 下载完成后等待前 i-1 片都已写盘再追加，保证文件内分片顺序；
    因此文件内容永远是从第 0 片开始的连续前缀。进度（已提交片数 / 字节数 /
    前缀 SHA-1）只在写盘成功后、持锁时推进，并取**一致快照**落盘，外部
    任何时刻看到的 meta 都不会超出文件真实内容。
    """

    def __init__(self, path: str, meta_path: str, fingerprint: str,
                 total: int, start: int, hasher: Any = None,
                 sizes: list[int] | None = None) -> None:
        self._path = path
        self._meta_path = meta_path
        self._fingerprint = fingerprint
        self._total = total
        self._lock = threading.Condition()
        self._done = start          # 已提交（写盘）分片数
        self._bytes = 0             # 已写字节数
        self._sizes: list[int] = []  # 每个已提交分片的字节数
        self._aborted = False
        self._meta_lock = threading.Lock()
        self._persisted = (-1, 0, "")  # 已落盘快照（done, bytes, sha1）
        if start:
            self._bytes = os.path.getsize(path) if os.path.exists(path) else 0
            self._sizes = list(sizes or [])
            if hasher is None:  # 兜底：调用方未传入前缀 hasher
                _d, _n, hasher = _prefix_digest(path, self._bytes)
        self._sha = hasher if hasher is not None else hashlib.sha1()

    def acquire_turn(self, idx: int) -> None:
        """等待轮到自己写盘（idx 之前的分片均已提交）。

        整体失败（abort）后立即抛 _HlsError，让 worker 放弃本轮提交，
        保证已落盘分片永远是从 0 开始的连续递增序列（断点续传安全）。
        """
        with self._lock:
            while self._done < idx:
                if self._aborted:
                    raise _HlsError("下载已中止")
                self._lock.wait()
            if self._aborted:
                raise _HlsError("下载已中止")

    def abort(self) -> None:
        """整体失败信号：唤醒所有等待写盘的分片，让 executor 能正常收尾。

        置位后任何尚未开始写的 commit 都会拒绝追加，已落盘的内容保持为
        第 0 片起的连续前缀。
        """
        with self._lock:
            self._aborted = True
            self._lock.notify_all()

    def commit(self, data: bytes) -> None:
        """追加一段数据并推进进度；每批落盘一次 meta。

        写盘失败直接向上抛（由 work 判为不可重试，触发整体中止）——绝不
        重试写盘，否则可能重复追加同一分片。

        顺序保证：写 meta 之前先 fsync 数据文件，因此断电也不会出现
        「meta 记了已完成、文件里还没有」的情形。fsync 只在批量落盘时
        做（不是每片），避免多线程被磁盘刷写串行拖慢。
        """
        with self._lock:
            if self._aborted:  # 排队期间已被中止：丢弃，不追加
                raise _HlsError("下载已中止")
            with open(self._path, "ab") as f:
                f.write(data)
                f.flush()
            self._done += 1
            self._bytes += len(data)
            self._sizes.append(len(data))
            self._sha.update(data)
            need_flush = self._done % _META_BATCH == 0 or self._done == self._total
            snap = ((self._done, self._bytes, self._sha.hexdigest(),
                     list(self._sizes)) if need_flush else None)
            self._lock.notify_all()
        if snap is not None:
            self._persist(*snap)

    def _persist(self, done: int, bytes_done: int, digest: str,
                 sizes: list[int]) -> None:
        """按 done 单调递增写 meta，防止旧快照覆盖新快照。

        写 meta 前先把数据文件 fsync：保证落盘的 meta 所声明的字节一定已经
        真正在磁盘上（否则断电后 meta 会比文件新，重跑会跳过尚未写入的分片）。
        """
        with self._meta_lock:
            if done < self._persisted[0]:
                return
            # 用 r+b 打开（不存在则跳过）：绝不能在目标文件被外部删除后
            # 以 "ab" 把它重建为空文件，否则 meta 与文件内容将不对应
            try:
                with open(self._path, "r+b") as f:
                    os.fsync(f.fileno())
            except OSError:
                pass
            self._persisted = (done, bytes_done, digest)
            _write_meta(self._meta_path, self._fingerprint, self._total,
                        done, bytes_done, digest, sizes)

    def snapshot(self) -> tuple[int, int, str, list[int]]:
        """取当前一致进度快照 (done, bytes, sha1, sizes)。"""
        with self._lock:
            return (self._done, self._bytes, self._sha.hexdigest(),
                    list(self._sizes))

    def flush(self) -> None:
        """强制把当前一致快照落盘（失败返回前调用，保住可续传进度）。"""
        self._persist(*self.snapshot())

    @property
    def done(self) -> int:
        with self._lock:
            return self._done


def download_hls(url: str, dest_dir: str, out_name: str = "stream",
                 referer: str = "", workers: int = 8,
                 max_segments: int = 15_000,
                 resume: bool = True) -> str | None:
    """下载 m3u8 流。成功返回最终 .ts 文件绝对路径；失败返回 None。

    - 主列表自动选最高带宽变体
    - 分片并发下载，完成即按序追加写入目标文件（不留临时分片目录）；
      单分片失败即整体失败（调用方可回退直链）
    - 断点续传：进度记在 .out_name.hlsmeta.json，中断后重跑同 URL 续传；
      成功后清理；播放列表/目标文件变化时自动全量重下
    """
    dest: str | None = None
    committer: _OrderedCommitter | None = None
    meta = ""
    try:
        os.makedirs(dest_dir, exist_ok=True)
        master = _fetch(url, referer=referer)
        playlist_url = _pick_variant(master, url) or url
        playlist = _fetch(playlist_url, referer=referer) if playlist_url != url \
            else master
        segs = _parse_segments(playlist, playlist_url)
        if len(segs) > max_segments:
            raise _HlsError(
                f"分片过多({len(segs)}>{max_segments})，疑似直播流，跳过")
        dest = os.path.join(dest_dir, out_name + ".ts")
        meta = _meta_path(dest_dir, out_name)
        fingerprint = _fingerprint(segs)

        start, prefix_hasher = 0, None
        sizes: list[int] = []
        if resume:
            start, prefix_hasher, sizes = _read_meta(meta, len(segs),
                                                     fingerprint, dest)
            if start:
                print(f"[HLS] 断点续传：跳过已完成的 {start}/{len(segs)} 个分片")
        if not start:
            # 全量重下：清掉旧 meta 与旧的半截/污染文件，保证从空文件开始
            for stale in (meta, dest):
                try:
                    os.remove(stale)
                except OSError:
                    pass
            with open(dest, "wb") as f:
                f.truncate(0)
            sizes = []

        committer = _OrderedCommitter(dest, meta, fingerprint, len(segs), start,
                                      prefix_hasher, sizes)
        committer.flush()  # 立即把起始进度落盘，meta 与文件字节数从此严格对应
        fail_reason: list[str] = []
        lock = threading.Lock()
        thread_sessions = _ThreadSessions()

        def work(idx: int, seg: dict) -> None:
            if fail_reason:
                return
            last: Exception | None = None
            for _ in range(3):
                # 下载 + 解密（可重试）；写盘单独处理，绝不重试写盘
                try:
                    data = _download_segment(seg["uri"], referer, seg["offset"],
                                             seg["len"], seg.get("key"), idx,
                                             sessions=thread_sessions)
                except _HlsError as exc:
                    last = exc
                    break
                except Exception as exc:
                    last = exc
                    continue
                try:
                    committer.acquire_turn(idx)
                    committer.commit(data)
                    return
                except _HlsError:
                    return  # 已被中止：丢弃本片，不再追加
                except Exception as exc:
                    last = exc
                    break  # 写盘异常不可重试，按整体失败处理
            with lock:
                if not fail_reason:
                    fail_reason.append(str(last) or type(last).__name__)

        try:
            with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
                futs = [pool.submit(work, i, s)
                        for i, s in enumerate(segs) if i >= start]
                for _fut in as_completed(futs):
                    if fail_reason:
                        for f in futs:
                            f.cancel()
                        committer.abort()
                        break
        finally:
            # 兜底中止：任何异常退出路径都唤醒仍在等待写盘的 worker，
            # 避免它们永久阻塞在 acquire_turn 上。
            committer.abort()
            thread_sessions.close_all()  # 分片会话统一回收，防 socket 泄漏
            # 无论成功/失败，先把写盘后未落盘的进度补记（失败时保住可续传点；
            # 成功时下面随即删除 meta）。abort 已置位，快照即最终连续前缀。
            committer.flush()
        if fail_reason:
            raise _HlsError(f"分片下载失败: {fail_reason[0]}")
        if committer.done < len(segs):
            raise _HlsError(
                f"分片未全部提交（{committer.done}/{len(segs)}），不视为成功")
        try:
            os.remove(meta)
        except OSError:
            pass
        return dest
    except _HlsError as exc:
        print(f"[HLS] {exc.reason}")
        if committer is not None:
            committer.flush()  # 失败返回前强制落盘可续传进度
        return None
    except Exception as exc:
        print(f"[HLS] {exc}")
        if committer is not None:
            committer.flush()
        return None