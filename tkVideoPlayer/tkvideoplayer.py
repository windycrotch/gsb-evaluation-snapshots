import av
import time
import threading
import logging
import tkinter as tk
from collections import deque
from PIL import ImageTk, Image, ImageOps
from typing import Tuple, Dict

logging.getLogger('libav').setLevel(logging.ERROR)  # removes warning: deprecated pixel format used

# PyAV exposes the common FFmpeg error base class under different names
# depending on the version.
_FFmpegError = getattr(av, "FFmpegError", av.error.FFmpegError)

_EOF_ERRORS = (StopIteration, av.error.EOFError)

# How often the main thread drains events posted by the decoding thread.
# Keeping this small makes paused seeks feel instant while still batching
# several decoded frames into a single redraw.
_EVENT_PUMP_INTERVAL_MS = 10


class TkinterVideo(tk.Label):

    def __init__(self, master, scaled: bool = True, consistant_frame_rate: bool = True, keep_aspect: bool = False, *args, **kwargs):
        super(TkinterVideo, self).__init__(master, *args, **kwargs)

        self.path = ""
        self._load_thread = None

        self._paused = True
        self._stop = True
        self._ended = False

        self.consistant_frame_rate = consistant_frame_rate # tries to keep the frame rate consistant by skipping over a few frames

        self._container = None

        self._current_img = None
        self.current_imgtk = None
        self._frame_number = 0
        self._time_stamp = 0

        self._current_frame_size = (0, 0)

        # A seek request is stored as a float and consumed by the decoder
        # thread. ``_seek``/``_seek_sec`` are kept for backwards compatibility.
        self._seek_request = None
        self._seek = False
        self._seek_sec = 0

        # All state shared with the decoding thread is protected by this lock.
        self._lock = threading.RLock()
        self._session = 0  # incremented on every stop()/load() to invalidate old threads
        self._announced = False  # <<Duration>>/<<Loaded>> already sent for this load
        self._replay_pending = False  # play() arrived before <<Ended>> was delivered
        self._events = deque()
        self._pump_id = None

        self._video_info = {
            "duration": 0, # duration of the video
            "framerate": 0, # frame rate of the video
            "framesize": (0, 0) # tuple containing frame height and width of the video

        }

        self.set_scaled(scaled)
        self._keep_aspect_ratio = keep_aspect
        self._resampling_method: int = Image.NEAREST


        self.bind("<<Destroy>>", self._on_destroy)

    def keep_aspect(self, keep_aspect: bool):
        """ keeps the aspect ratio when resizing the image """
        self._keep_aspect_ratio = keep_aspect

    def set_resampling_method(self, method: int):
        """ sets the resampling method when resizing """
        self._resampling_method = method

    def set_size(self, size: Tuple[int, int], keep_aspect: bool=False):
        """ sets the size of the video """
        self.set_scaled(False, self._keep_aspect_ratio)
        self._current_frame_size = size
        self._keep_aspect_ratio = keep_aspect

    def _resize_event(self, event):

        self._current_frame_size = event.width, event.height

        if self._paused and self._current_img and self.scaled:
            if self._keep_aspect_ratio:
                proxy_img = ImageOps.contain(self._current_img.copy(), self._current_frame_size)

            else:
                proxy_img = self._current_img.copy().resize(self._current_frame_size)

            self.current_imgtk = ImageTk.PhotoImage(proxy_img)
            self.config(image=self.current_imgtk)


    def set_scaled(self, scaled: bool, keep_aspect: bool = False):
        self.scaled = scaled
        self._keep_aspect_ratio = keep_aspect

        if scaled:
            self.bind("<Configure>", self._resize_event)

        else:
            self.unbind("<Configure>")
            self._current_frame_size = self.video_info()["framesize"]


    def _set_frame_size(self, event=None):
        """ creates the image buffer used to display frames (main thread only) """

        framesize = self._video_info.get("framesize") or (0, 0)
        if not framesize[0] or not framesize[1]:
            return

        self.current_imgtk = ImageTk.PhotoImage(Image.new("RGBA", framesize, (255, 0, 0, 0)))
        self.config(width=150, height=100, image=self.current_imgtk)

    # ------------------------------------------------------------------
    # Event plumbing
    #
    # Tkinter is not thread safe: everything that touches Tk (drawing,
    # event_generate, after) must happen on the main thread. The decoder
    # thread therefore only publishes immutable state plus event names, and
    # a timer running on the main thread drains them.
    # ------------------------------------------------------------------

    def _post_event(self, event: str, session=None):
        with self._lock:
            if session is not None and session != self._session:
                return
            if event == "<<FrameGenerated>>" and self._events and self._events[-1] == "<<FrameGenerated>>":
                return  # coalesce: only the newest frame needs drawing
            self._events.append(event)

    def _ensure_pump(self):
        if self._pump_id is not None:
            return
        try:
            self._pump_id = self.after(_EVENT_PUMP_INTERVAL_MS, self._pump)
        except (tk.TclError, RuntimeError):
            self._pump_id = None

    def _ensure_display_buffer(self):
        if self.current_imgtk is None:
            try:
                self._set_frame_size()
            except tk.TclError:
                pass

    def _pump(self):
        """ runs on the main thread and delivers queued events """
        self._pump_id = None

        try:
            # The queue is drained one event at a time, under the lock, against
            # a snapshot of the player state taken *before* the event fires.
            # That way e.g. <<Ended>> is never delivered after the state has
            # been moved on by a replay.
            while True:
                with self._lock:
                    if not self._events:
                        break
                    event = self._events.popleft()
                    is_end = self._ended and self._paused

                if not self.winfo_exists():
                    return

                if event == "<<FrameGenerated>>":
                    self._ensure_display_buffer()
                    # Draw directly so the frame is visible even when the
                    # window is iconified (Tk does not dispatch synthetic
                    # events to unmapped windows), then notify user bindings.
                    self._display_frame()
                    self.event_generate("<<FrameGenerated>>")
                    continue

                if event in ("<<Duration>>", "<<Loaded>>"):
                    self._ensure_display_buffer()

                self.event_generate(event)

                if event == "<<Ended>>":
                    with self._lock:
                        replay = self._replay_pending
                        self._replay_pending = False
                    if replay:
                        # play() was called from a thread (or re-entrantly from
                        # an <<Ended>> handler) before this event was
                        # delivered; only now is it safe to restart.
                        self._begin_replay()
                        continue
                    # Stop pumping while the player idles at the end; play()
                    # or seek() restarts it via _ensure_pump(). Anything still
                    # queued is handled by the tail check below.
                    with self._lock:
                        if is_end and self._ended and self._paused and not self._events:
                            return

        except tk.TclError:
            return

        with self._lock:
            alive = self._load_thread is not None and self._load_thread.is_alive()
            pending = bool(self._events)
            idle_at_end = self._ended and self._paused

        if pending or (alive and not idle_at_end):
            self._ensure_pump()

    # ------------------------------------------------------------------
    # Decoding thread
    # ------------------------------------------------------------------

    def _now_ms(self):
        return time.time_ns() // 1_000_000

    def _frame_duration(self) -> float:
        framerate = self._video_info.get("framerate") or 0
        return 1.0 / framerate if framerate else 0.04

    def _clamp_seek_time(self, sec) -> float:
        """ clamps a requested timestamp to [0, duration] """
        try:
            target = float(sec)
        except (TypeError, ValueError):
            target = 0.0

        if target != target:  # NaN
            target = 0.0

        target = max(0.0, target)

        duration = self._video_info.get("duration") or 0
        if duration > 0:
            target = min(target, float(duration))

        return target

    def _render_frame(self, frame, time_stamp, frame_number=None, session=None):
        """ converts a decoded frame to a PIL image (called from the worker) """
        with self._lock:
            if session is not None and session != self._session:
                return
            width, height = self._current_frame_size
            keep_aspect = self._keep_aspect_ratio

        if not width or not height:
            width, height = frame.width, frame.height

        if keep_aspect:
            im_ratio = frame.width / frame.height
            dest_ratio = width / height
            if im_ratio != dest_ratio:
                if im_ratio > dest_ratio:
                    height = round(frame.height / frame.width * width)
                else:
                    width = round(frame.width / frame.height * height)

        width = max(int(width), 1)
        height = max(int(height), 1)

        image = frame.to_image(width=width, height=height, interpolation="FAST_BILINEAR")

        with self._lock:
            if session is not None and session != self._session:
                return
            self._current_img = image
            self._time_stamp = time_stamp
            if frame_number is not None:
                self._frame_number = frame_number

        self._post_event("<<FrameGenerated>>", session)

    def _apply_seek(self, container, stream, target, frames, session=None):
        """ seeks and returns ``(frames, pending)`` positioned at ``target``.

        ``pending`` is a decoded frame that lies just after the requested
        timestamp and must be shown next if playback continues, so no frame is
        skipped when the neighbour closest to the target was chosen.

        ``container.decode()`` returns a generator bound to the demuxer
        cursor; re-creating it while frames are still buffered prematurely
        reports end-of-file, so exactly one generator is kept alive and it is
        only rebuilt after a seek.
        """

        target = self._clamp_seek_time(target)
        self._seek_sec = target

        try:
            container.seek(int(target * av.time_base), backward=True, any_frame=False)
        except _FFmpegError:
            # Some containers refuse a seek to the very end; start over and
            # let the forward scan below find the closest frame.
            try:
                container.seek(0, backward=True, any_frame=False)
            except _FFmpegError:
                return frames, None

        # Rebuild the generator only after seeking: the old one is bound to the
        # pre-seek demuxer position and would otherwise replay stale packets.
        frames = container.decode(video=0)

        found_frame = None
        found_ts = None
        previous_frame = None
        previous_ts = None
        last_frame = None
        last_ts = None
        pending = None

        while True:
            with self._lock:
                if session is not None and session != self._session:
                    return frames, None
            try:
                frame = next(frames)
            except _EOF_ERRORS:
                break
            except _FFmpegError:
                break

            try:
                ts = float(frame.pts * stream.time_base)
            except (TypeError, ValueError):
                ts = last_ts if last_ts is not None else target

            last_frame, last_ts = frame, ts

            if ts >= target:
                # Pick whichever neighbour is closest to the requested time so
                # current_duration() is within half a frame of the target.
                if previous_frame is not None and (target - previous_ts) < (ts - target):
                    found_frame, found_ts = previous_frame, previous_ts
                    pending = (frame, ts)
                else:
                    found_frame, found_ts = frame, ts
                break

            previous_frame, previous_ts = frame, ts

        if found_frame is not None:
            self._render_frame(found_frame, found_ts,
                               frame_number=int(round(found_ts * (self._video_info.get("framerate") or 0))),
                               session=session)
            return frames, pending

        if last_frame is not None:
            # The target is at (or past) the end of the video: show the last
            # frame and report the full duration.
            duration = self._video_info.get("duration") or 0
            end_ts = float(duration) if duration > 0 else last_ts
            self._render_frame(last_frame, end_ts,
                               frame_number=int(round(last_ts * (self._video_info.get("framerate") or 0))),
                               session=session)
            return frames, None

        # Nothing could be decoded (empty/broken stream); at least make the
        # timestamp reflect the request instead of raising.
        with self._lock:
            if session is not None and session != self._session:
                return frames, None
            self._time_stamp = target

        return frames, None

    def _decode_loop(self, container, stream, session, frames, pending=None):
        """ decodes frames until the video ends or the player is stopped """
        framerate = self._video_info.get("framerate") or 0
        time_in_frame = self._frame_duration() * 1000  # ms each frame should be shown

        # Frames are paced against absolute deadlines. Sleeping "until the
        # remaining time of this frame" and recomputing the delta from the
        # previous loop start made the player run at roughly double speed,
        # because a long sleep is followed by an iteration with a full delta.
        deadline = self._now_ms()

        while True:
            with self._lock:
                if session != self._session:
                    return "stale", frames
                if self._stop:
                    return "stopped", frames
                target = self._seek_request
                if target is not None:
                    self._seek_request = None
                paused = self._paused

            if target is not None:
                # A seek must be honoured even while paused, so that the
                # displayed frame and current_duration() follow the request.
                frames, pending = self._apply_seek(container, stream, target, frames, session)
                deadline = self._now_ms()
                continue

            if paused:
                deadline = self._now_ms()
                time.sleep(0.005)  # let other threads run while paused
                continue

            if pending is not None:
                # The frame just after the seek target, decoded while
                # resolving the seek, plays next instead of being dropped.
                frame, time_stamp = pending
                pending = None
            else:
                try:
                    frame = next(frames)
                except _EOF_ERRORS:
                    return "ended", frames
                except _FFmpegError:
                    return "ended", frames

                try:
                    time_stamp = float(frame.pts * stream.time_base)
                except (TypeError, ValueError):
                    time_stamp = self._time_stamp + self._frame_duration()

            with self._lock:
                self._frame_number += 1
                frame_number = self._frame_number

            self._render_frame(frame, time_stamp, frame_number=frame_number)

            if framerate and frame_number % framerate == 0:
                self._post_event("<<SecondChanged>>")

            if self.consistant_frame_rate:
                deadline += time_in_frame
                delay = deadline - self._now_ms()
                if delay > 0:
                    time.sleep(delay / 1000)
                else:
                    # Fell behind (slow decode or a slow main thread): resync
                    # instead of trying to catch up with a burst of frames.
                    deadline = self._now_ms()

    def _wait_at_end(self, session):
        """ blocks the worker after EOF until playback is requested again """
        while True:
            with self._lock:
                if session != self._session or self._stop:
                    return "stop"
                if self._seek_request is not None:
                    return "seek"
                if not self._ended:
                    return "play"
            time.sleep(0.005)

    def _load(self, path, session):
        """ load's file from a thread """

        try:
            while True:
                with self._lock:
                    if session != self._session or self._stop:
                        return

                try:
                    container = av.open(path)
                except Exception:
                    return

                with self._lock:
                    announce = not self._announced
                    self._announced = True
                    # A seek issued before the file was opened (or carried
                    # over from the end of the stream) is applied right away.
                    initial_seek = self._seek_request
                    if initial_seek is not None:
                        self._seek_request = None
                    if self._ended:
                        # Replayed from the end or seeked from the end.
                        if initial_seek is None:
                            self._time_stamp = 0
                            self._frame_number = 0
                        self._ended = False

                reason = "ended"
                try:
                    with container as current_container:
                        with self._lock:
                            if session != self._session or self._stop:
                                return
                            self._container = current_container

                        current_container.streams.video[0].thread_type = "AUTO"

                        stream = current_container.streams.video[0]

                        try:
                            framerate = int(round(float(stream.average_rate)))
                            if framerate <= 0:
                                raise ValueError
                        except (TypeError, ValueError, ZeroDivisionError):
                            raise TypeError("Not a video file")

                        with self._lock:
                            self._video_info["framerate"] = framerate
                            self._video_info["framesize"] = (stream.width, stream.height)
                            if not self.scaled and not any(self._current_frame_size):
                                self._current_frame_size = (stream.width, stream.height)

                        try:
                            duration = float(stream.duration * stream.time_base)
                        except (TypeError, ValueError):
                            duration = 0

                        if duration <= 0 and current_container.duration:
                            # Some containers (e.g. mkv) only expose the
                            # duration at container level.
                            duration = float(current_container.duration / av.time_base)

                        with self._lock:
                            if duration > 0:
                                self._video_info["duration"] = duration
                            self.stream_base = stream.time_base

                        if announce:
                            if duration > 0:
                                self._post_event("<<Duration>>")  # duration has been found

                            self._post_event("<<Loaded>>")  # generated when the video file is opened

                        # One decoder generator for the whole file; it must not
                        # be re-created per frame, or PyAV reports EOF early
                        # while frames are still pending in the decoder.
                        frames = current_container.decode(video=0)
                        pending = None

                        if initial_seek is not None:
                            frames, pending = self._apply_seek(
                                current_container, stream, initial_seek, frames, session
                            )
                        else:
                            # Show the first frame right away, even while paused
                            # and before play() is called.
                            try:
                                first = next(frames)
                            except (_EOF_ERRORS + (_FFmpegError,)):
                                first = None
                            if first is not None:
                                try:
                                    first_ts = float(first.pts * stream.time_base)
                                except (TypeError, ValueError):
                                    first_ts = 0.0
                                self._render_frame(first, first_ts, frame_number=0, session=session)

                        reason, frames = self._decode_loop(
                            current_container, stream, session, frames, pending
                        )

                except (TypeError, ValueError, OSError, _FFmpegError):
                    # Not a readable video file (or it disappeared): stop the
                    # worker quietly instead of raising in a background thread.
                    return

                finally:
                    with self._lock:
                        if self._container is container:
                            self._container = None

                with self._lock:
                    if session != self._session or self._stop:
                        return

                    if reason != "ended":
                        return

                    # Natural end of the stream: report the full duration,
                    # pause, and wait for a replay request instead of letting
                    # the worker die (which made a following play() a no-op).
                    # The state change and the event are queued together so the
                    # pump can never observe one without the other.
                    if (self._video_info.get("duration") or 0) > 0:
                        self._time_stamp = float(self._video_info["duration"])
                    self._ended = True
                    self._paused = True
                    self._frame_number = int(round(self._time_stamp * (self._video_info.get("framerate") or 0)))
                    self._events.append("<<Ended>>")

                outcome = self._wait_at_end(session)
                if outcome in ("stop", "stale"):
                    return

                with self._lock:
                    if outcome == "play":
                        # Replaying: start over from the first frame.
                        self._time_stamp = 0
                        self._frame_number = 0
                        self._seek_request = None

                # Loop around and re-open the file for replay/seek-after-end.

        finally:
            with self._lock:
                if session == self._session:
                    if self._load_thread is threading.current_thread():
                        self._load_thread = None
            # No explicit gc.collect() here: running a full collection on the
            # decoder thread while the main thread allocates Tk/PIL objects is
            # both expensive and a known source of interpreter crashes.

    def _on_destroy(self, event=None):
        self._shutdown()

    def _shutdown(self):
        """ stops the decoder when the widget is destroyed (never joins) """
        with self._lock:
            self._session += 1
            self._paused = True
            self._stop = True
            self._load_thread = None
            self._container = None


    def load(self, path: str):
        """ loads the file from the given path """
        self.stop()
        with self._lock:
            self.path = path
            self._time_stamp = 0
            self._frame_number = 0
            self._ended = False
            self._announced = False
            self._seek_request = None
            self._video_info["duration"] = 0
            self._video_info["framerate"] = 0
            # Open the file right away in the paused state so <<Duration>> and
            # <<Loaded>> fire (and the first frame is shown) without play().
            self._stop = False

        self._ensure_pump()
        self._start_load_thread()

    def stop(self):
        """ stops reading the file """
        with self._lock:
            self._session += 1
            self._paused = True
            self._stop = True
            self._ended = False
            self._announced = False
            self._replay_pending = False
            self._seek_request = None
            self._seek = False
            self._seek_sec = 0
            self._time_stamp = 0
            self._frame_number = 0
            thread = self._load_thread
            self._load_thread = None
            self._container = None

        # Give the decoder a moment to exit so the file handle is released
        # before another video is loaded. The worker never touches Tk, so
        # joining here cannot deadlock the main thread.
        if thread is not None and thread is not threading.current_thread() and thread.is_alive():
            thread.join(timeout=0.5)

    def pause(self):
        """ pauses the video file """
        self._paused = True

    def _start_load_thread(self):
        with self._lock:
            if self._load_thread is not None and self._load_thread.is_alive():
                return
            if not self.path:
                return
            session = self._session
            thread = threading.Thread(target=self._load, args=(self.path, session), daemon=True)
            self._load_thread = thread
        thread.start()

    def _begin_replay(self):
        """ leaves the end-of-video state and restarts from the first frame """
        with self._lock:
            if self._paused:
                # play() was followed by pause() before <<Ended>> was
                # delivered: stay parked at the end.
                self._ended = True
                if (self._video_info.get("duration") or 0) > 0:
                    self._time_stamp = float(self._video_info["duration"])
                return

            self._ended = False
            self._stop = False
            self._time_stamp = 0
            self._frame_number = 0
            self._seek_request = None
            needs_thread = self._load_thread is None or not self._load_thread.is_alive()

        self._ensure_pump()

        if needs_thread:
            self._start_load_thread()

    def play(self):
        """ plays the video file """
        with self._lock:
            if not self.path:
                return

            needs_thread = self._load_thread is None or not self._load_thread.is_alive()

            if self._ended and any(event == "<<Ended>>" for event in self._events):
                # play() arrived before <<Ended>> was delivered (e.g. called
                # from another thread). Restarting now would make the handler
                # observe an already-reset player, so defer it until the pump
                # has delivered the event.
                self._replay_pending = True
            elif self._ended:
                # Replay from the beginning rather than staying at the end.
                self._ended = False
                self._time_stamp = 0
                self._frame_number = 0
                self._seek_request = None

            self._paused = False
            self._stop = False

        self._ensure_pump()

        if needs_thread:
            self._start_load_thread()

    def is_paused(self):
        """ returns if the video is paused """
        return self._paused

    def video_info(self) -> Dict:
        """ returns dict containing duration, frame_rate, file"""
        return self._video_info

    def metadata(self) -> Dict:
        """ returns metadata if available """
        container = self._container
        if container:
            try:
                return container.metadata
            except Exception:
                return {}

        return {}

    def current_frame_number(self) -> int:
        """ return current frame number """
        return self._frame_number

    def current_duration(self) -> float:
        """ returns current playing duration in sec """
        return self._time_stamp

    def current_img(self) -> Image:
        """ returns current frame image """
        return self._current_img

    def _display_frame(self, event=None):
        """ displays the frame on the label (main thread only) """

        if self._current_img is None:
            return

        if self.current_imgtk is not None and \
                self.current_imgtk.width() == self._current_img.width and \
                self.current_imgtk.height() == self._current_img.height:
            self.current_imgtk.paste(self._current_img)
        else:
            self.current_imgtk = ImageTk.PhotoImage(self._current_img)
        self.config(image=self.current_imgtk)

    def seek(self, sec: int):
        """ seeks to specific time (clamped to [0, duration]) """

        target = self._clamp_seek_time(sec)
        self._seek_sec = target
        self._seek = True

        with self._lock:
            self._seek_request = target
            self._ended = False
            needs_thread = self._load_thread is None or not self._load_thread.is_alive()
            if needs_thread:
                # Seeking before play()/after an error still needs a decoder,
                # but playback stays paused.
                self._stop = False

        self._ensure_pump()

        if needs_thread:
            self._start_load_thread()
