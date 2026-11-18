"""Manual, visual reproducer for the three TkinterVideo behaviours.

This builds a small GUI (progress bar + buttons, like examples/sample_player.py)
around a short clip that is generated locally, so you can eyeball each path:

    1. Pause, then drag the progress bar  -> the frame updates immediately and
       the slider stays where you dropped it while the player stays paused.
    2. Drag past the end / before the start -> the position is clamped, no error.
    3. Let it play to the end, then press Play -> it restarts from 0 instead of
       sitting on the last frame.

Run it with::

    python examples/pause_seek_replay_demo.py

A GIF-free, text-only version of the same checks lives in
``tests/test_tkvideoplayer.py`` and needs no interaction.
"""

import datetime
import os
import sys
import tempfile
import tkinter as tk

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tkVideoPlayer import TkinterVideo  # noqa: E402
from tests.make_test_video import generate_video  # noqa: E402

DURATION = 4
FPS = 10


def build_video():
    path = os.path.join(tempfile.gettempdir(), "tkvideoplayer_demo.mp4")
    if not os.path.exists(path):
        generate_video(path, seconds=DURATION, fps=FPS)
    return path


def main():
    video = build_video()

    root = tk.Tk()
    root.title("TkinterVideo pause / seek / replay check")

    video_player = TkinterVideo(master=root, scaled=True)
    video_player.pack(expand=True, fill="both")
    video_player.load(video)

    bar = tk.Frame(root)
    bar.pack(fill="x")

    play_pause_btn = tk.Button(bar, text="Play", width=6)
    play_pause_btn.pack(side="left")

    back_btn = tk.Button(bar, text="-1s")
    back_btn.pack(side="left")

    position = tk.DoubleVar(root, value=0)
    slider = tk.Scale(
        bar, variable=position, from_=0, to=DURATION,
        orient="horizontal", resolution=0.1, showvalue=False,
    )
    slider.pack(side="left", fill="x", expand=True)

    forward_btn = tk.Button(bar, text="+1s")
    forward_btn.pack(side="left")

    out_of_range_btn = tk.Button(bar, text="Jump past end")
    out_of_range_btn.pack(side="left")

    status = tk.StringVar(root, value="")
    tk.Label(root, textvariable=status, anchor="w", justify="left").pack(fill="x")

    # ``dragging`` stops playback updates from fighting the user's drag.
    dragging = {"value": False}
    # Guards the programmatic slider updates so they are not treated as seeks.
    updating = {"value": False}

    def set_status(text):
        status.set(text)

    def refresh_slider():
        if dragging["value"]:
            return
        updating["value"] = True
        position.set(video_player.current_duration())
        updating["value"] = False

    def show_time(event=None):
        refresh_slider()
        duration = video_player.video_info()["duration"]
        set_status(
            f"{datetime.timedelta(seconds=video_player.current_duration())} / "
            f"{datetime.timedelta(seconds=duration)}   "
            f"paused={video_player.is_paused()}"
        )

    def seek_command(value):
        target = float(value)
        video_player.seek(target)
        set_status(f"seek({target}) -> clamped to {video_player.current_duration():.2f}s")

    def on_drag_start(event=None):
        dragging["value"] = True

    def on_drag_end(event=None):
        dragging["value"] = False
        seek_command(position.get())

    def play_pause():
        if video_player.is_paused():
            video_player.play()
            play_pause_btn.config(text="Pause")
        else:
            video_player.pause()
            play_pause_btn.config(text="Play")
        show_time()

    def skip(delta):
        video_player.seek(video_player.current_duration() + delta)
        show_time()

    def jump_past_end():
        # Deliberately out of range: seek() must clamp instead of raising.
        video_player.seek(video_player.video_info()["duration"] + 30)
        show_time()

    def on_ended(event=None):
        play_pause_btn.config(text="Play")
        position.set(0)
        set_status("ended - press Play to replay from the start")

    def on_duration(event=None):
        duration = video_player.video_info()["duration"]
        slider.config(to=duration)
        set_status(f"duration = {duration:.2f}s")
        show_time()

    play_pause_btn.config(command=play_pause)
    back_btn.config(command=lambda: skip(-1))
    forward_btn.config(command=lambda: skip(1))
    out_of_range_btn.config(command=jump_past_end)

    slider.bind("<ButtonPress-1>", on_drag_start)
    slider.bind("<ButtonRelease-1>", on_drag_end)

    video_player.bind("<<Duration>>", on_duration)
    video_player.bind("<<SecondChanged>>", show_time)
    video_player.bind("<<Ended>>", on_ended)

    root.after(500, video_player.play)
    root.mainloop()


if __name__ == "__main__":
    main()
