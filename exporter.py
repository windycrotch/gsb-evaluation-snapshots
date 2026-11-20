# -----------------------------------------------------------------------------
#  Awesome-Audio-Visualizer 1.1.0 by Volkan Sah
#  Copyright (c) 2024-2025 Volkan Sah
#  License:      AGPL-3.0-or-later (siehe LICENSE)
#  https://github.com/VolkanSah/Awesome-Audio-Visualizer
# -----------------------------------------------------------------------------
# Export: records the visualizer to ONE mp4 (video + original audio + chapters)
# File: exporter.py
#
# Lifecycle (one export run = one _Session object):
#
#   IDLE --start()--> RECORDING --stop()--> FINALIZING --finalizer--> IDLE
#                        ^                     |
#                        |                     +-- merge failed: keep temp video
#                        |                         + log (+ metadata) for analysis
#                        +-- start() only allowed again in IDLE
#
# How it works:
#   1. Frames are piped to ffmpeg while the music plays (video only, temp file).
#   2. The video timeline is driven by the AUDIO position, not by the wall clock.
#      -> frames are duplicated if the app renders slower than 60 FPS, so video
#         and audio always stay in sync (also when you pause).
#   3. A chapter is registered exactly once per track, and only when that track
#      starts at 0:00. Pausing/resuming or restarting the same track from inside
#      the export never registers a second chapter.
#   4. When recording stops, the ORIGINAL audio files of all recorded tracks are
#      concatenated, chapters (one per song) are written, and everything is
#      muxed into a single mp4. Temp files are deleted afterwards - unless a
#      step failed, in which case the diagnostic files are kept.
# -----------------------------------------------------------------------------
import os
import queue
import shutil
import subprocess
import threading
from datetime import datetime

STATE_IDLE = "idle"
STATE_RECORDING = "recording"
STATE_FINALIZING = "finalizing"

# A chapter is only registered for a track that starts at (nearly) 0:00.
# Generous enough for a lagging UI loop, strict enough to reject a resume.
_START_TOLERANCE_SEC = 1.0


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


class _Session:
    """Every piece of mutable state belonging to exactly one export run.

    The finalizer thread only ever touches its own session, so a later export
    can never overwrite files that a still-running finalizer is working on.
    """

    def __init__(self, ffmpeg, out_dir, stamp):
        self.ffmpeg = ffmpeg
        self.stamp = stamp
        self.temp_video = os.path.join(out_dir, f"tmp_video_{stamp}.mp4")
        self.meta_path = os.path.join(out_dir, f"tmp_meta_{stamp}.txt")
        self.final_path = os.path.join(out_dir, f"visualizer_{stamp}.mp4")
        self.log_path = os.path.join(out_dir, f"ffmpeg_{stamp}.log")

        self.proc = None
        self.log = None
        self.queue = None
        self.writer = None
        self.failed = False
        self.frames = 0
        self.last_frame = None
        self.accepting = True    # no frames may be enqueued after the stop sentinel
        self.enqueue_lock = threading.Lock()

        self.tracks = []        # {'path', 'duration', 'title', 'index', 'start'}
        self.chapters = []      # {'start', 'title'}  (1:1 with tracks)
        self.registered = set()  # identities already turned into a chapter
        self.cur = None         # {'duration', 'key'} of the active track
        self.offset = 0.0       # audio timeline position where cur started
        self.done = threading.Event()   # set once the finalizer is finished


class ExportManager:
    def __init__(self, out_dir="exports", fps=60, ffmpeg_path=None,
                 popen_factory=None, run_factory=None):
        self.out_dir = out_dir
        self.fps = fps
        self._ffmpeg_override = ffmpeg_path
        # Test seams: both default to the real module functions.
        self._popen_factory = popen_factory or subprocess.Popen
        self._run_factory = run_factory or subprocess.run

        self.status = ""          # last message, shown in the UI
        self.last_output = None
        self.failure_reason = ""
        self.size = (0, 0)
        self.ffmpeg = ffmpeg_path or "ffmpeg"

        self._state = STATE_IDLE
        self._state_lock = threading.RLock()
        self._session = None
        self._finalizer = None
        # Timestamps already used by this manager - two exports started within
        # the same second must never share (and overwrite) a final file.
        self._used_stamps = set()

    # ------------------------------------------------------------------ state
    @property
    def is_recording(self):
        return self._state == STATE_RECORDING

    @property
    def is_finalizing(self):
        return self._state == STATE_FINALIZING

    @property
    def state(self):
        return self._state

    @property
    def frames(self):
        s = self._session
        return s.frames if s is not None else 0

    @property
    def chapters(self):
        """Snapshot of registered chapters ({'start': sec, 'title': str})."""
        s = self._session
        return [dict(ch) for ch in s.chapters] if s is not None else []

    @property
    def tracks(self):
        """Snapshot of registered audio paths, in play order."""
        s = self._session
        return [tr["path"] for tr in s.tracks] if s is not None else []

    # Temporary paths of the current/last run (useful for messages and tests).
    @property
    def temp_video(self):
        return self._session.temp_video if self._session else None

    @property
    def meta_path(self):
        return self._session.meta_path if self._session else None

    @property
    def final_path(self):
        return self._session.final_path if self._session else None

    @property
    def log_path(self):
        return self._session.log_path if self._session else None

    @property
    def last_session(self):
        """The session of the most recent run (path info for the UI/tests)."""
        return self._session

    # ------------------------------------------------------------------ start
    def start(self, width, height):
        """Start a new export. Returns False (and sets status) when another
        export is still recording or finalizing; in that case no path of the
        running export is touched."""
        with self._state_lock:
            if self._state == STATE_RECORDING:
                self.status = "Export läuft bereits."
                return False
            if self._state == STATE_FINALIZING:
                self.status = "Export wird noch fertiggestellt – bitte warten."
                return False

            ffmpeg = self._ffmpeg_override or find_ffmpeg()
            os.makedirs(self.out_dir, exist_ok=True)
            stamp = self._unique_stamp(ffmpeg)
            session = _Session(ffmpeg, self.out_dir, stamp)

            cmd = [
                ffmpeg, "-y", "-loglevel", "warning",
                "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{width}x{height}", "-r", str(self.fps),
                "-i", "-", "-an",
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",   # yuv420p needs even size
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-pix_fmt", "yuv420p",
                session.temp_video,
            ]
            try:
                # stderr goes to a log FILE. A PIPE that nobody reads would fill
                # up and freeze ffmpeg (and with it the whole app).
                session.log = open(session.log_path, "w", encoding="utf-8",
                                   errors="replace")
                session.proc = self._popen_factory(
                    cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                    stderr=session.log, **self._popen_flags())
            except Exception as e:
                self._discard_failed_start(session)
                self.status = f"FFmpeg konnte nicht gestartet werden: {e}"
                self.failure_reason = str(e)
                return False

            session.queue = queue.Queue(maxsize=180)
            session.writer = threading.Thread(
                target=self._writer_task, args=(session,), daemon=True)
            session.writer.start()

            self._session = session
            self.ffmpeg = ffmpeg
            self.size = (width, height)
            self.failure_reason = ""
            self.last_output = None
            self._state = STATE_RECORDING
            self.status = "Export gestartet"
            return True

    def _unique_stamp(self, ffmpeg):
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        candidate, n = stamp, 1
        while candidate in self._used_stamps:
            n += 1
            candidate = f"{stamp}_{n}"
        while True:
            probe = _Session(ffmpeg, self.out_dir, candidate)
            if not any(os.path.exists(p) for p in
                       (probe.temp_video, probe.meta_path, probe.final_path,
                        probe.log_path)):
                self._used_stamps.add(candidate)
                return candidate
            n += 1
            candidate = f"{stamp}_{n}"

    def _discard_failed_start(self, session):
        if session.log is not None:
            try:
                session.log.close()
            except Exception:
                pass
            session.log = None
        for path in (session.log_path, session.temp_video):
            try:
                if os.path.exists(path) and os.path.getsize(path) == 0:
                    os.remove(path)
            except OSError:
                pass

    @staticmethod
    def _popen_flags():
        if os.name == "nt":
            return {"creationflags": subprocess.CREATE_NO_WINDOW}
        return {}

    # ----------------------------------------------------------------- tracks
    def begin_track(self, path, duration, title=None, index=None,
                    started_at=0.0):
        """Register a chapter for a track that starts playing at 0:00.

        Must be called once per track start. Pause/resume, or restarting the
        very same playlist entry again, is ignored so a chapter is registered
        exactly once and in play order. Returns True when a chapter was added.
        """
        if started_at is not None and started_at > _START_TOLERANCE_SEC:
            return False
        if not path:
            return False
        key = (index, os.path.abspath(path)) if index is not None \
            else os.path.abspath(path)
        with self._state_lock:
            s = self._session
            if self._state != STATE_RECORDING or s is None:
                return False
            if key in s.registered:
                return False
            if s.cur is not None:
                if s.frames == s.cur["start_frame"]:
                    # The previous track was never visible in the video (no
                    # frame was written before the switch). Drop it instead of
                    # creating a chapter + audio that do not exist on screen.
                    if s.tracks:
                        s.tracks.pop()
                    if s.chapters:
                        s.chapters.pop()
                else:
                    # Fill the last frames of the track that is ending now, so
                    # the next chapter starts exactly where the previous audio
                    # ends - even when the renderer lagged behind or the mixer
                    # went quiet while the next file was being loaded.
                    self._top_up(s)
                    s.offset += s.cur["duration"]
            dur = max(float(duration or 0.0), 0.1)
            s.cur = {"duration": dur, "key": key,
                     "start": s.offset, "start_frame": s.frames}
            s.registered.add(key)
            label = title or os.path.basename(path)
            s.tracks.append({"path": path, "duration": dur, "title": label,
                             "index": index, "start": s.offset})
            s.chapters.append({"start": s.offset, "title": label})
            return True

    # ----------------------------------------------------------------- frames
    def _top_up(self, s):
        """Pad the active track with its last frame up to its audio end.

        Keeps the video timeline aligned with the audio that will be muxed in,
        even if the renderer lagged behind or the mixer stopped reporting a
        position. Called from the UI thread only, while `_state_lock` is held.
        """
        if s.cur is None or s.last_frame is None:
            return
        with s.enqueue_lock:
            if not s.accepting:
                return
            missing = int((s.offset + s.cur["duration"]) * self.fps) - s.frames
            if missing <= 0:
                return
            s.frames += missing
            s.queue.put((s.last_frame, missing))

    def frames_due(self, track_pos):
        """How many video frames must be written so the video catches up with
        the audio position. 0 -> no need to even grab a frame."""
        s = self._session
        if (self._state != STATE_RECORDING or s is None or s.cur is None
                or track_pos is None or s.failed):
            return 0
        t = s.offset + min(max(float(track_pos), 0.0), s.cur["duration"])
        return max(0, int(t * self.fps) - s.frames)

    def write(self, rgb_bytes, count):
        """rgb_bytes: raw RGB frame (w*h*3). It is written `count` times."""
        if count <= 0:
            return
        s = self._session
        if self._state != STATE_RECORDING or s is None:
            return
        with s.enqueue_lock:
            if not s.accepting:
                return
            s.frames += count
            s.last_frame = rgb_bytes
            s.queue.put((rgb_bytes, count))

    def _writer_task(self, session):
        stdin = session.proc.stdin
        while True:
            item = session.queue.get()
            if item is None:
                break
            if session.failed:
                continue                      # keep draining, never block the app
            data, count = item
            try:
                for _ in range(count):
                    stdin.write(data)
            except (BrokenPipeError, OSError):
                session.failed = True
        try:
            stdin.close()
        except Exception:
            pass

    # ------------------------------------------------------------------- stop
    def stop(self, natural_end=False, reason=None):
        """Stop recording and run the finalizer.

        natural_end=True: the last song ran out -> top the video up to the
        exact end of the audio. Otherwise the video ends at the last frame that
        was actually recorded (early stop). `reason` replaces the default
        "finalizing" status (e.g. for a window resize). Returns False when
        there is no active recording.
        """
        with self._state_lock:
            s = self._session
            if self._state != STATE_RECORDING or s is None:
                return False
            if natural_end:
                # let the last song end exactly with its audio
                self._top_up(s)
            self._state = STATE_FINALIZING
            self.status = reason or "Export wird fertiggestellt ..."
            # Freeze the queue before the finalizer sends its sentinel, so no
            # producer can enqueue after it.
            with s.enqueue_lock:
                s.accepting = False
            self._finalizer = threading.Thread(
                target=self._finalize_task, args=(s,), daemon=True)
            # Started while holding the lock: any thread that observes the
            # FINALIZING state also sees a live finalizer.
            self._finalizer.start()
        return True

    def stop_for_resize(self, width, height):
        """Stop a running export when the window size changed underneath the
        encoder (the raw frame stream would no longer match). Goes through the
        exact same finalize path as E/R."""
        if not self.is_recording:
            return False
        if (width, height) == self.size:
            return False
        self.stop(reason="Fenstergröße geändert - Export gestoppt")
        return True

    def wait(self):
        """Block until a running finalizer is completely done (app exit)."""
        session = self._session
        if session is not None and self._state == STATE_FINALIZING:
            session.done.wait()
        finalizer = self._finalizer
        if finalizer is not None and finalizer.is_alive():
            finalizer.join()

    # -------------------------------------------------------------- finalizer
    def _finalize_task(self, s):
        try:
            with s.enqueue_lock:
                s.accepting = False
                s.queue.put(None)
            if s.writer is not None:
                s.writer.join()
            try:
                returncode = s.proc.wait()
            except Exception:
                returncode = -1
            self._close_log(s)

            if s.failed or returncode != 0:
                reason = self._log_tail(s.log_path) or \
                    f"Aufnahme abgebrochen (FFmpeg Rückgabecode {returncode})"
                self.failure_reason = reason
                self.status = (f"Export fehlgeschlagen: {reason} "
                               f"(Video: {s.temp_video}, Log: {s.log_path})")
                # Keep the temp video + log for diagnosis, drop metadata that
                # was never used (it is only relevant after a successful record).
                self._cleanup(s, keep_video=True, keep_meta=False, keep_log=True)
                return

            if s.frames == 0 or not s.tracks:
                self.failure_reason = ""
                self.status = "Export abgebrochen: nichts aufgenommen"
                self._cleanup(s)
                return

            chapters, tracks, total_end = self._recorded_view(s)
            if not chapters:
                self.failure_reason = ""
                self.status = "Export abgebrochen: nichts aufgenommen"
                self._cleanup(s)
                return

            self._write_meta(s, chapters, total_end)
            ok, err = self._mux(s, tracks)
            if ok:
                self.last_output = s.final_path
                self.failure_reason = ""
                self.status = f"Export fertig: {s.final_path}"
                self._cleanup(s)
            else:
                reason = self._summarize_error(err)
                self.failure_reason = reason
                self._append_log(s.log_path, "\n--- mux ---\n" + (err or ""))
                # A partially written output would only confuse the user.
                self._remove(s.final_path)
                self.status = (f"Merge fehlgeschlagen: {reason} "
                               f"(Video bleibt: {s.temp_video}, "
                               f"Log: {s.log_path})")
                # Keep every input that is needed to reproduce the failure.
                self._cleanup(s, keep_video=True, keep_meta=True, keep_log=True)
        except Exception as e:
            self.failure_reason = str(e)
            self.status = f"Export-Fehler: {e}"
            try:
                self._close_log(s)
                self._append_log(s.log_path, f"\n--- finalizer error ---\n{e}\n")
                self._cleanup(s, keep_video=True, keep_meta=True, keep_log=True)
            except Exception:
                pass
        finally:
            with self._state_lock:
                if self._session is s:
                    self._state = STATE_IDLE
            s.done.set()

    def _recorded_view(self, s):
        """Chapters/tracks that are actually inside the recorded video.

        A track that was registered only at the very end of the video (no frame
        of it was written before the user stopped) must not become a chapter
        and must not contribute audio - otherwise chapters and audio would be
        longer than the video.
        """
        total_end = s.frames / float(self.fps)
        chapters, tracks = [], []
        for chapter, track in zip(s.chapters, s.tracks):
            if chapter["start"] < total_end - 1e-9:
                chapters.append(chapter)
                tracks.append(track)
        return chapters, tracks, total_end

    def _write_meta(self, s, chapters, total_end):
        lines = [";FFMETADATA1", "title=Awesome Audio Visualizer Export"]
        for i, ch in enumerate(chapters):
            start = int(ch["start"] * 1000)
            nxt = chapters[i + 1]["start"] if i + 1 < len(chapters) else total_end
            end = int(nxt * 1000)
            end = max(end, start + 1)
            lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}",
                      f"END={end}", f"title={_meta_escape(ch['title'])}"]
        with open(s.meta_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _mux(self, s, tracks):
        n = len(tracks)
        cmd = [s.ffmpeg, "-y", "-loglevel", "warning", "-i", s.temp_video]
        for track in tracks:
            cmd += ["-i", track["path"]]
        cmd += ["-i", s.meta_path]
        meta_idx = 1 + n

        if n == 1:
            cmd += ["-map", "0:v:0", "-map", "1:a:0"]
        else:
            # normalise every track first, concat needs identical formats
            parts = "".join(
                f"[{i + 1}:a:0]aresample=44100,"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{i}];"
                for i in range(n))
            joined = "".join(f"[a{i}]" for i in range(n))
            cmd += ["-filter_complex",
                    f"{parts}{joined}concat=n={n}:v=0:a=1[aout]",
                    "-map", "0:v:0", "-map", "[aout]"]

        cmd += ["-map_metadata", str(meta_idx), "-map_chapters", str(meta_idx),
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest", "-movflags", "+faststart", s.final_path]
        r = self._run_factory(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              **self._popen_flags())
        return r.returncode == 0, (r.stderr or "")

    # ----------------------------------------------------------------- helpers
    def _close_log(self, s):
        if s.log is not None:
            try:
                s.log.close()
            except Exception:
                pass
            s.log = None

    @staticmethod
    def _log_tail(path, limit=300):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = [ln.strip() for ln in f if ln.strip()]
        except OSError:
            return ""
        return (lines[-1] if lines else "")[:limit]

    @staticmethod
    def _summarize_error(err, limit=300):
        lines = [ln.strip() for ln in (err or "").splitlines() if ln.strip()]
        return (lines[-1] if lines else "FFmpeg meldete einen Fehler")[:limit]

    @staticmethod
    def _append_log(path, text):
        try:
            with open(path, "a", encoding="utf-8") as f:
                f.write(text)
        except OSError:
            pass

    @staticmethod
    def _remove(path):
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError:
            pass

    def _cleanup(self, s, keep_video=False, keep_meta=False, keep_log=False):
        """Delete everything that is not explicitly requested to be kept."""
        if not keep_video:
            self._remove(s.temp_video)
        if not keep_meta:
            self._remove(s.meta_path)
        if not keep_log:
            self._remove(s.log_path)
