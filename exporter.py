# -----------------------------------------------------------------------------
#  Awesome-Audio-Visualizer 1.1.0 by Volkan Sah
#  Copyright (c) 2024-2025 Volkan Sah
#  License:      AGPL-3.0-or-later (siehe LICENSE)
#  https://github.com/VolkanSah/Awesome-Audio-Visualizer
# -----------------------------------------------------------------------------
# Export: records the visualizer to ONE mp4 (video + original audio + chapters)
# File: exporter.py
#
# How it works:
#   1. Frames are piped to ffmpeg while the music plays (video only, temp file).
#   2. The video timeline is driven by the AUDIO position, not by the wall clock.
#      -> frames are duplicated if the app renders slower than 60 FPS, so video
#         and audio always stay in sync (also when you pause).
#   3. When recording stops, the ORIGINAL audio files of all played tracks are
#      concatenated, chapters (one per song) are written, and everything is
#      muxed into a single mp4. Temp files are deleted afterwards.
# -----------------------------------------------------------------------------
import os
import queue
import shutil
import subprocess
import threading
from datetime import datetime


def find_ffmpeg():
    """FFmpeg from system_report.json (detector.py) -> PATH -> plain 'ffmpeg'."""
    try:
        from decoder import get_ffmpeg_path
        return get_ffmpeg_path()
    except Exception:
        pass
    return shutil.which("ffmpeg") or "ffmpeg"


def _meta_escape(text):
    text = str(text).replace("\r", " ").replace("\n", " ")
    for ch in ("\\", "=", ";", "#"):
        text = text.replace(ch, "\\" + ch)
    return text


class ExportManager:
    def __init__(self, out_dir="exports", fps=60, ffmpeg_path=None):
        self.out_dir = out_dir
        self.fps = fps
        self._ffmpeg_override = ffmpeg_path

        self.is_recording = False
        self.is_finalizing = False
        self.status = ""          # last message, shown in the UI
        self.result = None        # None while busy, else one of RESULT_*
        self.last_output = None
        self.size = (0, 0)
        self.frames = 0

        self._lock = threading.Lock()
        self._proc = None
        self._log = None
        self._queue = None
        self._writer = None
        self._failed = False
        self._finalizer = None

        self._tracks = []         # audio file paths in play order
        self._chapters = []       # {'start': sec, 'title': str}
        self._cur = None          # {'duration': sec}
        self._offset = 0.0
        self._last_token = None   # dedupe: one chapter per 0:00 track start
        self._last_frame = None

    # Final states (self.result). 'record_failed' and 'mux_failed' keep the
    # ffmpeg log for diagnosis; every end state removes the temp files of
    # this run (temp video, metadata, and the log unless kept for diagnosis).
    RESULT_OK = "ok"
    RESULT_CANCELLED = "cancelled"        # stopped before anything was recorded
    RESULT_RECORD_FAILED = "record_failed"  # ffmpeg died while recording
    RESULT_MUX_FAILED = "mux_failed"      # video fine, audio/chapter merge failed
    RESULT_ERROR = "error"                # unexpected exception while finalizing

    # ------------------------------------------------------------------ start
    def start(self, width, height):
        if self.is_recording or self.is_finalizing:
            self.status = "Export läuft bereits."
            return False

        self.ffmpeg = self._ffmpeg_override or find_ffmpeg()
        os.makedirs(self.out_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.temp_video = os.path.join(self.out_dir, f"tmp_video_{stamp}.mp4")
        self.meta_path = os.path.join(self.out_dir, f"tmp_meta_{stamp}.txt")
        self.final_path = os.path.join(self.out_dir, f"visualizer_{stamp}.mp4")
        self.log_path = os.path.join(self.out_dir, f"ffmpeg_{stamp}.log")

        cmd = [
            self.ffmpeg, "-y", "-loglevel", "warning",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-r", str(self.fps),
            "-i", "-", "-an",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",   # yuv420p needs even size
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            self.temp_video,
        ]
        try:
            # stderr goes to a log FILE. A PIPE that nobody reads would fill up
            # and freeze ffmpeg (and with it the whole app).
            self._log = open(self.log_path, "w", encoding="utf-8", errors="replace")
            self._proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=self._log, **self._popen_flags())
        except Exception as e:
            self.status = f"FFmpeg konnte nicht gestartet werden: {e}"
            if self._log:
                self._log.close()
                self._log = None
            return False

        self.size = (width, height)
        self.frames = 0
        self._failed = False
        self.result = None
        self._tracks, self._chapters = [], []
        self._cur, self._offset = None, 0.0
        self._last_token = None
        self._last_frame = None
        self._queue = queue.Queue(maxsize=180)
        self._writer = threading.Thread(target=self._writer_task, daemon=True)
        self._writer.start()
        self.is_recording = True
        self.status = "Export gestartet"
        return True

    @staticmethod
    def _popen_flags():
        if os.name == "nt":
            return {"creationflags": subprocess.CREATE_NO_WINDOW}
        return {}

    # ----------------------------------------------------------------- tracks
    def begin_track(self, path, duration, title, token=None):
        """Call whenever a track starts playing from 0:00 while recording.

        `token` identifies that specific 0:00 start (e.g. the player's track
        serial). The same token is never registered twice, so a track restart
        reported again by the UI cannot create a duplicate chapter or shift
        the chapter timeline."""
        with self._lock:
            if not self.is_recording:
                return
            if token is not None and token == self._last_token:
                return
            if self._cur is not None:
                self._offset += self._cur["duration"]
            self._last_token = token
            self._cur = {"duration": max(float(duration), 0.1)}
            self._tracks.append(path)
            self._chapters.append({"start": self._offset, "title": title or os.path.basename(path)})

    # ----------------------------------------------------------------- frames
    def frames_due(self, track_pos):
        """How many video frames must be written so the video catches up with
        the audio position. 0 -> no need to even grab a frame."""
        if not self.is_recording or self._cur is None or track_pos is None or self._failed:
            return 0
        t = self._offset + min(max(track_pos, 0.0), self._cur["duration"])
        return max(0, int(t * self.fps) - self.frames)

    def write(self, rgb_bytes, count):
        """rgb_bytes: raw RGB frame (w*h*3). It is written `count` times."""
        if count <= 0 or not self.is_recording:
            return
        self.frames += count
        self._last_frame = rgb_bytes
        self._queue.put((rgb_bytes, count))

    def _writer_task(self):
        stdin = self._proc.stdin
        while True:
            item = self._queue.get()
            if item is None:
                break
            if self._failed:
                continue                      # keep draining, never block the app
            data, count = item
            try:
                for _ in range(count):
                    stdin.write(data)
            except (BrokenPipeError, OSError):
                self._failed = True
        try:
            stdin.close()
        except Exception:
            pass

    # ------------------------------------------------------------------- stop
    def stop(self, natural_end=False, track_pos=None):
        """natural_end=True: the last song ran out -> top the video up to the
        exact end of the audio. Otherwise the video is topped up to
        `track_pos` (seconds into the current song, if given) so it always
        covers the moment the user stopped."""
        if not self.is_recording:
            return
        if self._cur is not None and self._last_frame is not None:
            if natural_end:
                target = self._offset + self._cur["duration"]
            elif track_pos is not None:
                target = self._offset + min(max(float(track_pos), 0.0), self._cur["duration"])
            else:
                target = None
            if target is not None:
                missing = int(target * self.fps) - self.frames
                if missing > 0:
                    self.write(self._last_frame, missing)
        self.is_recording = False
        self.is_finalizing = True
        self.status = "Export wird fertiggestellt ..."
        self._finalizer = threading.Thread(target=self._finalize_task)
        self._finalizer.start()

    def wait(self):
        """Block until the export is completely written (call on app exit)."""
        if self._finalizer and self._finalizer.is_alive():
            self._finalizer.join()

    def _finalize_task(self):
        try:
            self._queue.put(None)
            self._writer.join()
            self._proc.wait()
            self._log.close()
            self._log = None

            if self._failed or self._proc.returncode != 0:
                self.result = self.RESULT_RECORD_FAILED
                self.status = f"Export fehlgeschlagen (Log: {self.log_path})"
                self._cleanup(keep_log=True)     # log stays for diagnosis
                return
            if self.frames == 0 or not self._tracks:
                self.result = self.RESULT_CANCELLED
                self.status = "Export abgebrochen: nichts aufgenommen"
                self._cleanup(keep_log=False)
                return

            self._write_meta()
            ok, err = self._mux()
            if ok:
                self.result = self.RESULT_OK
                self.last_output = self.final_path
                self.status = f"Export fertig: {self.final_path}"
                self._cleanup(keep_log=False)
            else:
                self.result = self.RESULT_MUX_FAILED
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write("\n--- mux ---\n" + err)
                self.status = f"Merge fehlgeschlagen (Log: {self.log_path})"
                self._cleanup(keep_log=True)     # log stays for diagnosis
        except Exception as e:
            self.result = self.RESULT_ERROR
            self.status = f"Export-Fehler: {e}"
            try:
                self._cleanup(keep_log=True)
            except Exception:
                pass
        finally:
            self.is_finalizing = False

    def _write_meta(self):
        # Real end of the video. Chapters must never reach past it: a chapter
        # whose track got no frames at all (stopped right at the boundary)
        # is dropped, and every END is clamped to the video length.
        total_ms = max(int(round(self.frames / self.fps * 1000)), 1)
        chapters = []
        for ch in self._chapters:
            start_ms = int(ch["start"] * 1000)
            if start_ms < total_ms:  # keep only chapters inside the video
                chapters.append((start_ms, ch["title"]))
        if not chapters:
            chapters = [(0, self._chapters[0]["title"] if self._chapters else "Export")]
        lines = [";FFMETADATA1", "title=Awesome Audio Visualizer Export"]
        for i, (start_ms, title) in enumerate(chapters):
            end_ms = chapters[i + 1][0] if i + 1 < len(chapters) else total_ms
            end_ms = min(max(end_ms, start_ms + 1), total_ms)
            lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start_ms}", f"END={end_ms}",
                      f"title={_meta_escape(title)}"]
        with open(self.meta_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _mux(self):
        n = len(self._tracks)
        cmd = [self.ffmpeg, "-y", "-loglevel", "warning", "-i", self.temp_video]
        for t in self._tracks:
            cmd += ["-i", t]
        cmd += ["-i", self.meta_path]
        meta_idx = 1 + n

        if n == 1:
            cmd += ["-map", "0:v:0", "-map", "1:a:0"]
        else:
            # normalise every track first, concat needs identical formats
            parts = "".join(
                f"[{i + 1}:a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                for i in range(n))
            joined = "".join(f"[a{i}]" for i in range(n))
            cmd += ["-filter_complex", f"{parts}{joined}concat=n={n}:v=0:a=1[aout]",
                    "-map", "0:v:0", "-map", "[aout]"]

        # -t: cut the concatenated audio at the real video end, so an early
        # stop cannot leave audio (or a "black tail") past the last frame.
        video_end = self.frames / self.fps
        cmd += ["-map_metadata", str(meta_idx), "-map_chapters", str(meta_idx),
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-t", f"{video_end:.3f}", "-shortest", "-movflags", "+faststart",
                self.final_path]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", **self._popen_flags())
        return r.returncode == 0, (r.stderr or "")

    def _cleanup(self, keep_log=False):
        paths = [self.temp_video, self.meta_path]
        if not keep_log:
            paths.append(self.log_path)
        for p in paths:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass
