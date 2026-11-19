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
#   2. The video timeline is driven by the AUDIO position in FRAMES, not by the
#      wall clock and not by the nominal length of a song:
#        target_frame = chapter_start_frame + floor(track_pos * fps)
#      Pausing therefore produces no frames; after resuming, the missing frames
#      are written in one go. Slow rendering is compensated in the same way.
#   3. Every track that really started a playback segment gets a start frame.
#      Chapter starts are derived from those frames, so chapters and video
#      always describe the same timeline. Tracks whose file is missing or not
#      readable are skipped and never reach the audio concatenation.
#   4. When recording stops, the ORIGINAL audio files of the recorded tracks are
#      concatenated, chapters (one per song) are written, and everything is
#      muxed into a single mp4. Temp files are deleted afterwards. If nothing
#      valid was recorded, all temp files are removed and no output is left.
# -----------------------------------------------------------------------------
import math
import os
import queue
import shutil
import subprocess
import sys
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


def _is_readable_file(path):
    """True only for an existing, readable, non-empty file."""
    if not path:
        return False
    try:
        return (os.path.isfile(path) and os.path.getsize(path) > 0
                and os.access(path, os.R_OK))
    except OSError:
        return False


BLOCKED_DURING_EXPORT = frozenset({"load", "source", "switch", "fullscreen"})


class ExportManager:
    def __init__(self, out_dir="exports", fps=60, ffmpeg_path=None):
        self.out_dir = out_dir
        self.fps = max(int(fps), 1)
        self._ffmpeg_override = ffmpeg_path

        self.is_recording = False
        self.is_finalizing = False
        self.status = ""          # last message, shown in the UI
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
        self._last_frame = None

        self._segments = []       # recorded timeline, see begin_track()
        self._skipped = []        # tracks that could not be used
        self._cur = None          # current segment
        self._next_start_time = 0.0

    # ------------------------------------------------------------------ start
    def start(self, width, height):
        if self.is_recording or self.is_finalizing:
            self.status = "Export läuft bereits."
            return False

        self.ffmpeg = self._ffmpeg_override or find_ffmpeg()
        os.makedirs(self.out_dir, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        # The stamp has second resolution: two exports inside the same second
        # must not overwrite each other.
        base, suffix = stamp, 1
        while any(os.path.exists(os.path.join(self.out_dir, name))
                  for name in (f"tmp_video_{stamp}.mp4", f"tmp_meta_{stamp}.txt",
                               f"visualizer_{stamp}.mp4")):
            suffix += 1
            stamp = f"{base}_{suffix}"
        self.temp_video = os.path.join(self.out_dir, f"tmp_video_{stamp}.mp4")
        self.meta_path = os.path.join(self.out_dir, f"tmp_meta_{stamp}.txt")
        self.final_path = os.path.join(self.out_dir, f"visualizer_{stamp}.mp4")
        self.log_path = os.path.join(self.out_dir, f"ffmpeg_{stamp}.log")

        cmd = self._ffmpeg_cmd() + [
            "-y", "-loglevel", "warning",
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
            try:
                if os.path.exists(self.log_path):
                    os.remove(self.log_path)
            except OSError:
                pass
            return False

        self.size = (width, height)
        self.frames = 0
        self._failed = False
        self._last_frame = None
        self.last_output = None
        self._segments, self._skipped = [], []
        self._cur = None
        self._next_start_time = 0.0
        self._queue = queue.Queue(maxsize=180)
        self._writer = threading.Thread(target=self._writer_task, daemon=True)
        self._writer.start()
        self.is_recording = True
        self.status = "Export gestartet"
        return True

    def _ffmpeg_cmd(self):
        """Command prefix. Accepts a full command list (useful for tests and
        wrapper scripts), a plain executable path, or a .py fake ffmpeg."""
        ffmpeg = getattr(self, "ffmpeg", None) or self._ffmpeg_override or find_ffmpeg()
        if isinstance(ffmpeg, (list, tuple)):
            return [str(part) for part in ffmpeg]
        if isinstance(ffmpeg, str) and ffmpeg.lower().endswith(".py"):
            return [sys.executable, ffmpeg]
        return [str(ffmpeg)]

    @staticmethod
    def _popen_flags():
        if os.name == "nt":
            return {"creationflags": subprocess.CREATE_NO_WINDOW}
        return {}

    # ----------------------------------------------------------------- tracks
    def begin_track(self, path, duration, title=None):
        """Call whenever a track starts playing from 0:00 while recording.

        Returns True if the track was accepted. A missing/unreadable file or an
        invalid duration is skipped: the previous chapter is closed, no new
        chapter is created and the track never appears in the final audio.
        """
        with self._lock:
            if not self.is_recording:
                return False

            path = os.fspath(path) if path is not None else None
            if not _is_readable_file(path):
                # Never close the previous chapter here: the bad track simply
                # does not exist on the timeline. The previous chapter is padded
                # when the next valid track starts (or on stop).
                self._skipped.append({"path": path, "title": title,
                                      "reason": "Datei nicht lesbar"})
                self.status = f"Titel übersprungen (nicht lesbar): {title or path or '?'}"
                return False

            try:
                dur = float(duration)
            except (TypeError, ValueError):
                dur = -1.0
            if not math.isfinite(dur) or dur <= 0.0:
                self._skipped.append({"path": path, "title": title,
                                      "reason": "ungültige Dauer"})
                self.status = f"Titel übersprungen (ungültige Dauer): {title or path}"
                return False

            # The previous track is complete when the next one starts at 0:00.
            # If rendering lagged behind, fill the gap with the last frame so
            # the new chapter starts exactly at the audio boundary.
            self._catch_up_current_locked()
            self._close_current_locked()

            # Chapter start = exact position in the CONCATENATED audio, while
            # the frame counter is padded up to a whole frame. Deriving both
            # from the rounded frame count would drift by up to one frame per
            # track, so chapters and audio would slowly separate.
            start_time = self._next_start_time
            seg = {
                "path": path,
                "title": title or os.path.basename(path),
                "duration": dur,
                "start_time": start_time,
                "start_frame": self.frames,
                "end_frame": None,
            }
            self._segments.append(seg)
            self._next_start_time = start_time + dur
            self._cur = seg
            return True

    def note_skipped(self, path, title=None, reason="Analyse fehlgeschlagen"):
        """Record an unplayable track (e.g. analysis failed) for diagnostics."""
        with self._lock:
            self._skipped.append({"path": path, "title": title, "reason": reason})

    def _catch_up_current_locked(self):
        """Stop the video at the current track's audio end if the renderer
        lagged behind.

        The chapter boundary is a fact of the concatenated audio, so the frame
        at which the next chapter starts is ceil(audio_end * fps). Padding UP
        guarantees the video is never shorter than its audio (otherwise
        `-shortest` would cut the audio); the chapter itself starts at the
        exact audio time, so the video simply stays within the same frame.
        """
        cur = self._cur
        if cur is None or self._last_frame is None:
            return
        expected = int(math.ceil((cur["start_time"] + cur["duration"])
                                 * self.fps - 1e-6))
        missing = expected - self.frames
        if missing > 0:
            self.write(self._last_frame, missing)

    def _close_current_locked(self):
        cur = self._cur
        if cur is not None and cur.get("end_frame") is None:
            cur["end_frame"] = max(self.frames, cur["start_frame"])
        self._cur = None

    # ----------------------------------------------------------------- frames
    def frames_due(self, track_pos, playing=True):
        """How many video frames must be written so the video catches up with
        the audio position. 0 -> no need to even grab a frame.

        `playing=False` is used while the player is paused: a paused player
        produces NO frames. When playback resumes, track_pos continues from the
        same audio position and the missing frames are produced here.
        """
        if not self.is_recording or not playing or self._failed:
            return 0
        cur = self._cur
        if cur is None or track_pos is None:
            return 0
        try:
            pos = float(track_pos)
        except (TypeError, ValueError):
            return 0
        if not math.isfinite(pos):
            return 0
        pos = min(max(pos, 0.0), cur["duration"])
        # floor, not round: the frame for a position exists once the playhead
        # reaches it. round() would jump (banker's rounding) and run ahead.
        target = int(math.floor((cur["start_time"] + pos) * self.fps + 1e-6))
        return max(0, target - self.frames)

    def write(self, rgb_bytes, count):
        """rgb_bytes: raw RGB frame (w*h*3). It is written `count` times."""
        if count <= 0 or not self.is_recording or rgb_bytes is None:
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
            except Exception:
                self._failed = True
        try:
            stdin.close()
        except Exception:
            pass

    # ------------------------------------------------------------------- stop
    def stop(self, natural_end=False):
        """natural_end=True: the last song ran out -> top the video up to the
        exact end of the audio (otherwise it stops at the current position)."""
        with self._lock:
            if not self.is_recording:
                return
            if natural_end and self._cur is not None and self._last_frame is not None:
                self._catch_up_current_locked()
            self._close_current_locked()
            self.is_recording = False
            self.is_finalizing = True
            self.status = "Export wird fertiggestellt ..."
            self._finalizer = threading.Thread(target=self._finalize_task)
            self._finalizer.start()

    def wait(self):
        """Block until the export is completely written (call on app exit)."""
        finalizer = self._finalizer
        if finalizer is not None and finalizer.is_alive():
            finalizer.join()

    def _finalize_task(self):
        try:
            self._queue.put(None)
            self._writer.join()
            self._proc.wait()
            if self._log:
                self._log.close()
                self._log = None

            if self._failed or self._proc.returncode != 0:
                # The video stream is incomplete: drop it, keep only the log.
                self.status = f"Export fehlgeschlagen (siehe {self.log_path})"
                self.last_output = None
                self._cleanup(keep_log=True)
                return

            with self._lock:
                self._close_current_locked()
                segments = list(self._segments)

            # Only tracks that actually produced video frames count as
            # recorded. A file that vanished between analysis and mux is kept
            # on the timeline as silence (so audio stays in sync), while a
            # track that was never readable at start never got a segment.
            recorded = [s for s in segments
                        if s["end_frame"] > s["start_frame"]]
            if not recorded or not any(_is_readable_file(s["path"]) for s in recorded):
                self.status = ("Export abgebrochen: nichts aufgenommen "
                               "(keine gültigen Titel).")
                self.last_output = None
                self._cleanup(keep_log=False)
                return

            inputs, missing = [], []
            for seg in recorded:
                if _is_readable_file(seg["path"]):
                    inputs.append({"path": seg["path"], "duration": None})
                else:
                    missing.append(seg["path"])
                    inputs.append({"path": None, "duration": seg["duration"]})
            if missing:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    for path in missing:
                        f.write(f"\nmissing at mux time, using silence: {path}\n")

            # Chapter starts are the boundaries of the audio that is actually
            # concatenated. Recompute them from the kept segments so a segment
            # that was dropped cannot shift every following chapter.
            self._write_meta(self._chapter_times(recorded))
            ok, err = self._mux(inputs)
            if ok:
                self.last_output = self.final_path
                if self._skipped or missing:
                    self.status = (f"Export fertig: {self.final_path} "
                                   f"({len(self._skipped) + len(missing)} Titel übersprungen)")
                else:
                    self.status = f"Export fertig: {self.final_path}"
                self._cleanup(keep_log=bool(self._skipped or missing))
            else:
                # ffmpeg may have left a truncated mp4 behind (-y writes in
                # place). Never keep a half-finished export as the result.
                try:
                    if os.path.exists(self.final_path):
                        os.remove(self.final_path)
                except OSError:
                    pass
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write("\n--- mux ---\n" + err)
                self.status = f"Merge fehlgeschlagen (Video bleibt: {self.temp_video})"
        except Exception as e:
            self.status = f"Export-Fehler: {e}"
        finally:
            self.is_finalizing = False

    @staticmethod
    def _chapter_times(segments):
        """[(start_seconds, end_seconds, title)] for the concatenated audio."""
        chapters, start = [], 0.0
        for seg in segments:
            end = start + seg["duration"]
            chapters.append((start, end, seg["title"]))
            start = end
        return chapters

    def _write_meta(self, chapters):
        # End of the muxed file: -shortest cuts at the audio length, so a video
        # that was padded up to a whole frame must not produce a chapter that
        # points past the real end.
        video_end = self.frames / self.fps
        audio_end = chapters[-1][1]
        total_end = max(min(video_end, audio_end), chapters[-1][0] + 0.001)
        lines = [";FFMETADATA1", "title=Awesome Audio Visualizer Export"]
        for i, (start, _end, title) in enumerate(chapters):
            start_ms = int(round(start * 1000))
            if i + 1 < len(chapters):
                end_ms = int(round(chapters[i + 1][0] * 1000))
            else:
                end_ms = int(round(total_end * 1000))
            end_ms = max(end_ms, start_ms + 1)
            lines += ["[CHAPTER]", "TIMEBASE=1/1000",
                      f"START={start_ms}", f"END={end_ms}",
                      f"title={_meta_escape(title)}"]
        with open(self.meta_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def _mux(self, inputs):
        """inputs: list of {'path': audio path or None, 'duration': seconds or
        None}. A None path is replaced by silence of that duration, so a file
        that vanished does not shift later chapters relative to the video."""
        n = len(inputs)
        cmd = self._ffmpeg_cmd() + ["-y", "-loglevel", "warning",
                                    "-i", self.temp_video]
        for item in inputs:
            if item["path"] is not None:
                cmd += ["-i", item["path"]]
            else:
                cmd += ["-f", "lavfi", "-t", f"{item['duration']:.3f}",
                        "-i", "anullsrc=r=44100:cl=stereo"]
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
        paths = [getattr(self, "temp_video", None),
                 getattr(self, "meta_path", None)]
        if not keep_log:
            paths.append(getattr(self, "log_path", None))
        for p in paths:
            if not p:
                continue
            try:
                if os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass

    # ------------------------------------------------------------- inspection
    def blocks(self, action):
        """True while an export (recording or finalizing) forbids `action`.

        Actions: 'load' (new files), 'source' (live <-> file), 'switch'
        (next/previous track) and 'fullscreen'.
        """
        if not (self.is_recording or self.is_finalizing):
            return False
        return action in BLOCKED_DURING_EXPORT

    @property
    def tracks(self):
        """Audio files that make up the export timeline (recorded order)."""
        with self._lock:
            return [seg["path"] for seg in self._segments]

    @property
    def chapters(self):
        """Chapter list with computed start/end seconds (end is only final
        after finalization; before that it is None)."""
        with self._lock:
            segments = list(self._segments)
            cur = self._cur
        out = []
        for seg in segments:
            end_frame = seg["end_frame"]
            if end_frame is None and seg is cur:
                end_frame = self.frames
            out.append({
                "title": seg["title"],
                "path": seg["path"],
                "start": seg["start_time"],
                "end": None if end_frame is None else end_frame / self.fps,
                "frames": None if end_frame is None else end_frame - seg["start_frame"],
            })
        return out

    @property
    def skipped(self):
        with self._lock:
            return list(self._skipped)
