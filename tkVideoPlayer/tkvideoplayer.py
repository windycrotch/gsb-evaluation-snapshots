import av
import time
import queue
import threading
import logging
import tkinter as tk
from PIL import ImageTk, Image, ImageOps
from typing import Tuple, Dict

logging.getLogger('libav').setLevel(logging.ERROR)  # removes warning: deprecated pixel format used


class TkinterVideo(tk.Label):

    def __init__(self, master, scaled: bool = True, consistant_frame_rate: bool = True, keep_aspect: bool = False, *args, **kwargs):
        super(TkinterVideo, self).__init__(master, *args, **kwargs)

        self.path = ""

        # guards every piece of state shared with the decode thread
        self._lock = threading.RLock()

        # Monotonically increasing generation counter. Every stop()/new decode
        # thread bumps it; a decode thread may only touch shared state while
        # its captured generation is current, and every event it queues is
        # tagged with its generation so late events of a previous video are
        # dropped instead of polluting the new one.
        self._load_id = 0
        self._load_thread = None

        self._paused = True
        self._stop = True
        self._ended = False  # set when the stream reached its natural end

        self.consistant_frame_rate = consistant_frame_rate # tries to keep the frame rate consistant by skipping over a few frames

        self._container = None

        self._current_img = None
        self._current_frame_Tk = None
        self._frame_number = 0
        self._time_stamp = 0

        self._current_frame_size = (0, 0)

        # pending seek target in seconds (None = no pending seek); consumed by
        # the decode thread, applied even while paused
        self._seek_requested = None

        # The decode thread never touches tkinter directly (cross-thread Tcl
        # calls are unsafe); it drops (load_id, kind, payload) items on this
        # queue and the tk main thread drains it via _poll_events.
        self._event_queue = queue.Queue()
        self._poll_after_id = None

        self._video_info = {
            "duration": 0, # duration of the video
            "framerate": 0, # frame rate of the video
            "framesize": (0, 0) # tuple containing frame height and width of the video

        }

        self.set_scaled(scaled)
        self._keep_aspect_ratio = keep_aspect
        self._resampling_method: int = Image.NEAREST


        self.bind("<<Destroy>>", self.stop)
        self.bind("<<FrameGenerated>>", self._display_frame)

        self._poll_events()

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

            self._current_imgtk = ImageTk.PhotoImage(proxy_img)
            self.config(image=self._current_imgtk)


    def set_scaled(self, scaled: bool, keep_aspect: bool = False):
        self.scaled = scaled
        self._keep_aspect_ratio = keep_aspect

        if scaled:
            self.bind("<Configure>", self._resize_event)

        else:
            self.unbind("<Configure>")
            self._current_frame_size = self.video_info()["framesize"]


    def _set_frame_size(self, event=None):
        """ sets frame size to avoid unexpected resizing; runs on the tk main thread """

        self._video_info["framesize"] = (self._container.streams.video[0].width, self._container.streams.video[0].height)

        self.current_imgtk = ImageTk.PhotoImage(Image.new("RGBA", self._video_info["framesize"], (255, 0, 0, 0)))
        self.config(width=150, height=100, image=self.current_imgtk)

    # ------------------------------------------------------------------
    # event plumbing between decode thread and tk main thread
    # ------------------------------------------------------------------

    def _queue_event(self, load_id: int, sequence: str):
        """ called from the decode thread to publish a virtual event """
        self._event_queue.put((load_id, "event", sequence))

    def _queue_call(self, load_id: int, func):
        """ called from the decode thread to run `func` on the tk main thread """
        self._event_queue.put((load_id, "call", func))

    def _poll_events(self):
        """ drains the event queue on the tk main thread and reschedules itself """
        try:
            while True:
                load_id, kind, payload = self._event_queue.get_nowait()

                if load_id != self._load_id:
                    continue # stale generation: belongs to a previous video

                if kind == "event":
                    self.event_generate(payload)
                else:
                    payload()

        except queue.Empty:
            pass
        except tk.TclError:
            return # widget is being destroyed, stop polling

        try:
            self._poll_after_id = self.after(15, self._poll_events)
        except tk.TclError:
            pass # widget is being destroyed, stop polling

    def _is_current(self, load_id: int) -> bool:
        """ True while the decode thread of generation `load_id` still owns the player """
        return self._load_id == load_id and not self._stop

    def _decode_and_present(self, frame_iter, stream, load_id: int) -> bool:
        """ Decodes a single frame and publishes it.

        Returns False when the decode thread must exit (stale generation or
        natural end of stream). On natural end of stream ``_ended`` is set
        and <<Ended>> is queued exactly once.
        """

        try:
            frame = next(frame_iter)

        except (StopIteration, av.error.EOFError):
            with self._lock:
                if not self._is_current(load_id):
                    return False
                self._ended = True
                self._paused = True

            self._queue_event(load_id, "<<Ended>>")
            return False

        with self._lock:
            if not self._is_current(load_id):
                return False

            if frame.pts is not None:
                self._time_stamp = float(frame.pts * stream.time_base)

            width, height = self._current_frame_size
            if width <= 0 or height <= 0:
                width, height = frame.width, frame.height

            elif self._keep_aspect_ratio:
                im_ratio = frame.width / frame.height
                dest_ratio = width / height
                if im_ratio != dest_ratio:
                    if im_ratio > dest_ratio:
                        height = round(frame.height / frame.width * width)
                    else:
                        width = round(frame.width / frame.height * height)

            self._current_img = frame.to_image(width=width, height=height, interpolation="FAST_BILINEAR")

            self._frame_number += 1
            frame_number = self._frame_number
            framerate = self._video_info["framerate"]

        self._queue_event(load_id, "<<FrameGenerated>>")

        if framerate and frame_number % framerate == 0:
            self._queue_event(load_id, "<<SecondChanged>>")

        return True

    def _load(self, path, load_id: int, notify_loaded: bool):
        """ load's file from a thread """

        container = None

        try:
            container = av.open(path)

            stream = container.streams.video[0]
            stream.thread_type = "AUTO"

            # self._container.fast_seek = True
            # self._container.discard_corrupt = True

            with self._lock:
                if not self._is_current(load_id):
                    return

                self._container = container

                try:
                    self._video_info["framerate"] = int(float(stream.average_rate))

                except TypeError:
                    raise TypeError("Not a video file")

                try:

                    self._video_info["duration"] = float(stream.duration * stream.time_base)
                    self._queue_event(load_id, "<<Duration>>")  # duration has been found

                except TypeError:  # the video duration cannot be found, this can happen for mkv files
                    pass

                self._frame_number = 0
                self._time_stamp = 0

                self._queue_call(load_id, self._set_frame_size)

                self.stream_base = stream.time_base

                if notify_loaded:
                    self._queue_event(load_id, "<<Loaded>>") # generated when the video file is opened

            framerate = self._video_info["framerate"]
            time_in_frame = (1/framerate)*1000 if framerate else 0 # second it should play each frame

            frame_iter = container.decode(video=0)

            while True:
                with self._lock:
                    if not self._is_current(load_id):
                        break

                    seek_req = self._seek_requested
                    self._seek_requested = None
                    paused = self._paused

                if seek_req is not None: # seek to specific second
                    try:
                        container.seek(int(seek_req*1000000), backward=True, any_frame=False) # the seek time is given in av.time_base, the multiplication is to correct the frame
                        frame_iter = container.decode(video=0) # restart decoding from the new position
                    except Exception:
                        pass

                    with self._lock:
                        if not self._is_current(load_id):
                            break
                        self._frame_number = int(framerate * seek_req)
                        self._time_stamp = seek_req

                    # present a frame right away so the new position is visible
                    # even when the player is paused
                    if not self._decode_and_present(frame_iter, stream, load_id):
                        break

                    continue

                if paused:
                    time.sleep(0.001) # to allow other threads to function better when its paused
                    continue

                frame_start = time.time_ns() // 1_000_000  # time in milliseconds

                if not self._decode_and_present(frame_iter, stream, load_id):
                    break

                if self.consistant_frame_rate:
                    # sleep only the remainder of the frame budget; the time
                    # spent decoding/presenting this frame counts towards it
                    elapsed = time.time_ns() // 1_000_000 - frame_start
                    time.sleep(max((time_in_frame - elapsed)/1000, 0))

        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass

            with self._lock:
                # only the still-current thread may clear shared references;
                # a stale thread must not touch the state of its successor
                if self._load_id == load_id:
                    self._container = None
                    if self._load_thread is threading.current_thread():
                        self._load_thread = None

    def load(self, path: str):
        """ loads the file from the given path """
        self.stop()

        with self._lock:
            self.path = path

    def stop(self, event=None):
        """ stops reading the file and terminates the decode thread """
        with self._lock:
            self._paused = True
            self._stop = True
            self._ended = False
            self._seek_requested = None
            self._frame_number = 0
            self._time_stamp = 0
            self._load_id += 1 # invalidates the running decode thread and its queued events

            thread = self._load_thread
            self._load_thread = None

        if event is not None and self._poll_after_id is not None:
            # called from <<Destroy>>: cancel the event poll, the widget is gone
            try:
                self.after_cancel(self._poll_after_id)
            except tk.TclError:
                pass
            self._poll_after_id = None

        # wait for the old decode thread to die; it closes and releases its
        # container in its own finally-block before join() returns. The decode
        # thread never calls into tkinter, so joining cannot deadlock the UI.
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join()

        with self._lock:
            self._container = None

    def pause(self):
        """ pauses the video file """
        with self._lock:
            self._paused = True

    def play(self):
        """ plays the video file; replays from the beginning after the video ended """
        with self._lock:
            self._paused = False
            self._stop = False

            old_thread = self._load_thread

            if old_thread is not None and old_thread.is_alive() and not self._ended:
                return # a running thread only needs the unpause above

            if not self.path:
                return

            restart = self._ended # replay from the beginning after <<Ended>>
            self._ended = False

            if restart:
                self._frame_number = 0
                self._time_stamp = 0

            self._load_id += 1
            load_id = self._load_id

        # an "alive" thread here is one that just reached the end of the
        # stream and is about to exit; wait for it before starting the next one
        if old_thread is not None and old_thread.is_alive() and old_thread is not threading.current_thread():
            old_thread.join()

        with self._lock:
            if self._stop or self._load_id != load_id:
                return # stop()/load() intervened while joining

            self._load_thread = threading.Thread(target=self._load, args=(self.path, load_id, not restart), daemon=True)
            self._load_thread.start()

    def is_paused(self):
        """ returns if the video is paused """
        return self._paused

    def video_info(self) -> Dict:
        """ returns dict containing duration, frame_rate, file"""
        return self._video_info

    def metadata(self) -> Dict:
        """ returns metadata if available """
        if self._container:
            return self._container.metadata

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

    def _display_frame(self, event):
        """ displays the frame on the label """

        img = self._current_img
        if img is None or getattr(self, "current_imgtk", None) is None:
            return

        if self.current_imgtk.width() == img.width and self.current_imgtk.height() == img.height:
            self.current_imgtk.paste(img)
        else:
            self.current_imgtk = ImageTk.PhotoImage(img)
        self.config(image=self.current_imgtk)

    def seek(self, sec: int):
        """ seeks to specific time, clamped to [0, duration] """

        with self._lock:
            duration = self._video_info.get("duration") or 0

            sec = max(0, sec)
            if duration > 0:
                sec = min(sec, duration)

            self._seek_requested = sec
