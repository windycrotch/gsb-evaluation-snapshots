import cv2
import numpy as np
import pytest

from citrus_inspection.config import Config
from citrus_inspection.model import Prediction
from citrus_inspection.runtime import resolve_source, run_live


class FixedScorer:
    threshold = 0.55

    def predict(self, images, masks):
        count = len(images)
        return Prediction(np.full(count, 0.2, np.float32), np.zeros((count, 32, 32), np.float32))


class FirstAnomalyScorer:
    threshold = 0.55

    def __init__(self):
        self.calls = 0

    def predict(self, images, masks):
        score = 0.9 if self.calls == 0 else 0.2
        self.calls += 1
        count = len(images)
        maps = np.zeros((count, *masks[0].shape), np.float32)
        return Prediction(np.full(count, score, np.float32), maps)


class ScriptedScorer:
    threshold = 0.55

    def __init__(self, prediction):
        self.prediction = prediction

    def predict(self, images, masks):
        return self.prediction


class FakeCapture:
    def __init__(self, frame):
        self.frame = frame
        self.released = False

    def isOpened(self):
        return True

    def get(self, prop):
        assert prop == cv2.CAP_PROP_FPS
        return 30

    def read(self):
        if self.frame is None:
            return False, None
        frame, self.frame = self.frame, None
        return True, frame

    def release(self):
        self.released = True


class SequenceCapture:
    def __init__(self, frames, failure="return", fail_after=None):
        self.frames = list(frames)
        self.failure = failure
        self.fail_after = len(self.frames) if fail_after is None else fail_after
        self.index = 0
        self.released = False

    def isOpened(self):
        return True

    def get(self, prop):
        assert prop == cv2.CAP_PROP_FPS
        return 30

    def read(self):
        if self.index >= self.fail_after:
            if self.failure == "raise":
                raise cv2.error("decoder lost the stream")
            return False, None
        frame = self.frames[self.index]
        self.index += 1
        return True, frame

    def release(self):
        self.released = True


class FailingCapture:
    def __init__(self, frames=(), failure="return"):
        self.frames = list(frames)
        self.failure = failure
        self.reads = 0
        self.released = False

    def isOpened(self):
        return True

    def get(self, prop):
        assert prop == cv2.CAP_PROP_FPS
        return 30

    def read(self):
        self.reads += 1
        if self.reads <= len(self.frames):
            return True, self.frames[self.reads - 1]
        if self.failure == "raise":
            raise cv2.error("camera device disappeared")
        return False, None

    def release(self):
        self.released = True


def _patch_gui(monkeypatch):
    monkeypatch.setattr("citrus_inspection.runtime.cv2.namedWindow", lambda *_: None)
    monkeypatch.setattr("citrus_inspection.runtime.cv2.imshow", lambda *_: None)
    monkeypatch.setattr("citrus_inspection.runtime.cv2.waitKey", lambda _: -1)
    monkeypatch.setattr("citrus_inspection.runtime.cv2.getWindowProperty", lambda *_: 1)
    monkeypatch.setattr("citrus_inspection.runtime.cv2.destroyWindow", lambda *_: None)


def _patch_capture(monkeypatch, capture):
    monkeypatch.setattr("citrus_inspection.runtime.cv2.VideoCapture", lambda _: capture)


def _blank_frame():
    return np.full((100, 160, 3), 40, np.uint8)


def _fruit_frame(x):
    frame = _blank_frame()
    frame[20:80, x : x + 70] = (35, 145, 235)
    return frame


def _config(lost_buffer=20):
    config = Config()
    config.detector.min_area = 100
    config.tracker.lost_buffer = lost_buffer
    config.inspection.crop_size = 32
    config.inspection.score_every = 1
    config.inspection.min_views = 1
    return config


def _write_video(path, frames, fps=10.0):
    height, width = frames[0].shape[:2]
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height))
    if not writer.isOpened():
        pytest.skip("MJPG video writer is unavailable in this environment")
    try:
        for frame in frames:
            writer.write(frame)
    finally:
        writer.release()
    capture = cv2.VideoCapture(str(path))
    decoded = 0
    try:
        while decoded < len(frames):
            ok, _ = capture.read()
            if not ok:
                break
            decoded += 1
    finally:
        capture.release()
    if decoded != len(frames):
        pytest.skip("the local OpenCV build cannot round-trip MJPG video")


def _assert_report_matches_summary(result):
    statuses = [item["status"] for item in result.report]
    assert result.summary["normal"] == statuses.count("normal")
    assert result.summary["anomalies"] == statuses.count("anomaly")
    assert result.summary["in_review"] == statuses.count("review")
    assert result.summary["inspected"] == statuses.count("normal") + statuses.count("anomaly")
    assert [item["item"] for item in result.report] == sorted(item["item"] for item in result.report)


def test_resolve_source_accepts_camera_index():
    assert resolve_source(" 2 ") == (2, True)


def test_resolve_source_rejects_missing_video(tmp_path):
    with pytest.raises(FileNotFoundError):
        resolve_source(str(tmp_path / "missing.mp4"))


def test_live_runtime_releases_video_source(tmp_path, monkeypatch):
    path = tmp_path / "input.mp4"
    path.touch()
    frame = np.full((100, 120, 3), 40, np.uint8)
    frame[20:80, 30:90] = (35, 145, 235)
    capture = FakeCapture(frame)

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    config = Config()
    config.detector.min_area = 100
    config.inspection.crop_size = 32
    config.inspection.min_views = 1
    result = run_live(config, FixedScorer(), str(path))

    assert result.frames == 1
    assert result.summary["normal"] == 1
    assert capture.released


def test_run_result_reports_each_item_in_display_order(tmp_path, monkeypatch):
    path = tmp_path / "line.mp4"
    path.touch()
    frames = [_fruit_frame(30), _fruit_frame(30), _fruit_frame(30)]
    frames += [_blank_frame() for _ in range(3)]
    frames += [_fruit_frame(90), _fruit_frame(90), _fruit_frame(90)]
    capture = SequenceCapture(frames)

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    result = run_live(_config(lost_buffer=0), FirstAnomalyScorer(), str(path))

    assert result.frames == len(frames)
    assert not result.stopped_by_user
    assert result.summary == {"inspected": 2, "normal": 1, "anomalies": 1, "in_review": 0}
    assert [item["item"] for item in result.report] == [1, 2]
    assert [item["status"] for item in result.report] == ["anomaly", "normal"]
    assert [item["views"] for item in result.report] == [3, 3]
    assert set(result.report[0]) == {
        "item",
        "track_id",
        "status",
        "score",
        "views",
        "first_seen_s",
        "last_seen_s",
    }
    assert result.as_dict()["report"] == result.report
    assert {key: result.as_dict()[key] for key in result.summary} == result.summary
    assert capture.released


@pytest.mark.parametrize("failure", ["return", "raise"])
def test_video_ending_early_returns_partial_result(tmp_path, monkeypatch, failure):
    path = tmp_path / "cut.mp4"
    path.touch()
    capture = SequenceCapture([_fruit_frame(30), _fruit_frame(30)], failure=failure)

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    result = run_live(_config(), FixedScorer(), str(path))

    assert result.frames == 2
    assert result.summary["inspected"] == 1
    assert result.summary["normal"] == 1
    assert len(result.report) == 1
    assert result.report[0]["item"] == 1
    assert result.as_dict()["report"] == result.report
    assert capture.released


def test_live_runtime_rejects_video_without_frames(tmp_path, monkeypatch):
    path = tmp_path / "empty.mp4"
    path.touch()
    capture = FakeCapture(None)

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    with pytest.raises(RuntimeError, match="no frames"):
        run_live(Config(), FixedScorer(), str(path))

    assert capture.released


def test_video_error_before_first_frame_reports_no_frames(tmp_path, monkeypatch):
    path = tmp_path / "broken.mp4"
    path.touch()
    capture = SequenceCapture([], failure="raise")

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    with pytest.raises(RuntimeError, match="no frames"):
        run_live(Config(), FixedScorer(), str(path))

    assert capture.released


def test_real_video_run_report_matches_dashboard_totals(tmp_path, monkeypatch):
    path = tmp_path / "line.avi"
    frames = [_fruit_frame(30) for _ in range(4)]
    frames += [_blank_frame(), _blank_frame()]
    frames += [_fruit_frame(90) for _ in range(4)]
    _write_video(path, frames)

    _patch_gui(monkeypatch)

    result = run_live(_config(lost_buffer=0), FixedScorer(), str(path))

    assert result.frames == len(frames)
    assert result.stopped_by_user is False
    assert [item["item"] for item in result.report] == [1, 2]
    assert all(item["status"] == "normal" for item in result.report)
    assert all(item["views"] == 4 for item in result.report)
    _assert_report_matches_summary(result)
    assert result.as_dict()["report"] == result.report


def test_real_truncated_video_finishes_with_partial_result(tmp_path, monkeypatch):
    path = tmp_path / "full.avi"
    frames = [_fruit_frame(30) for _ in range(10)]
    _write_video(path, frames)
    data = path.read_bytes()
    cut = tmp_path / "truncated.avi"
    cut.write_bytes(data[: int(len(data) * 0.9)])

    _patch_gui(monkeypatch)

    try:
        result = run_live(_config(), FixedScorer(), str(cut))
    except RuntimeError as exc:
        if "could not open video source" in str(exc) or "no frames" in str(exc):
            pytest.skip(f"the local decoder cannot partially open the truncated file: {exc}")
        raise

    assert result.frames > 0, "truncated source should still yield the frames it decoded"
    assert result.frames <= len(frames)
    assert result.report
    _assert_report_matches_summary(result)


@pytest.mark.parametrize("failure", ["return", "raise"])
def test_camera_still_aborts_after_three_failed_reads(monkeypatch, failure):
    capture = FailingCapture([_fruit_frame(30)], failure=failure)

    _patch_capture(monkeypatch, capture)
    _patch_gui(monkeypatch)

    with pytest.raises(RuntimeError, match="camera stopped returning frames"):
        run_live(_config(), FixedScorer(), "0")

    assert capture.released


def test_model_scores_outside_unit_interval_abort_the_run(tmp_path, monkeypatch):
    path = tmp_path / "input.mp4"
    path.touch()
    bad = Prediction(np.array([1.4], np.float32), np.zeros((1, 32, 32), np.float32))

    _patch_capture(monkeypatch, SequenceCapture([_fruit_frame(30)]))
    _patch_gui(monkeypatch)

    with pytest.raises((RuntimeError, ValueError), match=r"\[0, 1\]"):
        run_live(_config(), ScriptedScorer(bad), str(path))


def test_model_non_finite_scores_abort_the_run(tmp_path, monkeypatch):
    path = tmp_path / "input.mp4"
    path.touch()
    bad = Prediction(np.array([np.nan], np.float32), np.zeros((1, 32, 32), np.float32))

    _patch_capture(monkeypatch, SequenceCapture([_fruit_frame(30)]))
    _patch_gui(monkeypatch)

    with pytest.raises((RuntimeError, ValueError), match="non-finite"):
        run_live(_config(), ScriptedScorer(bad), str(path))


def test_model_batch_shape_mismatch_aborts_the_run(tmp_path, monkeypatch):
    path = tmp_path / "input.mp4"
    path.touch()
    bad = Prediction(np.array([0.2, 0.2], np.float32), np.zeros((2, 32, 32), np.float32))

    _patch_capture(monkeypatch, SequenceCapture([_fruit_frame(30)]))
    _patch_gui(monkeypatch)

    with pytest.raises((RuntimeError, ValueError), match="scores must have shape"):
        run_live(_config(), ScriptedScorer(bad), str(path))
