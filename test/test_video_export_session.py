import sys, os
sys.path.append( os.path.abspath(os.path.join(os.path.dirname(__file__), '..')) )

import glob
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QSize, QCoreApplication, QTimer, QEventLoop, QPointF
from PySide6.QtGui import QPolygonF

from lib import videorw


# Real ffmpeg is exposed under a bare "ffmpeg.exe" in this bin dir for the end-to-end case.
REAL_FFMPEG_DIR = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'testwork', 'realbin'
))
# Directory holding the compiled fake "ffmpeg.exe" shim (generated at runtime).
FAKE_FFMPEG_DIR = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'testwork', 'fakebin'
))
SAMPLE_VIDEO = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', '..', 'testwork', 'sample.mp4'
))
# Source templates for the fake shim; these live in the repo, compiled binaries do not.
FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
SHIM_SOURCE = os.path.join(FIXTURE_DIR, "shim.c")
FAKE_SCRIPT = os.path.join(FIXTURE_DIR, "fake_ffmpeg.py")
# QProcess resolves "ffmpeg" against PATH; the suffix matters only on Windows.
_SHIM_NAME = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
FAKE_FFMPEG = os.path.join(FAKE_FFMPEG_DIR, _SHIM_NAME)

# Set by _bootstrapFixtures(): whether the real-encoder success case can run.
REAL_FFMPEG_AVAILABLE = False


def _bootstrapFixtures() -> bool:
    '''
    Create the external (untrusted) fixtures on demand so the test stays standalone.
    The sample video comes from the real ffmpeg bundled with imageio_ffmpeg; the fake
    ffmpeg is a tiny C shim compiled from test/fixtures into testwork/fakebin.
    Returns whether the fake shim and sample input are usable.
    '''
    global REAL_FFMPEG_AVAILABLE
    import shutil
    import subprocess

    try:
        import imageio_ffmpeg
        realFfmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        realFfmpeg = None

    # Real ffmpeg exposed under a bare name for the end-to-end success case.
    if realFfmpeg is not None:
        os.makedirs(REAL_FFMPEG_DIR, exist_ok=True)
        bareExe = os.path.join(REAL_FFMPEG_DIR, _SHIM_NAME)
        if not os.path.exists(bareExe):
            try:
                os.link(realFfmpeg, bareExe)          # hard link avoids duplicating a large binary
            except OSError:
                shutil.copyfile(realFfmpeg, bareExe)
        if os.name != "nt":
            try:
                os.chmod(bareExe, 0o755)
            except OSError:
                pass
        REAL_FFMPEG_AVAILABLE = os.path.exists(bareExe)

    # Sample input video.
    if realFfmpeg is not None and not os.path.exists(SAMPLE_VIDEO):
        os.makedirs(os.path.dirname(SAMPLE_VIDEO), exist_ok=True)
        subprocess.run([
            realFfmpeg, "-y", "-v", "error", "-f", "lavfi",
            "-i", "testsrc=size=160x120:rate=15:duration=4",
            "-pix_fmt", "yuv420p", "-c:v", "libx264", SAMPLE_VIDEO,
        ], check=False)

    # Fake ffmpeg shim: copy the Python helper next to the binary and compile the C launcher.
    os.makedirs(FAKE_FFMPEG_DIR, exist_ok=True)
    shutil.copyfile(FAKE_SCRIPT, os.path.join(FAKE_FFMPEG_DIR, "fake_ffmpeg.py"))
    if not os.path.exists(FAKE_FFMPEG) and os.path.exists(SHIM_SOURCE):
        gcc = shutil.which("gcc") or shutil.which("cc") or shutil.which("clang")
        if gcc is not None:
            subprocess.run([gcc, "-O2", "-o", FAKE_FFMPEG, SHIM_SOURCE], check=False)

    return os.path.exists(FAKE_FFMPEG) and os.path.exists(SAMPLE_VIDEO)


FAKE_FFMPEG_AVAILABLE = _bootstrapFixtures()


def waitUntil(predicate, timeoutMs: int = 10000, intervalMs: int = 20) -> bool:
    '''Spin a nested event loop until predicate() is true or the timeout elapses.'''
    if predicate():
        return True
    timer = QTimer()
    timer.setInterval(intervalMs)
    loop = QEventLoop()
    state = {"ok": False}

    def tick():
        if predicate():
            state["ok"] = True
            loop.quit()

    timer.timeout.connect(tick)
    QTimer.singleShot(timeoutMs, loop.quit)
    timer.start()
    loop.exec()
    timer.stop()
    return state["ok"]


class SignalRecorder:
    '''Collects (args tuple) emissions of a session signal.'''
    def __init__(self):
        self.done: list[tuple] = []
        self.fail: list[tuple] = []
        self.progress: list[tuple] = []

    def attach(self, session: videorw.VideoExportSession):
        session.done.connect(lambda *a: self.done.append(a))
        session.fail.connect(lambda *a: self.fail.append(a))
        session.progress.connect(lambda *a: self.progress.append(a))


def makeSession(destFile: str, owner=None, numFrames: int = 12, srcPos: int = 0,
                speed: float = 1.0, poly: QPolygonF | None = None) -> videorw.VideoExportSession:
    return videorw.VideoExportSession(
        None, SAMPLE_VIDEO, QSize(160, 120), srcPos, 15.0,
        destFile, poly, QSize(64, 48), 0.0, numFrames, 15.0, speed, owner=owner
    )


def tempFiles(destFile: str) -> list[str]:
    '''All per-session temporary files that belong to a destination path.'''
    base, ext = os.path.splitext(destFile)
    return glob.glob(base + ".export-*" + ext)


@unittest.skipUnless(FAKE_FFMPEG_AVAILABLE,
                     "test fixtures (sample video / fake ffmpeg shim) could not be built")
class VideoExportSessionTest(unittest.TestCase):
    app: QCoreApplication = None

    @classmethod
    def setUpClass(cls):
        # One QCoreApplication for the whole module; QProcess needs an event loop.
        cls.app = QCoreApplication.instance() or QCoreApplication(sys.argv)
        # System PATH with neither test bin dir, so each test chooses fake vs real deterministically.
        cls._origPath = os.environ.get("PATH", "")
        base = [p for p in cls._origPath.split(os.pathsep) if p and p not in (FAKE_FFMPEG_DIR, REAL_FFMPEG_DIR)]
        cls._basePath = os.pathsep.join(base)

    @classmethod
    def tearDownClass(cls):
        os.environ["PATH"] = cls._origPath

    def setUp(self):
        os.environ["FFMPEG_FAKE_MODE"] = "success:0"
        os.environ["PATH"] = FAKE_FFMPEG_DIR + os.pathsep + self._basePath
        self.tmp = tempfile.TemporaryDirectory()
        self.workdir = self.tmp.name
        # Each test gets a fresh manager so registry state never leaks between cases.
        self.manager = videorw.VideoExportManager()

    def tearDown(self):
        self.manager.cancelAll()
        self.tmp.cleanup()
        os.environ.pop("FFMPEG_FAKE_MODE", None)
        os.environ["PATH"] = FAKE_FFMPEG_DIR + os.pathsep + self._basePath

    def useRealFfmpeg(self):
        '''Switch this test's PATH so the bare "ffmpeg" resolves to a real binary.'''
        os.environ["PATH"] = REAL_FFMPEG_DIR + os.pathsep + self._basePath

    def dest(self, name: str = "out.mp4") -> str:
        return os.path.join(self.workdir, name)

    def startSession(self, destFile: str | None = None, owner=None, **kwargs) -> videorw.VideoExportSession:
        destFile = destFile or self.dest()
        session = makeSession(destFile, owner=owner, **kwargs)
        rec = SignalRecorder()
        rec.attach(session)
        session._testRecorder = rec
        self.manager.startExport(session)
        return session

    # ------------------------------------------------------------------ success
    @unittest.skipUnless(REAL_FFMPEG_AVAILABLE, "real ffmpeg (imageio-ffmpeg) not available")
    def test_success_creates_destination_and_no_temp(self):
        self.useRealFfmpeg()
        dest = self.dest()
        self.assertFalse(os.path.exists(dest), "destination must not exist before export")

        session = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        rec = session._testRecorder

        self.assertEqual(len(rec.done), 1)
        self.assertEqual(len(rec.fail), 0)
        self.assertTrue(os.path.exists(dest), "destination must exist after success")
        self.assertGreater(os.path.getsize(dest), 0)
        self.assertEqual(tempFiles(dest), [], "temporary output must be gone after success")
        self.assertFalse(self.manager.isExporting(dest))
        self.assertEqual(rec.done[0][1], os.path.abspath(dest))

        # The produced file is a real, readable video with the requested frame count.
        w, h, fps, frameCount, duration = videorw.readMetadata(dest)
        self.assertEqual((w, h), (64, 48))
        self.assertEqual(frameCount, 12)

    def test_success_with_fake_ffmpeg_promotes_temp_to_dest(self):
        # Deterministic logic check independent of a real encoder: the fake copies the
        # input into the per-session temp file; the session must rename it onto dest.
        os.environ["FFMPEG_FAKE_MODE"] = "success:0.1"
        dest = self.dest()
        session = self.startSession(dest)

        # While running, only the temp file exists; dest must not appear before completion.
        self.assertTrue(waitUntil(lambda: bool(tempFiles(dest)) or session.finishedCleanup))
        if not session.finishedCleanup:
            self.assertFalse(os.path.exists(dest), "destination must not be written mid-export")

        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        self.assertEqual(len(session._testRecorder.done), 1)
        self.assertTrue(os.path.exists(dest))
        self.assertEqual(tempFiles(dest), [])

    # ------------------------------------------------------------------ cancel
    def test_cancel_removes_partial_and_keeps_destination_absent(self):
        # "hang" creates a partial temp file and blocks until terminated.
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        dest = self.dest()
        session = self.startSession(dest)

        self.assertTrue(waitUntil(lambda: bool(tempFiles(dest)), timeoutMs=5000))
        self.assertTrue(os.path.exists(session.tempFile), "partial temp output should exist while encoding")

        session.cancel()
        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        rec = session._testRecorder

        self.assertEqual(len(rec.fail), 1)
        self.assertEqual(len(rec.done), 0)
        self.assertFalse(os.path.exists(dest), "no file may be mistaken for a successful export")
        self.assertFalse(os.path.exists(session.tempFile), "partial temp output must be removed on cancel")
        self.assertEqual(tempFiles(dest), [])
        self.assertFalse(self.manager.isExporting(dest))

    def test_retry_after_cancel_succeeds(self):
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        dest = self.dest()
        first = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: bool(tempFiles(dest)), timeoutMs=5000))
        first.cancel()
        self.assertTrue(waitUntil(lambda: first.finishedCleanup))
        self.assertFalse(os.path.exists(dest))

        # Retry the same destination with a working ffmpeg: must produce a complete file.
        os.environ["FFMPEG_FAKE_MODE"] = "success:0"
        second = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: second.finishedCleanup))

        self.assertEqual(len(second._testRecorder.done), 1)
        self.assertEqual(len(second._testRecorder.fail), 0)
        self.assertTrue(os.path.exists(dest))
        self.assertEqual(tempFiles(dest), [])
        # The first session's late failure must not have deleted the new output.
        self.assertNotEqual(first.sessionId, second.sessionId)

    # ------------------------------------------------------- supersede / retry
    def test_second_export_reaps_first_and_ignores_its_signals(self):
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        dest = self.dest()
        first = self.startSession(dest, owner="ownerA")
        self.assertTrue(waitUntil(lambda: bool(tempFiles(dest)), timeoutMs=5000))
        firstTemp = first.tempFile

        # A second session for the same destination must retire the first synchronously.
        os.environ["FFMPEG_FAKE_MODE"] = "success:0"
        second = self.startSession(dest, owner="ownerA")

        self.assertTrue(first.finishedCleanup, "superseded session must be reaped before the new one starts")
        self.assertNotIn(firstTemp, tempFiles(dest), "old temp file must be cleaned up")
        self.assertIs(self.manager._sessions[os.path.abspath(dest)], second)

        self.assertTrue(waitUntil(lambda: second.finishedCleanup))
        self.assertEqual(len(second._testRecorder.done), 1)
        self.assertTrue(os.path.exists(dest))

        # Simulate a tool-side identity guard: the first session's fail signal carries the
        # old session object and must be rejected by the current owner's callback logic.
        self.assertEqual(len(first._testRecorder.fail), 1)
        staleSession = first._testRecorder.fail[0][1]
        self.assertIsNot(staleSession, second)
        self.assertTrue(second._testRecorder.done[0][2] is second)

    def test_late_signal_of_superseded_session_does_not_touch_new_output(self):
        os.environ["FFMPEG_FAKE_MODE"] = "success:0.3"
        dest = self.dest()
        first = self.startSession(dest)
        # Supersede before the first finishes; the manager reaps it (fail path).
        second = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: second.finishedCleanup))
        destMtime = os.path.getmtime(dest)
        destSize = os.path.getsize(dest)

        # Re-emit the stale session's terminal signal the way a queued slot would receive it;
        # the manager only deregisters when the session identity matches, so the new state survives.
        self.manager._onSessionFail("stale", first)
        self.assertIs(self.manager._sessions.get(os.path.abspath(dest)), None)
        # second already finished and deregistered itself; the file itself must be untouched.
        self.assertTrue(os.path.exists(dest))
        self.assertEqual(os.path.getsize(dest), destSize)
        self.assertEqual(os.path.getmtime(dest), destMtime)

    # ------------------------------------------------------------------ failure
    def test_nonzero_exit_leaves_no_destination_and_reopens_ui_path(self):
        os.environ["FFMPEG_FAKE_MODE"] = "fail:0"
        dest = self.dest()
        session = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        rec = session._testRecorder

        self.assertEqual(len(rec.fail), 1)
        self.assertEqual(len(rec.done), 0)
        self.assertIn("exit code", rec.fail[0][0])
        self.assertFalse(os.path.exists(dest))
        self.assertEqual(tempFiles(dest), [])
        self.assertFalse(self.manager.isExporting(dest), "UI must be allowed to export again")

        # A retry after failure succeeds.
        os.environ["FFMPEG_FAKE_MODE"] = "success:0"
        retry = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: retry.finishedCleanup))
        self.assertEqual(len(retry._testRecorder.done), 1)
        self.assertTrue(os.path.exists(dest))

    def test_missing_ffmpeg_reports_failed_to_start(self):
        # Empty PATH: "ffmpeg" cannot be resolved -> FailedToStart, no crash, no output.
        oldPath = os.environ["PATH"]
        os.environ["PATH"] = ""
        try:
            dest = self.dest()
            session = self.startSession(dest)
            self.assertTrue(waitUntil(lambda: session.finishedCleanup, timeoutMs=5000))
        finally:
            os.environ["PATH"] = oldPath

        rec = session._testRecorder
        self.assertEqual(len(rec.fail), 1)
        self.assertEqual(len(rec.done), 0)
        self.assertIn("ffmpeg", rec.fail[0][0].lower())
        self.assertFalse(os.path.exists(dest))
        self.assertFalse(self.manager.isExporting(dest))

    def test_failure_preserves_previously_completed_destination(self):
        # A failed re-export must not delete an earlier successful file at the same path:
        # every session writes its own temp and only renames it onto dest on success.
        os.environ["FFMPEG_FAKE_MODE"] = "success:0"
        dest = self.dest()
        first = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: first.finishedCleanup))
        self.assertTrue(os.path.exists(dest))
        goodSize = os.path.getsize(dest)

        os.environ["FFMPEG_FAKE_MODE"] = "fail:0"
        second = self.startSession(dest)
        self.assertTrue(waitUntil(lambda: second.finishedCleanup))
        # The failed attempt leaves its temp behind nowhere and the prior good dest stays intact.
        self.assertTrue(os.path.exists(dest), "failed retry must preserve the earlier successful file")
        self.assertEqual(os.path.getsize(dest), goodSize)
        self.assertEqual(tempFiles(dest), [])
        self.assertEqual(len(second._testRecorder.fail), 1)

    # ------------------------------------------------------------- serialisation
    def test_only_one_active_session_per_destination(self):
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        destA = self.dest("a.mp4")
        destB = self.dest("b.mp4")
        s1 = self.startSession(destA)
        s2 = self.startSession(destB)
        self.assertTrue(waitUntil(lambda: len(self.manager.activeDestFiles()) == 2, timeoutMs=5000))
        self.assertTrue(self.manager.isExporting(destA))
        self.assertTrue(self.manager.isExporting(destB))

        # Different destinations run concurrently; same destination serializes.
        s3 = self.startSession(destA)
        self.assertTrue(s1.finishedCleanup)
        self.assertIs(self.manager._sessions[os.path.abspath(destA)], s3)
        self.assertIs(self.manager._sessions[os.path.abspath(destB)], s2)
        self.manager.cancelAll()
        self.assertTrue(waitUntil(lambda: not self.manager.activeDestFiles()))

    def test_cancel_export_by_path_and_owner(self):
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        dest = self.dest()
        session = self.startSession(dest, owner="ownerX")
        self.assertTrue(waitUntil(lambda: bool(tempFiles(dest)), timeoutMs=5000))

        self.assertTrue(self.manager.cancelExport(dest))
        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        self.assertFalse(os.path.exists(dest))

        # Owner-based cancellation used on tab close.
        other = self.startSession(self.dest("other.mp4"), owner="ownerY")
        self.assertTrue(waitUntil(lambda: bool(tempFiles(other.destFile)), timeoutMs=5000))
        self.manager.cancelExportsOwnedBy("ownerY")
        self.assertTrue(waitUntil(lambda: other.finishedCleanup))
        self.assertFalse(os.path.exists(other.destFile))

    def test_reap_owned_sessions_is_synchronous_for_ui_teardown(self):
        # reapExportsOwnedBy (tab close path) must fully reap the process before returning,
        # even though the hanging ffmpeg never terminates on its own.
        os.environ["FFMPEG_FAKE_MODE"] = "hang:0"
        owner = object()
        session = self.startSession(self.dest(), owner=owner)
        self.assertTrue(waitUntil(lambda: bool(tempFiles(session.destFile)), timeoutMs=5000))

        self.manager.reapExportsOwnedBy(owner)
        self.assertTrue(session.finishedCleanup, "session must be finalized before the owner is destroyed")
        self.assertEqual(self.manager.activeDestFiles(), [])
        self.assertFalse(os.path.exists(session.destFile))
        self.assertFalse(os.path.exists(session.tempFile))

    # ------------------------------------------------------- parameter pass-through
    def test_filters_keep_crop_rotation_speed_frame_behavior(self):
        # Guard the ffmpeg filter/argument construction so crop, rotation, speed and
        # frame truncation keep their existing behavior.
        poly = QPolygonF([QPointF(10, 10), QPointF(50, 10), QPointF(50, 40), QPointF(10, 40)])
        filters = videorw.VideoExportSession._getVideoFilters(
            QSize(160, 120), poly, QSize(64, 48), 90.0, 2.0, 15.0, 30.0
        )
        joined = ",".join(filters)
        self.assertIn("rotate=", joined)
        self.assertIn("crop=", joined)
        self.assertIn("scale=64:48", joined)
        self.assertIn("fps=30", joined)

        # Speed changes prepend setpts and add an audio atempo chain.
        session = makeSession(self.dest(), speed=2.0, numFrames=30)
        args = session.arguments()
        self.assertIn("setpts=PTS/2.0", args[args.index("-vf") + 1])
        self.assertIn("-af", args)
        self.assertIn("atempo=2.0", args[args.index("-af") + 1])
        # Frame truncation: -frames:v with the requested count.
        self.assertIn("-frames:v", args)
        self.assertEqual(args[args.index("-frames:v") + 1], "30")
        # Output is the per-session temp file, never the destination directly.
        self.assertEqual(args[-1], session.tempFile)
        self.assertNotEqual(args[-1], os.path.abspath(self.dest()))

    def test_terminal_signal_emitted_at_most_once(self):
        os.environ["FFMPEG_FAKE_MODE"] = "fail:0"
        session = self.startSession()
        self.assertTrue(waitUntil(lambda: session.finishedCleanup))
        # Drive every terminal entry point again; the guard must swallow duplicates.
        session._finish("again")
        session._onProcessError(type("E", (), {"name": "Crashed"})())
        self.assertEqual(len(session._testRecorder.fail), 1)
        self.assertEqual(len(session._testRecorder.done), 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
