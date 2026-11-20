# -----------------------------------------------------------------------------
#  Offline tests for the export lifecycle (exporter.ExportManager).
#  No FFmpeg, no pygame, no audio device needed - FFmpeg is replaced by test
#  doubles (a fake Popen for the frame recorder, a fake run() for the mux).
#
#  Run:  python -m unittest discover -s tests -v      (or: pytest tests -q)
# -----------------------------------------------------------------------------
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from exporter import ExportManager, STATE_IDLE, STATE_FINALIZING, STATE_RECORDING

W, H = 16, 8
FRAME_BYTES = W * H * 3
FPS = 10


# ----------------------------------------------------------------- test doubles
class _FakeStdin:
    def __init__(self, proc):
        self._proc = proc
        self.closed = False

    def write(self, data):
        proc = self._proc
        if proc.fail_after is not None and proc.bytes_written >= proc.fail_after:
            proc.failed_pipe = True
            raise BrokenPipeError("fake ffmpeg stdin closed")
        proc.bytes_written += len(data)
        proc.writes += 1

    def close(self):
        self.closed = True


class FakePopen:
    """Stands in for the ffmpeg process that consumes raw RGB frames."""

    def __init__(self, cmd, stdin=None, stdout=None, stderr=None, **kwargs):
        self.cmd = list(cmd)
        self.bytes_written = 0
        self.writes = 0
        self.fail_after = None
        self.failed_pipe = False
        self.returncode = 0
        self.stdin = _FakeStdin(self)
        if stderr is not None:
            stderr.write("fake ffmpeg: recording rawvideo\n")
            stderr.flush()
        # The real ffmpeg creates the output file (last arg = temp video).
        with open(self.cmd[-1], "wb") as f:
            f.write(b"FAKE-VIDEO")

    def wait(self, timeout=None):
        return self.returncode


class FakeRun:
    """Stands in for subprocess.run() during the mux step.

    Captures the argv and the metadata file *as it exists at mux time* so the
    test can assert on what the finalizer really produced.
    """

    def __init__(self):
        self.returncode = 0
        self.stderr = ""
        self.calls = []
        self.gate = None
        self.entered = threading.Event()   # set once the mux call is reached

    def __call__(self, cmd, **kwargs):
        self.calls.append(list(cmd))
        self.meta_text = None
        last_i = max(i for i, arg in enumerate(cmd) if arg == "-i")
        meta_path = cmd[last_i + 1]
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                self.meta_text = f.read()
        except OSError:
            pass
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(timeout=10)
        if self.returncode == 0:
            with open(cmd[-1], "wb") as f:
                f.write(b"FAKE-FINAL-MP4")

        class _Result:
            def __init__(self, rc, err):
                self.returncode = rc
                self.stderr = err

        return _Result(self.returncode, self.stderr)


# --------------------------------------------------------------------- helpers
def parse_chapters(meta_text):
    chapters = []
    lines = (meta_text or "").splitlines()
    i = 0
    while i < len(lines):
        if lines[i].strip() == "[CHAPTER]":
            start = end = None
            title = ""
            i += 1
            while i < len(lines) and lines[i].strip() != "[CHAPTER]":
                line = lines[i]
                if line.startswith("START="):
                    start = int(line.split("=", 1)[1]) / 1000.0
                elif line.startswith("END="):
                    end = int(line.split("=", 1)[1]) / 1000.0
                elif line.startswith("title="):
                    title = line.split("=", 1)[1]
                i += 1
            chapters.append({"start": start, "end": end, "title": title})
        else:
            i += 1
    return chapters


def mux_audio_inputs(cmd):
    """Audio inputs of the mux command, in the order ffmpeg sees them."""
    stop = cmd.index("-map_metadata")
    paths = []
    for i, arg in enumerate(cmd[:stop]):
        if arg == "-i":
            paths.append(cmd[i + 1])
    return paths[1:-1]        # [0] = temp video, [-1] = metadata file


class ExportManagerTest(unittest.TestCase):
    def setUp(self):
        self.out_dir = tempfile.mkdtemp(prefix="export_test_")
        self.runs = FakeRun()
        self.popen_instances = []

        def popen_factory(cmd, stdin=None, stdout=None, stderr=None, **kw):
            proc = FakePopen(cmd, stdin=stdin, stdout=stdout, stderr=stderr, **kw)
            self.popen_instances.append(proc)
            return proc

        self.manager = ExportManager(
            out_dir=self.out_dir, fps=FPS, ffmpeg_path="fake-ffmpeg",
            popen_factory=popen_factory, run_factory=self.runs)

    def tearDown(self):
        self.manager.wait()
        shutil.rmtree(self.out_dir, ignore_errors=True)

    # ---------------------------------------------------------------- helpers
    def start(self):
        self.assertTrue(self.manager.start(W, H))
        self.assertEqual(self.manager.state, STATE_RECORDING)
        return self.manager._session.proc

    def write_frames(self, count, data=b"\x01" * FRAME_BYTES):
        self.manager.write(data, count)

    def wait_final(self, timeout=10):
        finalizer = self.manager._finalizer
        self.assertIsNotNone(finalizer)
        finalizer.join(timeout=timeout)
        self.assertFalse(finalizer.is_alive(), "finalizer did not finish")

    def audio_files(self):
        paths = []
        for name in ("a.mp3", "b.mp3", "c.mp3"):
            path = os.path.join(self.out_dir, name)
            with open(path, "wb") as f:
                f.write(b"audio")
            paths.append(path)
        return paths

    # ------------------------------------------------------- chapters / order
    def test_chapter_times_follow_play_order(self):
        procs = self.start()
        a, b = self.audio_files()[:2]
        self.assertTrue(self.manager.begin_track(a, 2.0, "A", index=0, started_at=0.0))
        self.write_frames(20)                       # 2.0 s of A
        self.assertTrue(self.manager.begin_track(b, 3.0, "B", index=1, started_at=0.0))
        self.write_frames(30)                       # 3.0 s of B
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertEqual(self.manager.state, STATE_IDLE)
        self.assertEqual(self.manager.last_output, self.manager.final_path)
        self.assertTrue(os.path.exists(self.manager.final_path))

        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual([c["start"] for c in chapters], [0.0, 2.0])
        self.assertEqual([c["end"] for c in chapters], [2.0, 5.0])
        self.assertEqual([c["title"] for c in chapters], ["A", "B"])

        self.assertEqual(mux_audio_inputs(self.runs.calls[0]), [a, b])
        self.assertIn("concat=n=2", " ".join(self.runs.calls[0]))
        self.assertEqual(procs.bytes_written, 50 * FRAME_BYTES)

    def test_audio_order_for_three_tracks(self):
        self.start()
        a, b, c = self.audio_files()
        self.manager.begin_track(a, 1.0, "A", index=0)
        self.write_frames(10)
        self.manager.begin_track(b, 2.0, "B", index=1)
        self.write_frames(20)
        self.manager.begin_track(c, 3.0, "C", index=2)
        self.write_frames(30)
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertEqual(mux_audio_inputs(self.runs.calls[0]), [a, b, c])
        cmd = self.runs.calls[0]
        fc = cmd[cmd.index("-filter_complex") + 1]
        self.assertEqual(fc.count("-i"), 0)
        self.assertIn("[1:a:0]", fc)
        self.assertIn("[2:a:0]", fc)
        self.assertIn("[3:a:0]", fc)
        self.assertIn("concat=n=3", fc)
        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual([c["start"] for c in chapters], [0.0, 1.0, 3.0])
        self.assertEqual([c["end"] for c in chapters], [1.0, 3.0, 6.0])

    def test_mux_maps_video_audio_and_chapter_metadata(self):
        self.start()
        a, b = self.audio_files()[:2]
        self.manager.begin_track(a, 1.0, "A", index=0)
        self.write_frames(10)
        self.manager.begin_track(b, 1.0, "B", index=1)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()

        cmd = self.runs.calls[0]
        maps = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-map"]
        self.assertEqual(maps, ["0:v:0", "[aout]"])          # video from recorder, audio from concat
        meta_index = str(1 + 2)                              # video + 2 audio inputs
        self.assertEqual(cmd[cmd.index("-map_metadata") + 1], meta_index)
        self.assertEqual(cmd[cmd.index("-map_chapters") + 1], meta_index)
        self.assertIn("-shortest", cmd)
        self.assertEqual(cmd[-1], self.manager.final_path)
        self.assertEqual(cmd[cmd.index("-i") + 1], self.manager.temp_video)

    # ------------------------------------------------------ duplicate guard
    def test_same_track_is_registered_only_once(self):
        self.start()
        a = self.audio_files()[0]
        self.assertTrue(self.manager.begin_track(a, 2.0, "A", index=0, started_at=0.05))
        # pause/resume: no new serial, and a repeated begin is rejected
        self.assertFalse(self.manager.begin_track(a, 2.0, "A", index=0, started_at=0.0))
        # "repeat current track" after a few seconds is not a fresh 0:00 start
        self.assertFalse(self.manager.begin_track(a, 2.0, "A", index=0, started_at=4.0))
        self.assertEqual(len(self.manager.chapters), 1)
        self.assertEqual(self.manager.chapters[0]["start"], 0.0)
        self.assertEqual(len(self.manager.tracks), 1)

    def test_begin_track_ignored_while_not_recording(self):
        a = self.audio_files()[0]
        self.assertFalse(self.manager.begin_track(a, 2.0, "A", index=0))
        self.assertEqual(self.manager.chapters, [])

    # --------------------------------------------------------- early / natural
    def test_early_stop_ends_video_at_stop_position(self):
        proc = self.start()
        a = self.audio_files()[0]
        self.manager.begin_track(a, 5.0, "A", index=0)
        self.write_frames(12)                       # stopped after 1.2 s of 5 s
        self.manager.stop()                         # not a natural end
        self.wait_final()

        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0]["start"], 0.0)
        self.assertEqual(chapters[0]["end"], 1.2)   # NOT the full 5 s
        self.assertEqual(proc.bytes_written, 12 * FRAME_BYTES)

    def test_natural_end_tops_up_to_last_song_end(self):
        proc = self.start()
        a = self.audio_files()[0]
        self.manager.begin_track(a, 2.0, "A", index=0)
        self.write_frames(15)                       # render lagged behind
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertEqual(proc.bytes_written, 20 * FRAME_BYTES)   # 2.0 s * 10 fps
        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual(chapters[0]["end"], 2.0)

    def test_track_switch_pads_previous_song_to_its_audio_end(self):
        proc = self.start()
        a, b = self.audio_files()[:2]
        self.manager.begin_track(a, 2.0, "A", index=0)
        self.write_frames(15)                        # renderer lagged: 1.5 s of 2.0 s
        self.manager.begin_track(b, 1.0, "B", index=1)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()

        # A padded to its own end, then B's 10 frames -> chapter boundary == video
        self.assertEqual(proc.bytes_written, (20 + 10) * FRAME_BYTES)
        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual([(c["start"], c["end"]) for c in chapters],
                         [(0.0, 2.0), (2.0, 3.0)])

    def test_track_registered_without_any_frame_is_not_a_chapter(self):
        self.start()
        a, b = self.audio_files()[:2]
        self.manager.begin_track(a, 2.0, "A", index=0)
        # switch immediately, before a single frame of A was written
        self.assertTrue(self.manager.begin_track(b, 2.0, "B", index=1))
        self.write_frames(15)                       # 1.5 s of B
        self.manager.stop()
        self.wait_final()

        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual([c["title"] for c in chapters], ["B"])
        self.assertEqual(chapters[0]["start"], 0.0)
        self.assertEqual(mux_audio_inputs(self.runs.calls[0]), [b])

    def test_track_started_at_end_of_video_is_dropped(self):
        self.start()
        a, b = self.audio_files()[:2]
        self.manager.begin_track(a, 5.0, "A", index=0)
        self.write_frames(5)                        # 0.5 s recorded, A is 5 s
        self.manager.begin_track(b, 2.0, "B", index=1)  # would start at 5.0 s
        self.manager.stop()                         # video ends at 0.5 s
        self.wait_final()

        chapters = parse_chapters(self.runs.meta_text)
        self.assertEqual([c["title"] for c in chapters], ["A"])
        self.assertEqual(len(mux_audio_inputs(self.runs.calls[0])), 1)
        self.assertEqual(mux_audio_inputs(self.runs.calls[0]), [a])

    # ------------------------------------------------------------ finalizing
    def test_start_refused_while_finalizing_and_files_untouched(self):
        self.start()
        a = self.audio_files()[0]
        self.manager.begin_track(a, 1.0, "A", index=0)
        self.write_frames(10)

        self.runs.gate = threading.Event()
        self.manager.stop()
        self.assertEqual(self.manager.state, STATE_FINALIZING)
        # wait until the finalizer reached the mux (metadata already written)
        self.assertTrue(self.runs.entered.wait(timeout=5))

        old_session = self.manager._session
        old_temp = old_session.temp_video
        self.assertTrue(os.path.exists(old_temp))
        files_before = sorted(os.listdir(self.out_dir))
        session_before = self.manager._session

        self.assertFalse(self.manager.start(W, H))
        self.assertEqual(self.manager.state, STATE_FINALIZING)
        self.assertTrue(self.manager.status)
        self.assertIn("fertiggestellt", self.manager.status)
        # the finalizer's temp files are untouched
        self.assertIs(self.manager._session, session_before)
        self.assertEqual(sorted(os.listdir(self.out_dir)), files_before)
        with open(old_temp, "rb") as f:
            self.assertEqual(f.read(), b"FAKE-VIDEO")

        self.runs.gate.set()
        self.wait_final()
        self.assertEqual(self.manager.state, STATE_IDLE)
        self.assertIs(self.manager._session, session_before)
        self.assertTrue(os.path.exists(self.manager.final_path))
        self.assertTrue(self.manager.status.startswith("Export fertig"))

    def test_can_start_new_export_after_finalize(self):
        self.start()
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()
        self.assertEqual(self.manager.state, STATE_IDLE)

        first_final = self.manager.final_path
        self.assertTrue(self.manager.start(W, H))
        self.manager.begin_track(self.audio_files()[1], 1.0, "B", index=0)
        self.write_frames(5)
        self.manager.stop()
        self.wait_final()

        self.assertTrue(os.path.exists(first_final))
        self.assertNotEqual(self.manager.final_path, first_final)
        self.assertTrue(os.path.exists(self.manager.final_path))

    def test_two_exports_in_same_second_get_distinct_files(self):
        self.start()
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()
        first_inputs = mux_audio_inputs(self.runs.calls[0])
        first_final = self.manager.final_path

        self.start()
        b = self.audio_files()[1]
        self.manager.begin_track(b, 1.0, "B", index=0)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertNotEqual(self.manager.final_path, first_final)
        self.assertTrue(os.path.exists(first_final))
        self.assertTrue(os.path.exists(self.manager.final_path))
        # second export used its own audio, not a reused temp file
        self.assertEqual(mux_audio_inputs(self.runs.calls[1]), [b])
        self.assertNotEqual(first_inputs, mux_audio_inputs(self.runs.calls[1]))

    # ----------------------------------------------------------- mux failure
    def test_mux_failure_keeps_temp_video_meta_and_log(self):
        self.start()
        a = self.audio_files()[0]
        self.manager.begin_track(a, 1.0, "A", index=0)
        self.write_frames(10)

        self.runs.returncode = 1
        self.runs.stderr = "Error: concat failed: boom"
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertEqual(self.manager.state, STATE_IDLE)
        self.assertIsNone(self.manager.last_output)
        self.assertIn("Merge fehlgeschlagen", self.manager.status)
        self.assertIn("boom", self.manager.status)
        self.assertIn("boom", self.manager.failure_reason)

        # diagnostics survive
        self.assertTrue(os.path.exists(self.manager.temp_video))
        self.assertTrue(os.path.exists(self.manager.meta_path))
        self.assertTrue(os.path.exists(self.manager.log_path))
        with open(self.manager.log_path, "r", encoding="utf-8") as f:
            log = f.read()
        self.assertIn("--- mux ---", log)
        self.assertIn("boom", log)
        # no half-written output left behind
        self.assertFalse(os.path.exists(self.manager.final_path))

    def test_success_deletes_temp_video_meta_and_log(self):
        self.start()
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(10)
        self.manager.stop(natural_end=True)
        self.wait_final()

        self.assertTrue(self.manager.status.startswith("Export fertig"))
        self.assertFalse(os.path.exists(self.manager.temp_video))
        self.assertFalse(os.path.exists(self.manager.meta_path))
        self.assertFalse(os.path.exists(self.manager.log_path))
        self.assertTrue(os.path.exists(self.manager.final_path))
        with open(self.manager.final_path, "rb") as f:
            self.assertEqual(f.read(), b"FAKE-FINAL-MP4")

    def test_nothing_recorded_cleans_up_without_mux(self):
        self.start()
        self.manager.stop()
        self.wait_final()

        self.assertEqual(self.runs.calls, [])
        self.assertIn("nichts aufgenommen", self.manager.status)
        self.assertFalse(os.path.exists(self.manager.temp_video))
        self.assertFalse(os.path.exists(self.manager.log_path))

    # ------------------------------------------------------ recorder failure
    def test_recorder_failure_keeps_video_and_log(self):
        proc = self.start()
        proc.fail_after = 0                         # encoder dies immediately
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(3)
        deadline = time.time() + 5
        while not self.manager._session.failed and time.time() < deadline:
            time.sleep(0.01)
        self.assertTrue(self.manager._session.failed)
        self.manager.stop()
        self.wait_final()

        self.assertEqual(self.runs.calls, [])
        self.assertIn("fehlgeschlagen", self.manager.status)
        self.assertTrue(os.path.exists(self.manager.temp_video))
        self.assertTrue(os.path.exists(self.manager.log_path))
        self.assertFalse(os.path.exists(self.manager.final_path))

    # ------------------------------------------------------------- resize
    def test_resize_stops_export_through_same_finalizer(self):
        self.start()
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(10)

        self.assertFalse(self.manager.stop_for_resize(W, H))   # same size -> keep going
        self.assertEqual(self.manager.state, STATE_RECORDING)
        self.assertTrue(self.manager.stop_for_resize(W + 10, H))  # changed -> stop
        self.assertEqual(self.manager.state, STATE_FINALIZING)
        self.assertIn("Fenstergröße", self.manager.status)
        self.wait_final()

        self.assertTrue(os.path.exists(self.manager.final_path))
        self.assertFalse(os.path.exists(self.manager.temp_video))
        self.assertFalse(os.path.exists(self.manager.log_path))

    def test_stop_is_idempotent(self):
        self.start()
        self.manager.begin_track(self.audio_files()[0], 1.0, "A", index=0)
        self.write_frames(10)
        self.assertTrue(self.manager.stop())
        self.assertFalse(self.manager.stop())       # already finalizing
        self.wait_final()
        self.assertEqual(len(self.runs.calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
