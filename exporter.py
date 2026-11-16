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
#   2. The video timeline is driven by the PLAYED AUDIO TIME, not by the wall
#      clock.  The exporter keeps its own played clock per track: it only
#      advances while playback is running, is frozen on pause and continues at
#      the same position on resume.  Frames are duplicated when the app renders
#      slower than 60 FPS, so video and audio always stay in sync.
#   3. When recording stops, the ORIGINAL audio files of all played tracks are
#      concatenated, chapters (one per song) are written, and everything is
#      muxed into a single mp4. Temp files are deleted afterwards.
#
# The frame sink and the mux step can be replaced via the constructor
# (`frame_sink_factory` / `frame_sink`, `muxer`), which lets the timeline be
# tested without a sound card, FFmpeg or any real encoding.
# -----------------------------------------------------------------------------
import inspect
import math
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


# Actions that would corrupt a running export. main.py shows these as a visible
# notice instead of silently ignoring the key press.
BLOCKED_ACTIONS = {
    "skip": "Überspringen während des Exports nicht möglich.",
    "prev": "Zurückspringen während des Exports nicht möglich.",
    "load": "Laden während des Exports nicht möglich (E = Export stoppen).",
    "fullscreen": "Vollbild-Wechsel während des Exports nicht möglich.",
}


def block_message(action):
    """Visible notice for an action that is disabled while exporting."""
    return BLOCKED_ACTIONS.get(action, "Während des Exports nicht möglich.")


class FFmpegFrameSink:
    """Default frame sink: pipes raw RGB24 frames into an ffmpeg process.

    The process is started here (not in ExportManager) so tests can inject a
    pure-Python sink with the same tiny interface: write(), close(), wait().
    """

    def __init__(self, ffmpeg, width, height, fps, temp_video, log_path,
                 popen_flags=None):
        self.log_path = log_path
        self._log = open(log_path, "w", encoding="utf-8", errors="replace")
        cmd = [
            ffmpeg, "-y", "-loglevel", "warning",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{width}x{height}", "-r", str(fps),
            "-i", "-", "-an",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",   # yuv420p needs even size
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            temp_video,
        ]
        try:
            # stderr goes to a log FILE. A PIPE that nobody reads would fill up
            # and freeze ffmpeg (and with it the whole app).
            self._proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                stderr=self._log, **(popen_flags or {}))
        except Exception:
            self._close_log()
            raise
        self.failed = False

    def write(self, data):
        self._proc.stdin.write(data)

    def close(self):
        """Close the frame stream; the process itself is reaped in wait()."""
        try:
            if self._proc.stdin:
                self._proc.stdin.close()
        except Exception:
            pass

    def wait(self):
        try:
            return self._proc.wait()
        finally:
            self._close_log()

    @property
    def returncode(self):
        return self._proc.returncode

    def _close_log(self):
        if self._log is not None:
            try:
                self._log.close()
            except Exception:
                pass
            self._log = None


class ExportManager:
    def __init__(self, out_dir="exports", fps=60, ffmpeg_path=None,
                 frame_sink_factory=None, frame_sink=None, muxer=None):
        self.out_dir = out_dir
        self.fps = fps
        self._ffmpeg_override = ffmpeg_path
        # Optional injection points (used by tests; None = real FFmpeg).
        self._frame_sink_factory = frame_sink_factory
        self._injected_sink = frame_sink
        self._muxer = muxer

        self.is_recording = False
        self.is_finalizing = False
        self.status = ""          # last message, shown in the UI
        self.last_output = None
        self.size = (0, 0)
        self.frames = 0

        self._lock = threading.RLock()
        self._sink = None
        self._queue = None
        self._writer = None
        self._failed = False
        self._finalizer = None

        self._tracks = []         # audio file paths in play order
        self._chapters = []       # {'start': sec, 'frame': n, 'start_ms': ms, ...}
        self._cur = None          # {'path', 'duration', 'token', 'title'}
        self._track_start = 0.0   # played-audio timeline position of the track
        self._track_played = 0.0  # audio seconds of the current track played
        self._last_pos = 0.0      # position anchor (seconds inside the track)
        self._has_played = False  # current track has produced played audio
        self._paused = False      # playback was paused at the last tick

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

        try:
            self._sink = self._create_sink(width, height)
        except Exception as e:
            self.status = f"FFmpeg konnte nicht gestartet werden: {e}"
            return False

        self.size = (width, height)
        self.frames = 0
        self._failed = False
        self._tracks, self._chapters = [], []
        self._cur = None
        self._track_start = self._track_played = 0.0
        self._last_pos = 0.0
        self._has_played = self._paused = False
        self._last_frame = None
        self._queue = queue.Queue(maxsize=180)
        self._writer = threading.Thread(target=self._writer_task, daemon=True)
        self._writer.start()
        self.is_recording = True
        self.status = "Export gestartet"
        return True

    def _create_sink(self, width, height):
        if self._injected_sink is not None:
            return self._injected_sink
        if self._frame_sink_factory is not None:
            return self._frame_sink_factory(width, height, self.fps)
        return FFmpegFrameSink(self.ffmpeg, width, height, self.fps,
                               self.temp_video, self.log_path,
                               self._popen_flags())

    @staticmethod
    def _popen_flags():
        if os.name == "nt":
            return {"creationflags": subprocess.CREATE_NO_WINDOW}
        return {}

    # ------------------------------------------------------------- timeline
    def _timeline_seconds(self):
        """Played audio time represented by the video so far."""
        return self._track_start + self._track_played

    def _frames_for(self, seconds):
        return int(round(max(0.0, seconds) * self.fps))

    def timeline_seconds(self):
        """Played audio time at the end of the video (pauses do not count)."""
        with self._lock:
            return self._timeline_seconds()

    def video_duration(self):
        """Length of the video in seconds (frames actually written)."""
        with self._lock:
            return self.frames / float(self.fps)

    def chapter_starts(self):
        """Chapter start times in seconds (read-only snapshot, for tests/UI)."""
        with self._lock:
            return [ch["start"] for ch in self._chapters]

    def chapter_bounds_ms(self):
        """[(start_ms, end_ms, title)] exactly as written to the metadata file.

        Starts are derived from the frame written when the track began, so they
        are monotonic and never point past the video. The last chapter ends at
        the real video length (important for an early E stop).
        """
        with self._lock:
            if not self._chapters:
                return []
            total_end_ms = int(math.ceil(self.frames * 1000.0 / self.fps - 1e-9))
            bounds = []
            for i, ch in enumerate(self._chapters):
                start = int(ch.get("start_ms", round(ch["start"] * 1000)))
                if i + 1 < len(self._chapters):
                    nxt = self._chapters[i + 1]
                    end = int(nxt.get("start_ms", round(nxt["start"] * 1000)))
                else:
                    end = total_end_ms
                bounds.append((start, max(end, start + 1), ch["title"]))
            return bounds

    # ----------------------------------------------------------------- tracks
    def begin_track(self, path, duration, title=None, token=None):
        """Call whenever a track starts playing from 0:00 while recording.

        `token` identifies the playback start (FileProcessor.track_serial).
        Repeating the same token (or, without a token, asking for the same
        track again before any audio was played) is ignored, so a pause/resume
        can never add a duplicate chapter.
        """
        with self._lock:
            if not self.is_recording:
                return False

            duration = max(float(duration or 0.0), 0.1)
            cur = self._cur
            if cur is not None:
                if token is not None and cur.get("token") == token:
                    return False        # same start event -> no new chapter
                if (token is None and path == cur["path"]
                        and not self._has_played and self._track_played <= 1e-9):
                    return False        # replay without any played audio
                # The audio file of the finished track is concatenated in full,
                # so the video has to cover its whole duration as well.
                self._complete_current()

            start_frame = max(0, self._frames_for(self._timeline_seconds()))
            if self._chapters:
                prev_frame = self._chapters[-1]["frame"]
                if start_frame <= prev_frame:
                    # Chapter starts must be strictly increasing. Make sure the
                    # video contains the frame this chapter starts at.
                    start_frame = prev_frame + 1
                    self._fill_frames(start_frame)
            self._track_start = start_frame / float(self.fps)
            self._track_played = 0.0
            self._last_pos = 0.0
            self._has_played = False
            self._paused = False
            self._cur = {"path": path, "duration": duration, "token": token,
                         "title": title or os.path.basename(path)}
            self._tracks.append(path)
            self._chapters.append({
                "start": self._track_start,
                "frame": start_frame,
                "start_ms": int(round(start_frame * 1000.0 / self.fps)),
                "title": self._cur["title"],
            })
            return True

    def _complete_current(self):
        """Treat the current track as fully played (natural end / next track)."""
        if self._cur is None:
            return
        self._track_played = self._cur["duration"]
        self._fill_frames(self._frames_for(self._timeline_seconds()))

    def _fill_frames(self, target_frames):
        missing = target_frames - self.frames
        if missing > 0 and self._last_frame is not None:
            self.write(self._last_frame, missing)

    # ----------------------------------------------------------------- frames
    def advance(self, track_pos, playing=True):
        """Feed the player state into the export timeline.

        `track_pos` is the position inside the current audio file (seconds) and
        `playing` tells whether audio is actually being played.  While paused
        (or while a new track is loading) the timeline does not move, no matter
        how often this is called or how the wall clock advances.  On resume the
        frozen position is used as the new anchor, so playback continues at the
        same place instead of jumping ahead by the paused time.
        """
        with self._lock:
            if not self.is_recording or self._cur is None or self._failed:
                return
            if track_pos is None:
                # No usable clock (track loading / stopped): nothing was played.
                self._paused = True
                return
            try:
                pos = float(track_pos)
            except (TypeError, ValueError):
                self._paused = True
                return
            pos = min(max(pos, 0.0), self._cur["duration"])

            if not playing:
                if not self._paused:
                    # Entering pause: audio played up to this instant counts.
                    self._add_delta(pos)
                    self._has_played = True
                    self._paused = True
                # While paused the clock is frozen: re-anchor but never count,
                # even if the underlying backend keeps reporting a moving
                # position. Whatever is still due is written once, so video
                # and played audio match exactly at the pause point.
                self._last_pos = pos
                self._fill_frames(self._frames_for(self._timeline_seconds()))
                return

            if self._paused:
                # Resume: continue from the frozen position. Nothing is counted
                # here -- the audio played up to the pause point was counted
                # when the pause began, and re-anchoring makes the timeline
                # immune to a backend clock that kept moving while paused.
                self._paused = False
                self._last_pos = pos
                self._has_played = True
                return

            self._add_delta(pos)
            self._last_pos = pos
            self._has_played = True

    def _add_delta(self, pos):
        """Count audio seconds played since the last position anchor."""
        delta = pos - self._last_pos
        if delta > 0.0 and self._cur is not None:
            # A backwards jump (restart/seek) is a rebase, not negative time;
            # the already written video timeline is never rewound.
            self._track_played = min(self._cur["duration"],
                                     self._track_played + delta)

    def frames_due(self, track_pos=None, playing=None):
        """How many video frames must be written so the video catches up with
        the played audio. 0 -> no need to even grab a frame.

        For backwards compatibility a track position may be passed here; it is
        then fed through advance() first (playing unless stated otherwise).
        """
        if track_pos is not None:
            self.advance(track_pos, True if playing is None else playing)
        with self._lock:
            if not self.is_recording or self._cur is None or self._failed:
                return 0
            return max(0, self._frames_for(self._timeline_seconds())
                       - self.frames)

    def on_player_tick(self, playback_state, track_pos):
        """Bridge called once per rendered frame (main.grab_export_frame).

        `playback_state` is FileProcessor.playback_state and `track_pos` its
        get_position(). Returns the number of frames to render/write now.
        Paused/stopped input freezes the timeline but never ends the export.
        """
        playing = playback_state == "playing"
        known = playing or playback_state == "paused"
        self.advance(track_pos if known else None, playing=playing)
        return self.frames_due()

    def write(self, rgb_bytes, count):
        """rgb_bytes: raw RGB frame (w*h*3). It is written `count` times."""
        if count <= 0:
            return
        with self._lock:
            if not self.is_recording:
                return
            self.frames += count
            self._last_frame = rgb_bytes
            q, sink = self._queue, None
            if q is None:
                sink = self._sink
        # Enqueue outside the lock: a full queue may block until the writer
        # thread has drained a frame, and that must not block begin_track/stop.
        if q is not None:
            q.put((rgb_bytes, count))
        elif sink is not None:
            try:
                for _ in range(count):
                    sink.write(rgb_bytes)
            except Exception:
                self._failed = True

    def _writer_task(self):
        sink = self._sink
        while True:
            item = self._queue.get()
            if item is None:
                break
            if self._failed:
                continue                      # keep draining, never block the app
            data, count = item
            try:
                for _ in range(count):
                    sink.write(data)
            except Exception:
                self._failed = True

    # ------------------------------------------------------------------- stop
    def stop(self, natural_end=False):
        """natural_end=True: the last song ran out -> top the video up to the
        exact end of the audio. Otherwise the video is topped up to the played
        position, so early stops end exactly with the played audio."""
        if not self.is_recording:
            return
        with self._lock:
            target = self._frames_for(self._timeline_seconds())
            if natural_end and self._cur is not None:
                self._complete_current()
                target = self._frames_for(self._timeline_seconds())
            # Never end the video before the last chapter started: the chapter
            # boundary then always lies inside the video (a chapter whose start
            # is the very end of the file would be empty). Also write frames
            # that were still due (slow rendering), so video length == played
            # audio.
            if self._chapters:
                target = max(target, self._chapters[-1]["frame"] + 1)
            self._fill_frames(target)
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
            if self._queue is not None:
                self._queue.put(None)
            if self._writer is not None:
                self._writer.join()
            rc = 0
            if self._sink is not None:
                try:
                    self._sink.close()
                except Exception:
                    pass
                wait = getattr(self._sink, "wait", None)
                if callable(wait):
                    rc = wait() or 0

            if self._failed or rc != 0:
                self.status = f"Export fehlgeschlagen (siehe {self.log_path})"
                return
            if self.frames == 0 or not self._tracks:
                self.status = "Export abgebrochen: nichts aufgenommen"
                self._cleanup(keep_log=False)
                return

            self._write_meta()
            ok, err = self._mux()
            if ok:
                self.last_output = self.final_path
                self.status = f"Export fertig: {self.final_path}"
                self._cleanup(keep_log=False)
            else:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write("\n--- mux ---\n" + err)
                self.status = f"Merge fehlgeschlagen (Video bleibt: {self.temp_video})"
        except Exception as e:
            self.status = f"Export-Fehler: {e}"
        finally:
            self.is_finalizing = False

    def _write_meta(self):
        # chapter bounds come from the frames really written; the last chapter
        # therefore ends exactly at the video length, also on an early stop.
        lines = [";FFMETADATA1", "title=Awesome Audio Visualizer Export"]
        for start, end, title in self.chapter_bounds_ms():
            lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
                      f"title={_meta_escape(title)}"]
        with open(self.meta_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _mux(self):
        if self._muxer is not None:
            # A test muxer may take either the manager or nothing at all.
            try:
                params = inspect.signature(self._muxer).parameters
                takes_arg = len(params) > 0
            except (TypeError, ValueError):
                takes_arg = False
            return self._muxer(self) if takes_arg else self._muxer()

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

        cmd += ["-map_metadata", str(meta_idx), "-map_chapters", str(meta_idx),
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest", "-movflags", "+faststart", self.final_path]
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
