"""Test setup for the headless outcome convention.

The tests run changeling.core.run() in-process with small local files. Nothing here may
download a model or need a GPU, so the heavy pieces are replaced before changeling.core is
imported: tensorflow, the window toolkit, insightface, the NSFW predictor, the face analyser
and the frame processors. The fakes are controllable, so each test can pick its path
(a face or none, NSFW or not, output written or not).
"""
import json
import os
import shutil
import sys
import types

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)


def _module(name: str, **attributes) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


# tensorflow: only its config surface is touched (limit_resources), never a real GPU
_tensorflow = _module('tensorflow')
_tensorflow.config = types.SimpleNamespace(experimental=types.SimpleNamespace(
    list_physical_devices=lambda *args, **kwargs: [],
    set_virtual_device_configuration=lambda *args, **kwargs: None,
    VirtualDeviceConfiguration=lambda **kwargs: types.SimpleNamespace(**kwargs),
))

# the window toolkit: imported by changeling.ui, never opened in these tests
_customtkinter = _module('customtkinter')
_customtkinter.CTk = type('CTk', (), {})
_customtkinter.deactivate_automatic_dpi_awareness = lambda: None
_tkinterdnd2 = _module('tkinterdnd2')
_tkinterdnd2.TkinterDnD = types.SimpleNamespace(
    Tk=object,
    DnDWrapper=type('DnDWrapper', (), {}),
    _require=lambda self: None,
)
_tkinterdnd2.DND_ALL = object()

# insightface: changeling.typing imports insightface.app.common.Face
_insightface = _module('insightface')
_insightface_app = _module('insightface.app')
_insightface_app_common = _module('insightface.app.common')


class Face:
    """Stands in for insightface.app.common.Face (truthy, unlike an empty dict)."""


_insightface_app_common.Face = Face
_insightface_app.common = _insightface_app_common
_insightface_app.FaceAnalysis = object
_insightface.app = _insightface_app
_insightface.model_zoo = _module('insightface.model_zoo')

# the gallery: would write to the real home folder on success
_module('gallery', remember=lambda *args, **kwargs: None)

# the NSFW predictor: FLAGGED decides what the check says (the lambdas delegate, so
# changeling.core's from-import binding sees the change too)
predictor = _module('changeling.predictor')
predictor.FLAGGED = False
predictor.predict_image = lambda path: predictor.FLAGGED
predictor.predict_video = lambda path: predictor.FLAGGED
predictor.predict_frame = lambda frame: predictor.FLAGGED
predictor.clear_predictor = lambda: None

# the face analyser: HAS_FACE decides whether any face is found
face_analyser = _module('changeling.face_analyser')
face_analyser.HAS_FACE = True
face_analyser.get_one_face = lambda frame, position=0: Face() if face_analyser.HAS_FACE else None
face_analyser.get_many_faces = lambda frame: [Face()] if face_analyser.HAS_FACE else None
face_analyser.find_similar_face = lambda frame, reference_face: Face() if face_analyser.HAS_FACE else None
face_analyser.clear_face_analyser = lambda: None


def _processor_module(name: str, label: str) -> types.ModuleType:
    """A frame processor with the full interface; WRITE_OUTPUT decides whether its
    process_image actually produces the output file."""
    module = _module(name)
    module.NAME = label
    module.WRITE_OUTPUT = True
    module.pre_check = lambda: True
    module.pre_start = lambda: True
    module.process_frame = lambda *args, **kwargs: None
    module.process_frames = lambda *args, **kwargs: None

    def process_image(source_path, target_path, output_path):
        if module.WRITE_OUTPUT:
            # the real processors rewrite the output in place (cv2.imwrite)
            if not os.path.exists(output_path):
                shutil.copy2(target_path, output_path)
            os.utime(output_path, None)

    module.process_image = process_image
    module.process_video = lambda source_path, frame_paths: None
    module.post_process = lambda: None
    return module


face_swapper = _processor_module('changeling.processors.frame.face_swapper', 'CHANGELING.FACE-SWAPPER')
face_enhancer = _processor_module('changeling.processors.frame.face_enhancer', 'CHANGELING.FACE-ENHANCER')

import changeling.core as core  # noqa: E402  (after the stubs, on purpose)
from changeling import outcome  # noqa: E402


def write_image(path) -> None:
    """A small real image file, made locally."""
    import cv2
    import numpy
    cv2.imwrite(str(path), numpy.zeros((8, 8, 3), dtype=numpy.uint8))


class Job:
    def __init__(self, tmp_path, monkeypatch):
        self.tmp_path = tmp_path
        self.monkeypatch = monkeypatch

    def run(self, *argv) -> int:
        """One headless run; returns the process exit code."""
        self.monkeypatch.setattr(sys, 'argv', ['run.py'] + [str(arg) for arg in argv])
        with pytest.raises(SystemExit) as excinfo:
            core.run()
        return excinfo.value.code


@pytest.fixture()
def job(tmp_path, monkeypatch):
    """A clean, controllable job environment: fakes reset, no ffmpeg needed, temp dirs under tmp_path."""
    face_analyser.HAS_FACE = True
    face_swapper.WRITE_OUTPUT = True
    face_enhancer.WRITE_OUTPUT = True
    predictor.FLAGGED = False
    monkeypatch.setattr(core, 'pre_check', lambda: True)  # no ffmpeg in the test environment
    return Job(tmp_path, monkeypatch)


def parse_result(captured_out: str) -> dict:
    """The single structured result line, parsed; fails if there isn't exactly one."""
    lines = [line for line in captured_out.splitlines() if line.startswith(outcome.PREFIX + ' ')]
    assert len(lines) == 1, f'expected exactly one {outcome.PREFIX} line, got: {lines!r}'
    return json.loads(lines[0][len(outcome.PREFIX) + 1:])
