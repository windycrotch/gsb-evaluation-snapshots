"""Layer export (docs/decisions.md ADR-30/ADR-35): beside the burned programme, every element drawn alone on a transparent canvas by the
same ffmpeg-skill call with --keep-alpha, one file per element and a manifest, committed as one result. Unit tests for the request
option, the argv, the checkout detection, the refusals, the staging/commit lifecycle and the workspace lock; integration tests render
a document with layers and composite them over the clean video with ffmpeg-skill/overlay, which must give the burned programme back
within the stated PSNR."""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from motion_graphics import adapter
from motion_graphics.adapter import FfmpegSkill
from motion_graphics.canonical import sha256_file
from motion_graphics.contract import skill_contract
from motion_graphics.doctor import capability_status
from motion_graphics.errors import MotionGraphicsError
from motion_graphics.executor import CANVAS_ALPHA_CODEC, Executor
from motion_graphics.layerexport import (LAYER_EXPORT_FLAGS, LAYERS_MANIFEST_SCHEMA, alpha_step, layer_file_name, manifest_document,
                                         parse_layer_export, retag_for)
from motion_graphics.layerstage import BACKUP_PREFIX, LAYER_LOCK_NAME, STAGING_PREFIX, LayerStaging, WorkspaceLock, sweep
from motion_graphics.model import parse_request
from motion_graphics.security import PathPolicy

from conftest import image_overlay_element, request_doc, shape_element, text_overlay_element, title_element
from test_integration import _executor, _skill_info

# The stated tolerance (ADR-30): the layers laid over the clean video with ffmpeg-skill/overlay give the burned programme back with an
# average PSNR of at least this over the whole programme. Both pictures are separate H.264 encodes of the same frames; the residue is the
# 4:2:0 conversion of each layer's anti-aliased edges at composite time, which the burn does in one pass.
MIN_PSNR_DB = 30.0


def lower_third_element(element_id="lt1", start=0.5, end=3.5, name="Ada Lovelace", **extra):
    return {"id": element_id, "type": "lower_third", "start": start, "end": end, "parameters": {"name": name, **extra}}


def _options(**layer_export):
    return {"layer_export": dict({"directory": "layers"}, **layer_export)}


# ---- the request option
def test_defaults_and_fields():
    doc = parse_request(request_doc([title_element()], options=_options()))
    assert doc.options["layer_export"] == {"directory": "layers", "alpha_codec": "prores4444", "alpha_mode": "straight", "overwrite": False}
    doc = parse_request(request_doc([title_element()], options=_options(alpha_codec="qtrle", alpha_mode="premultiplied", overwrite=True)))
    assert doc.options["layer_export"]["alpha_codec"] == "qtrle" and doc.options["layer_export"]["alpha_mode"] == "premultiplied"
    assert doc.options["layer_export"]["overwrite"] is True
    assert parse_request(request_doc([title_element()])).options["layer_export"] is None


def test_the_layer_overwrite_switch_is_its_own_and_must_be_a_boolean():
    # document.output.overwrite replaces the programme; it says nothing about the layers, whose overwrite defaults to false
    doc = parse_request(request_doc([title_element()], overwrite=True, options=_options()))
    assert doc.options["layer_export"]["overwrite"] is False
    for bad in ("yes", 1, None):
        with pytest.raises(MotionGraphicsError) as e:
            parse_request(request_doc([title_element()], options=_options(overwrite=bad)))
        assert e.value.details["field"] == "document.options.layer_export.overwrite"


@pytest.mark.parametrize("value, field", [
    ({"directory": "layers", "alpha_codec": "h264"}, "alpha_codec"),
    ({"directory": "layers", "alpha_mode": "linear"}, "alpha_mode"),
    ({"directory": ""}, "directory"),
    ({"alpha_codec": "qtrle"}, "directory"),
    ({"directory": 3}, "directory"),
])
def test_bad_values_are_refused(value, field):
    with pytest.raises(MotionGraphicsError) as e:
        parse_request(request_doc([title_element()], options={"layer_export": value}))
    assert e.value.code == "INVALID_REQUEST" and e.value.details["field"].endswith(field)


def test_unknown_field_and_non_object_are_refused():
    for value in ({"directory": "layers", "codec": "qtrle"}, "layers", ["layers"]):
        with pytest.raises(MotionGraphicsError) as e:
            parse_request(request_doc([title_element()], options={"layer_export": value}))
        assert e.value.code == "INVALID_REQUEST"


def test_ids_differing_only_in_case_are_refused_for_a_layer_export():
    els = [title_element("Intro"), title_element("intro", start=2.0, end=3.0)]
    parse_request(request_doc(els))  # fine without a layer export
    with pytest.raises(MotionGraphicsError) as e:
        parse_request(request_doc(els, options=_options()))
    assert e.value.details["reason"] == "layer_name_collision" and e.value.details["ids"] == ["Intro", "intro"]
    with pytest.raises(MotionGraphicsError):
        parse_layer_export({"directory": "x"}, ["A.b", "a.B"])


def test_file_names_follow_the_codec_container():
    assert layer_file_name("t1", "prores4444") == "t1.mov" and layer_file_name("t1", "qtrle") == "t1.mov"
    assert layer_file_name("t1", "png") == "t1.mov" and layer_file_name("t1", "vp9") == "t1.webm"


# ---- the argv
def _argv(element, alpha=("prores4444", "straight"), audio_stream=1, platform=None):
    doc = parse_request(request_doc([element]))
    asset = {"path": "/abs/logo.png"} if element["type"] in ("image_overlay", "shape") else None
    return Executor(PathPolicy("."), skill=None)._argv(doc.elements[0], "/abs/canvas.mov", "/abs/layers/x.mov", asset, None, 18, "medium",
                                                       audio_stream, platform, alpha=alpha)


def _without(argv, flags):
    """argv with the given flags removed, each with its number of values."""
    out, i = [], 0
    while i < len(argv):
        if argv[i] in flags:
            i += 1 + flags[argv[i]]
            continue
        out.append(argv[i])
        i += 1
    return out


@pytest.mark.parametrize("element", [title_element(), lower_third_element(), text_overlay_element(), image_overlay_element()])
def test_a_layer_is_the_same_call_with_the_alpha_flags(element):
    tool, argv, _ = _argv(element, platform="youtube")
    _, burned, _ = _argv(element, alpha=None, platform="youtube")
    assert argv[argv.index("--alpha-codec") + 1] == "prores4444" and argv[argv.index("--alpha-mode") + 1] == "straight" and "--keep-alpha" in argv
    # no x264 settings and no audio track choice (the canvas has no audio); everything else is the burn's argv
    for flag in ("--crf", "--quality", "--preset", "--audio-stream"):
        assert flag not in argv
    assert "--audio-stream" in burned and "--preset" in burned
    assert _without(argv, {"--keep-alpha": 0, "--alpha-codec": 1, "--alpha-mode": 1}) == _without(burned, {"--crf": 1, "--preset": 1, "--audio-stream": 1})
    assert argv[0] == "/abs/canvas.mov" and argv[argv.index("-o") + 1] == "/abs/layers/x.mov"


def test_alpha_mode_and_codec_are_passed_through():
    _, argv, _ = _argv(text_overlay_element(), alpha=("qtrle", "premultiplied"))
    assert argv[argv.index("--alpha-codec") + 1] == "qtrle" and argv[argv.index("--alpha-mode") + 1] == "premultiplied"


# ---- the checkout
def _tools(**extra):
    tools = {t: {"input_schema": {"properties": {f: {} for f in fl + ("quality",)}}} for t, fl in adapter.REQUIRED_FLAGS.items()}
    tools["background"] = {"input_schema": {"properties": {f: {} for f in adapter.GENERATOR_TOOLS["background"]}}}
    for tool, props in extra.items():
        tools.setdefault(tool, {"input_schema": {"properties": {}}})["input_schema"]["properties"].update(props)
    return tools


def test_check_tools_detects_the_alpha_flags():
    feature = adapter.check_tools(_tools())[1]["layer_export"]
    assert feature["supported"] is False and "background.transparent" in feature["missing"] and "graphics.keep_alpha" in feature["missing"]
    assert "color.retag" in feature["missing"]
    codecs = {"enum": ["png", "prores4444", "qtrle", "vp9"]}
    full = {tool: {f: (codecs if f == "alpha_codec" else {}) for f in flags} for tool, flags in LAYER_EXPORT_FLAGS.items()}
    feature = adapter.check_tools(_tools(**full))[1]["layer_export"]
    assert feature == {"supported": True, "missing": [], "alpha_codecs": ["png", "prores4444", "qtrle", "vp9"]}
    # a tool offering fewer codecs narrows the list; a tool missing one flag makes the feature unsupported
    full["overlay"]["alpha_codec"] = {"enum": ["prores4444", "qtrle"]}
    assert adapter.check_tools(_tools(**full))[1]["layer_export"]["alpha_codecs"] == ["prores4444", "qtrle"]
    del full["graphics"]["keep_alpha"]
    assert adapter.check_tools(_tools(**full))[1]["layer_export"] == {"supported": False, "missing": ["graphics.keep_alpha"], "alpha_codecs": None}


def test_alpha_codec_choices_are_read_from_help():
    props = adapter.flags_from_help("usage: graphics.py [--keep-alpha] [--alpha-codec {png,prores4444,qtrle,vp9}]\n")
    assert props["keep_alpha"] == {} and props["alpha_codec"] == {"enum": ["png", "prores4444", "qtrle", "vp9"]}


def _info(supported=True, codecs=("png", "prores4444", "qtrle", "vp9")):
    feature = {"supported": supported, "missing": [] if supported else ["background.transparent", "graphics.keep_alpha"],
               "alpha_codecs": list(codecs) if supported else None}
    return SimpleNamespace(directory="/x", version="3.2.2", template_support=lambda t: True, tool_support=lambda t: True, takes_place=lambda: True,
                           takes_overwrite=lambda tool: True, takes_platform=lambda tool: True, takes_flag=lambda tool, flag: True,
                           layer_export=lambda: dict(feature), supported=True)


def test_an_old_checkout_refuses_a_layer_export_before_rendering():
    ex = Executor(PathPolicy("."), skill=SimpleNamespace(info=lambda: _info(False)))
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_checkout(parse_request(request_doc([title_element()], options=_options())))
    assert e.value.code == "TOOL_ERROR" and e.value.details["reason"] == "ffmpeg_skill_lacks_flag" and e.value.retryable is False
    assert e.value.details["flags"] == ["background.transparent", "graphics.keep_alpha"]
    assert "ffmpeg-skill/background --transparent" in e.value.message and "ffmpeg-skill/graphics --keep-alpha" in e.value.message
    ex._check_checkout(parse_request(request_doc([title_element()])))  # without the option nothing changes


def test_a_codec_the_checkout_does_not_offer_is_refused():
    ex = Executor(PathPolicy("."), skill=SimpleNamespace(info=lambda: _info(codecs=("prores4444", "qtrle"))))
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_checkout(parse_request(request_doc([title_element()], options=_options(alpha_codec="vp9"))))
    assert e.value.details["reason"] == "ffmpeg_skill_lacks_alpha_codec" and e.value.details["alpha_codec"] == "vp9"
    ex._check_checkout(parse_request(request_doc([title_element()], options=_options(alpha_codec="qtrle"))))
    # the canvas is always drawn in CANVAS_ALPHA_CODEC, so a checkout without it is refused whatever the layers' codec
    ex = Executor(PathPolicy("."), skill=SimpleNamespace(info=lambda: _info(codecs=("qtrle",))))
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_checkout(parse_request(request_doc([title_element()], options=_options(alpha_codec="qtrle"))))
    assert e.value.details["alpha_codec"] == CANVAS_ALPHA_CODEC


def test_doctor_reports_the_feature():
    assert capability_status(_info(True), {"_unavailable": True})["ffmpeg-skill-feature:layer_export"] == "supported"
    assert capability_status(_info(False), {"_unavailable": True})["ffmpeg-skill-feature:layer_export"] == "unsupported"
    assert capability_status(None, {})["ffmpeg-skill-feature:layer_export"] == "unsupported"


# ---- where the files go, the overwrite switch and the staging lifecycle
def test_a_complete_result_is_replaced_only_with_the_layer_overwrite_switch(tmp_path):
    (tmp_path / "layers").mkdir()
    (tmp_path / "layers" / "t1.mov").write_bytes(b"x")
    ex = Executor(PathPolicy(str(tmp_path)), skill=None)
    doc = parse_request(request_doc([title_element()], options=_options()))
    paths = ex._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_layer_overwrite(paths)
    assert e.value.code == "OUTPUT_ERROR" and e.value.details["reason"] == "exists" and e.value.retryable is False
    assert e.value.details["files"] == ["t1.mov"]
    # document.output.overwrite is the programme's consent, not the layers': the switch is options.layer_export.overwrite
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_layer_overwrite(ex._layer_paths(parse_request(request_doc([title_element()], overwrite=True, options=_options())),
                                                  tmp_path / "video.mp4", tmp_path / "out.mp4"))
    assert e.value.details["reason"] == "exists"
    overwrite = parse_request(request_doc([title_element()], options=_options(overwrite=True)))
    paths = ex._layer_paths(overwrite, tmp_path / "video.mp4", tmp_path / "out.mp4")
    ex._check_layer_overwrite(paths)  # consented: no refusal
    assert paths["files"]["t1"] == (tmp_path / "layers" / "t1.mov").resolve() and paths["manifest"].name == "manifest.json"
    # an empty (or missing) directory is not a result: nothing to refuse
    ex._layer_paths(parse_request(request_doc([title_element()], options=_options(directory="fresh"))),
                    tmp_path / "video.mp4", tmp_path / "out.mp4")
    (tmp_path / "fresh").mkdir()
    ex._check_layer_overwrite(ex._layer_paths(parse_request(request_doc([title_element()], options=_options(directory="fresh"))),
                                              tmp_path / "video.mp4", tmp_path / "out.mp4"))


def test_a_manifest_alone_is_a_complete_result_too(tmp_path):
    """A manifest without its files (an older, partial state) is still 'exists': the switch off refuses rather than mixing runs."""
    (tmp_path / "layers").mkdir()
    (tmp_path / "layers" / "manifest.json").write_text("{}", encoding="utf-8")
    ex = Executor(PathPolicy(str(tmp_path)), skill=None)
    paths = ex._layer_paths(parse_request(request_doc([title_element()], options=_options())), tmp_path / "video.mp4", tmp_path / "out.mp4")
    with pytest.raises(MotionGraphicsError) as e:
        ex._check_layer_overwrite(paths)
    assert e.value.details["reason"] == "exists" and e.value.details["files"] == ["manifest.json"]


def test_a_layer_file_may_not_be_the_programme_or_leave_the_workspace(tmp_path):
    ex = Executor(PathPolicy(str(tmp_path)), skill=None)
    doc = parse_request(request_doc([title_element()], output="layers/t1.mov", options=_options()))
    with pytest.raises(MotionGraphicsError) as e:
        ex._layer_paths(doc, tmp_path / "video.mp4", (tmp_path / "layers" / "t1.mov").resolve())
    assert e.value.details["reason"] == "layer_is_output"
    with pytest.raises(MotionGraphicsError) as e:
        ex._layer_paths(parse_request(request_doc([title_element()], options={"layer_export": {"directory": "../elsewhere"}})),
                        tmp_path / "video.mp4", tmp_path / "out.mp4")
    assert e.value.code == "PATH_NOT_ALLOWED"


class _LayerSkill:
    """A fake checkout: the canvas, one layer call per element (writing a small real-looking file), probes of both. `fail_on`
    makes that element's call raise, after the elements before it were drawn (its completion order never decides the result)."""

    def __init__(self, root: Path, fail_on=None, layer_bytes=None):
        self.root = Path(root)
        self.fail_on = fail_on
        self.layer_bytes = layer_bytes or {}
        self.calls = []

    def info(self):
        return SimpleNamespace(directory="/x", version="9.9.9", template_support=lambda t: True, tool_support=lambda t: True, takes_place=lambda: True,
                               takes_overwrite=lambda tool: True, takes_platform=lambda tool: True, takes_flag=lambda tool, flag: True,
                               quality_flag=lambda tool: "--crf", layer_export=lambda: {"supported": True, "missing": [],
                                                                                         "alpha_codecs": ["png", "prores4444", "qtrle", "vp9"]},
                               supported=True, features={"generator_flags": {"background": {"overwrite": True}}})

    def probe(self, path, timeout=None):
        return {"duration": 6.0, "video": {"width": 320, "height": 180, "fps": 25.0}}

    def _write(self, path: str, data: bytes) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def run_tool(self, tool, argv, timeout=None, cwd=None):
        out = argv[argv.index("-o") + 1]
        name = Path(out).stem
        if tool == "background":
            self._write(out, b"canvas")
        elif tool == "color":
            self._write(out, b"canvas")
        else:
            self.calls.append(Path(out).name)
            if self.fail_on is not None and name == self.fail_on:
                self._write(out, b"partial")  # a half-written file the failure must not leave in the target
                raise MotionGraphicsError("TOOL_ERROR", f"ffmpeg-skill/{tool} failed (exit 1): boom", {"reason": "tool_failed"})
            self._write(out, self.layer_bytes.get(name, f"layer {name}".encode()))  # keyed by the file stem
        return SimpleNamespace(seconds=0.1, commands=["ffmpeg ..."], dropped_non_av_streams=None,
                               data={"verified": True, "alpha_codec": "prores4444", "alpha_mode": "straight",
                                     "verification": [{"step": "alpha", "ok": True, "written": {"alpha_plane": True}}]})


def _fake_executor(tmp_path, skill):
    ex = Executor(PathPolicy(str(tmp_path)), skill=skill, reuse=False)
    ex._canvas = lambda work_dir, params: {"path": str(tmp_path / "canvas.mov"), "record": {"parameters": params, "status": "rendered"}}
    return ex


def _layer_bytes(**names):
    """{file stem: the bytes that layer's tool call writes}."""
    return dict(names)


def test_a_successful_export_commits_every_layer_and_a_manifest_that_matches(tmp_path):
    skill = _LayerSkill(tmp_path)
    ex = _fake_executor(tmp_path, skill)
    doc = parse_request(request_doc([title_element("t1", start=0.0, end=2.0), text_overlay_element("txt1", start=1.0, end=3.0),
                                     title_element("t2", start=1.0, end=2.5)], options=_options(overwrite=True)))
    paths = ex._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    result, staging = ex._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                                        tmp_path / "out.mp4", {"sha256": "p" * 64, "duration": 6.0})
    target = tmp_path / "layers"
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    # the manifest's order is (start, id), whatever order the tool calls happened to finish in
    assert [(l["id"], l["start"]) for l in manifest["layers"]] == [("t1", 0.0), ("t2", 1.0), ("txt1", 1.0)]
    assert [l["file"] for l in manifest["layers"]] == [l["file"] for l in result["layers"]] == ["t1.mov", "t2.mov", "txt1.mov"]
    # exactly the files the manifest names, each with the manifest's size and sha256, and nothing else
    assert sorted(p.name for p in target.iterdir()) == ["manifest.json", "t1.mov", "t2.mov", "txt1.mov"]
    for layer in manifest["layers"]:
        data = (target / layer["file"]).read_bytes()
        assert layer["sha256"] == hashlib.sha256(data).hexdigest() and layer["size"] == len(data)
        assert layer["alpha_codec"] == "prores4444" and layer["alpha_mode"] == "straight" and layer["verified"] is True
        assert layer["alpha"]["ok"] is True
    assert manifest["verified"] is True and manifest["overwrite"] is True and result["verified"] is True
    assert result["manifest"]["sha256"] == hashlib.sha256((target / "manifest.json").read_bytes()).hexdigest()
    assert staging.committed is True
    # no staging or backup directory survives a committed export
    assert not [p for p in target.iterdir() if p.name.startswith((STAGING_PREFIX, BACKUP_PREFIX))]
    # a re-run with the switch on replaces the result whole, from a clean directory
    result2, _ = ex._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                                   tmp_path / "out.mp4", {"sha256": "q" * 64, "duration": 6.0})
    assert sorted(p.name for p in target.iterdir()) == ["manifest.json", "t1.mov", "t2.mov", "txt1.mov"]
    assert json.loads((target / "manifest.json").read_text(encoding="utf-8"))["programme"]["sha256"] == "q" * 64


def test_a_failed_element_rolls_back_and_keeps_the_previous_complete_result(tmp_path):
    """The acceptance case: an element failing part-way deletes this run's staging, leaves the previous complete result (layers and its
    manifest) exactly as it was, and raises a retryable error. Nothing of the failed run reaches the target."""
    target = tmp_path / "layers"
    target.mkdir()
    (target / "t1.mov").write_bytes(b"old t1")
    (target / "t2.mov").write_bytes(b"old t2")
    old_manifest = json.dumps({"schema": LAYERS_MANIFEST_SCHEMA, "layers": [{"id": "t1", "file": "t1.mov"}, {"id": "t2", "file": "t2.mov"}],
                               "verified": True}).encode()
    (target / "manifest.json").write_bytes(old_manifest)
    skill = _LayerSkill(tmp_path, fail_on="t2", layer_bytes=_layer_bytes(t1=b"new t1 t1 t1"))
    ex = _fake_executor(tmp_path, skill)
    doc = parse_request(request_doc([title_element("t1"), title_element("t2", start=1.0, end=2.0)], options=_options(overwrite=True)))
    paths = ex._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    ex._check_layer_overwrite(paths)  # consented, as the caller asked for overwrite
    with pytest.raises(MotionGraphicsError) as e:
        ex._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                          tmp_path / "out.mp4", {"sha256": "x", "duration": 6.0})
    assert e.value.code == "TOOL_ERROR" and e.value.retryable is True and e.value.details["layer_export_rolled_back"] is True
    # the previous complete result is untouched (t1 was drawn before t2 failed: its new bytes are not in the target)
    assert (target / "t1.mov").read_bytes() == b"old t1" and (target / "t2.mov").read_bytes() == b"old t2"
    assert (target / "manifest.json").read_bytes() == old_manifest
    assert sorted(p.name for p in target.iterdir()) == ["manifest.json", "t1.mov", "t2.mov"]


def test_a_failure_on_a_first_export_leaves_no_directory_behind(tmp_path):
    skill = _LayerSkill(tmp_path, fail_on="t1")
    ex = _fake_executor(tmp_path, skill)
    doc = parse_request(request_doc([title_element("t1")], options=_options()))
    paths = ex._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    with pytest.raises(MotionGraphicsError):
        ex._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                          tmp_path / "out.mp4", {"sha256": "x", "duration": 6.0})
    assert not (tmp_path / "layers").exists()  # nothing left at all: no manifest, no layer, no staging directory


def test_a_failed_rerun_can_be_retried_and_succeeds(tmp_path):
    """After a failed run the caller retries the same request: it renders again and commits a complete result (the failure left
    nothing that blocks it)."""
    target = tmp_path / "layers"
    target.mkdir()
    (target / "t1.mov").write_bytes(b"old")
    (target / "manifest.json").write_text(json.dumps({"schema": LAYERS_MANIFEST_SCHEMA, "layers": [{"id": "t1", "file": "t1.mov"}]}), encoding="utf-8")
    doc = parse_request(request_doc([title_element("t1"), title_element("t2", start=1.0, end=2.0)], options=_options(overwrite=True)))
    failing = _fake_executor(tmp_path, _LayerSkill(tmp_path, fail_on="t2"))
    paths = failing._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    with pytest.raises(MotionGraphicsError):
        failing._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                               tmp_path / "out.mp4", {"sha256": "x", "duration": 6.0})
    assert (target / "manifest.json").exists() and json.loads((target / "manifest.json").read_text(encoding="utf-8"))["layers"] == [{"id": "t1", "file": "t1.mov"}]
    ok = _fake_executor(tmp_path, _LayerSkill(tmp_path))
    paths = ok._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    result, _ = ok._export_layers(doc, doc.ordered_elements(), paths, {}, {}, {}, 320, 180, 6.0, 25.0, tmp_path, ".mp4", 18, "medium", None,
                                  tmp_path / "out.mp4", {"sha256": "y", "duration": 6.0})
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in manifest["layers"]] == ["t1", "t2"] and manifest["verified"] is True
    assert sorted(p.name for p in target.iterdir()) == ["manifest.json", "t1.mov", "t2.mov"]
    for layer in manifest["layers"]:
        assert hashlib.sha256((target / layer["file"]).read_bytes()).hexdigest() == layer["sha256"]


def test_a_manifest_that_does_not_match_the_files_is_refused_and_rolled_back(tmp_path):
    """The manifest must be exactly the files committed: a mismatch between a written layer and its recorded sha256 fails the commit,
    restores the previous result and is retryable."""
    target = tmp_path / "layers"
    target.mkdir()
    (target / "old.mov").write_bytes(b"old")
    (target / "manifest.json").write_text(json.dumps({"layers": [{"id": "old", "file": "old.mov"}]}), encoding="utf-8")
    doc = parse_request(request_doc([title_element("t1")], options=_options(overwrite=True)))
    ex = _fake_executor(tmp_path, _LayerSkill(tmp_path))
    paths = ex._layer_paths(doc, tmp_path / "video.mp4", tmp_path / "out.mp4")
    staging = LayerStaging(paths["directory"]).prepare("manifest.json")
    (staging.path("t1.mov")).write_bytes(b"staged")
    staging.write_manifest("{}", "manifest.json")
    with pytest.raises(MotionGraphicsError) as e:
        staging.commit(["t1.mov"], "manifest.json", "{}", {"t1.mov": (6, "0" * 64)})  # a sha256 the file cannot have
    assert e.value.code == "OUTPUT_ERROR" and e.value.details["reason"] == "layer_export_verification_failed"
    assert (target / "old.mov").read_bytes() == b"old" and (target / "manifest.json").exists() and not (target / "t1.mov").exists()
    staging.abort()


def test_two_exports_in_one_workspace_do_not_stage_beside_each_other(tmp_path):
    """The workspace lock: the second export of the same workspace fails before rendering anything, with a retryable error
    (no interleaved manifest, no shared staging directory). It succeeds once the first has released the lock."""
    ex = Executor(PathPolicy(str(tmp_path)), skill=None)
    doc = parse_request(request_doc([title_element()], options=_options()))
    first = ex._acquire_layer_lock(doc)
    assert first.held
    try:
        with pytest.raises(MotionGraphicsError) as e:
            ex._acquire_layer_lock(doc)
        assert e.value.code == "OUTPUT_ERROR" and e.value.details["reason"] == "layer_export_busy" and e.value.retryable is True
        # another Executor (another request) in the same workspace is refused the same way
        with pytest.raises(MotionGraphicsError) as e2:
            Executor(PathPolicy(str(tmp_path)), skill=None)._acquire_layer_lock(doc)
        assert e2.value.details["reason"] == "layer_export_busy"
    finally:
        first.release()
    second = ex._acquire_layer_lock(doc)
    second.release()


def test_two_threads_racing_for_the_lock_one_wins_and_one_is_refused(tmp_path):
    """Two exports launched at once in one workspace: exactly one proceeds, the other fails with layer_export_busy (never both
    staging into the same directory)."""
    doc = parse_request(request_doc([title_element()], options=_options()))
    lock_path = tmp_path / LAYER_LOCK_NAME
    def export(i, results, barrier):
        lock = Executor(PathPolicy(str(tmp_path)), skill=None)
        barrier.wait()
        try:
            held = lock._acquire_layer_lock(doc)
        except MotionGraphicsError as e:
            results[i] = e.details["reason"]
            return
        results[i] = "held"
        time.sleep(0.05)  # hold it long enough for the other thread to try
        held.release()
    results, barrier = [None, None], threading.Barrier(2)
    threads = [threading.Thread(target=export, args=(i, results, barrier)) for i in range(2)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert sorted(results) == ["held", "layer_export_busy"]


def test_a_crash_between_the_commit_moves_is_recovered_by_the_next_run(tmp_path):
    """A backup left by a crash while committing is not a live export's: the next run (lock held) consults its journal, removes the
    half-committed new files, restores the old ones and leaves exactly one manifest; a leftover staging directory is deleted."""
    from motion_graphics.layerstage import JOURNAL_NAME
    target = tmp_path / "layers"
    target.mkdir()
    # the crashed run had moved the old result into its backup, written its journal, moved a new layer in, and died before its manifest
    (target / "new.mov").write_bytes(b"half-committed new layer")
    backup = target / f"{BACKUP_PREFIX}deadbeef.tmp"
    backup.mkdir()
    (backup / JOURNAL_NAME).write_text(json.dumps({"new": ["new.mov", "manifest.json"], "old": ["manifest.json", "old.mov"]}), encoding="utf-8")
    (backup / "manifest.json").write_text("{\"restored\": true}", encoding="utf-8")
    (backup / "old.mov").write_bytes(b"old layer")
    stale = target / f"{STAGING_PREFIX}cafebabe.tmp"
    stale.mkdir()
    (stale / "t9.mov").write_bytes(b"junk")
    sweep(target, "manifest.json")
    assert not backup.exists() and not stale.exists()
    assert sorted(p.name for p in target.iterdir()) == ["manifest.json", "old.mov"]  # exactly one manifest, and its files
    assert (target / "manifest.json").read_text(encoding="utf-8") == "{\"restored\": true}" and (target / "old.mov").read_bytes() == b"old layer"
    # a backup beside a current manifest is this run's already-superseded one: dropped, the current result stays
    backup2 = target / f"{BACKUP_PREFIX}feedface.tmp"
    backup2.mkdir()
    (backup2 / "manifest.json").write_text("{}", encoding="utf-8")
    sweep(target, "manifest.json")
    assert not backup2.exists() and (target / "manifest.json").read_text(encoding="utf-8") == "{\"restored\": true}"


def test_the_workspace_lock_is_a_file_lock_released_with_its_holder(tmp_path):
    """The lock is an OS file lock: a second lock object on the same file (another process's would be) is refused while held,
    and granted after the holder releases or dies (the OS drops it)."""
    path = tmp_path / "x.lock"
    a, b = WorkspaceLock(path), WorkspaceLock(path)
    assert a.acquire() is True and a.held
    assert b.acquire() is False
    a.release()
    assert a.held is False and b.acquire() is True
    b.release()


class _BlockingSkill(_LayerSkill):
    """Holds the second export inside the first one's layer render until the test lets it go, so the race is real, not simulated."""

    def __init__(self, root, entered, release, fail_on=None):
        super().__init__(root, fail_on=fail_on)
        self.entered, self.release = entered, release

    def run_tool(self, tool, argv, timeout=None, cwd=None):
        if tool in ("graphics", "overlay"):
            self.entered.set()
            self.release.wait(5.0)
        return super().run_tool(tool, argv, timeout, cwd)


def test_two_response_runs_racing_in_one_workspace_never_interleave(tmp_path):
    """Two exports asked for at the same time in one workspace: the first holds the lock while it renders, the second fails before
    it renders anything (layer_export_busy, retryable). The committed result is the first run's alone -- one manifest, whose files
    all match their hashes -- and the retry after it finishes succeeds."""
    (tmp_path / "video.mp4").write_bytes(b"video")
    (tmp_path / "out").mkdir()
    (tmp_path / "logo.png").write_bytes(b"png")
    entered, release = threading.Event(), threading.Event()
    slow = _fake_executor(tmp_path, _BlockingSkill(tmp_path, entered, release))
    slow._canvas = lambda work_dir, params: {"path": str(tmp_path / "canvas.mov"), "record": {"parameters": params, "status": "rendered"}}
    fast_skill = _LayerSkill(tmp_path, layer_bytes=_layer_bytes(t1=b"second run's layer"))
    fast = _fake_executor(tmp_path, fast_skill)
    doc = request_doc([title_element("t1")], output="out/out.mp4", options=_options())
    results: Dict[str, Any] = {}

    def first():
        try:
            results["first"] = slow.response(doc)
        except MotionGraphicsError as e:
            results["first"] = e

    def second():
        try:
            results["second"] = fast.response(doc)
        except MotionGraphicsError as e:
            results["second"] = e

    t1 = threading.Thread(target=first)
    t1.start()
    assert entered.wait(5.0), "the first export never started its layer render"
    t2 = threading.Thread(target=second)
    t2.start()
    t2.join(5.0)
    busy = results.get("second")
    assert isinstance(busy, MotionGraphicsError) and busy.code == "OUTPUT_ERROR" and busy.details["reason"] == "layer_export_busy"
    assert busy.retryable is True and not (tmp_path / "layers" / "manifest.json").exists()  # nothing of the refused run was written
    assert fast_skill.calls == []  # it never rendered a layer
    release.set()
    t1.join(10.0)
    assert isinstance(results["first"], dict) and results["first"]["layer_export"]["verified"] is True
    target = tmp_path / "layers"
    manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8"))
    assert [l["id"] for l in manifest["layers"]] == ["t1"]
    assert (target / "t1.mov").read_bytes() == b"layer t1"  # the first run's bytes, not the second's
    for layer in manifest["layers"]:
        assert sha256_file(str(target / layer["file"])) == layer["sha256"]
    # the refused export retried after the first finished, with the switch on, replaces the result whole
    retried = _fake_executor(tmp_path, _LayerSkill(tmp_path, layer_bytes=_layer_bytes(t1=b"second run's layer"))).response(
        request_doc([title_element("t1")], output="out/out2.mp4", options=_options(overwrite=True)))
    assert retried["layer_export"]["verified"] is True
    assert (target / "t1.mov").read_bytes() == b"second run's layer"
    assert json.loads((target / "manifest.json").read_text(encoding="utf-8"))["layers"][0]["sha256"] == sha256_file(str(target / "t1.mov"))


# ---- the manifest and the contract
def test_the_manifest_order_is_start_then_id_whatever_order_renders_finish_in():
    """A layer export may render its elements in any order (and a caller may one day render them in parallel): the manifest is
    always (start, id), the order the programme was rendered and a compositor stacks in."""
    from motion_graphics.layerexport import manifest_order
    finished = [{"id": "c", "start": 2.0}, {"id": "b", "start": 1.0}, {"id": "a", "start": 1.0}, {"id": "z", "start": 0.0}]
    for order in (finished, list(reversed(finished)), [finished[i] for i in (2, 0, 3, 1)]):
        assert [l["id"] for l in manifest_order(order)] == ["z", "a", "b", "c"]


def test_manifest_document_shape():
    layer = {"id": "t1", "type": "title", "start": 0.0, "end": 2.0, "box": {"x": 1, "y": 2, "width": 3, "height": 4}, "box_precision": "estimated",
             "file": "t1.mov", "path": "/abs/layers/t1.mov", "sha256": "ab", "size": 10, "duration": 6.0, "alpha_codec": "prores4444",
             "alpha_mode": "straight", "verified": True, "alpha": {"step": "alpha", "ok": True}, "seconds": 1.0, "tool_commands_observed": ["x"]}
    m = manifest_document({"file": "out.mp4"}, {"alpha_codec": "prores4444", "alpha_mode": "straight"}, {"width": 320}, [layer])
    assert m["schema"] == LAYERS_MANIFEST_SCHEMA and m["verified"] is True and m["overwrite"] is False
    assert "path" not in m["layers"][0] and "tool_commands_observed" not in m["layers"][0] and m["layers"][0]["file"] == "t1.mov"
    assert manifest_document({}, {"alpha_codec": "qtrle", "alpha_mode": "straight"}, {}, [dict(layer, verified=None)])["verified"] is False
    assert manifest_document({}, {"alpha_codec": "qtrle", "alpha_mode": "straight"}, {}, [layer], overwrite=True)["overwrite"] is True
    # every entry names the one file it was committed as, with its hash and size: a caller can verify each before it cuts with it
    assert {"file", "sha256", "size", "id", "type", "start", "end", "alpha_codec", "alpha_mode", "verified", "alpha"} <= set(m["layers"][0])


@pytest.mark.parametrize("video, tags", [
    ({"color_space": "bt709", "color_transfer": "bt709"}, "bt709"),
    ({"color_space": "bt2020nc", "color_transfer": "smpte2084"}, "bt2020-pq"),
    ({"color_space": "bt2020nc", "color_transfer": "arib-std-b67"}, "bt2020-hlg"),
    ({"color_space": "smpte170m"}, "bt601"), ({"color_space": "bt470bg"}, "bt601"),
    ({"color_space": "bt2020nc", "color_transfer": "bt2020-10"}, None), ({}, None),
])
def test_the_canvas_takes_the_programmes_colour_tags(video, tags):
    assert retag_for(video) == tags


def test_alpha_step_is_read_from_the_tool_result():
    assert alpha_step({"verification": [{"step": "probe", "ok": True}, {"step": "alpha", "ok": False, "reason": "no_alpha_plane"}]})["reason"] == "no_alpha_plane"
    assert alpha_step({"verification": [{"step": "probe", "ok": True}]}) is None and alpha_step(None) is None


def test_contract_declares_the_layer_export():
    c = skill_contract()
    assert c["response"]["conditional"]["layer_export"] == {"in": ["run", "plan"], "when": "options.layer_export is given", "shape": "see layer_export.result"}
    assert c["layer_export"]["request_field"] == "options.layer_export"
    assert c["layer_export"]["requires"]["ffmpeg_skill_flags"]["background"] == ["transparent", "fps", "alpha_codec", "alpha_mode"]
    assert "layer_export?" in c["request"]["shape"]["options?"]
    # ADR-35: the lifecycle and the concurrency rule are part of the stated contract, not an implementation detail
    assert "overwrite?" in c["layer_export"]["shape"] and "staging" in c["layer_export"]["files"]
    assert c["layer_export"]["concurrency"].startswith("one export per workspace at a time")
    assert "layer_export_busy" in c["layer_export"]["concurrency"] and "retryable true" in c["layer_export"]["concurrency"]
    assert c["request"]["shape"]["options?"]["layer_export?"]["overwrite?"] is False
    for tool in ("graphics", "overlay"):
        assert {"keep_alpha", "alpha_codec", "alpha_mode"} <= set(c["ffmpeg_skill"]["flags_used"][tool])
    # an option, not an element type: no element type, parameter type or provides entry changes
    assert all(t["type"] != "layer_export" for t in c["element_types"])


# ---- real renders
def _supported(skill_dir):
    return _skill_info(skill_dir).layer_export()["supported"]


def _psnr(a, b):
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(a), "-i", str(b), "-lavfi", "psnr", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    m = re.search(r"PSNR y:([\d.inf]+) u:([\d.inf]+) v:([\d.inf]+) average:([\d.inf]+) min:([\d.inf]+)", out)
    assert m, out[-2000:]
    return float(m.group(4))


def _psnr_by_half_second(a, b):
    """The mean per-frame PSNR of each half second (25 fps: 12-13 frames), reported with a failing PSNR."""
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(a), "-i", str(b), "-lavfi", "psnr=stats_file=-",
                          "-f", "null", "-"], capture_output=True, text=True).stdout
    frames = [float(m.group(1)) if m.group(1) != "inf" else 99.0 for m in re.finditer(r"psnr_avg:([\d.]+|inf)", out)]
    return [round(sum(frames[i:i + 12]) / len(frames[i:i + 12]), 1) for i in range(0, len(frames), 12)]


def _stream(path):
    """pix_fmt, range, matrix, primaries and transfer of a file's video stream (reported with a failing PSNR)."""
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "stream=pix_fmt,color_range,color_space,color_primaries,color_transfer,start_pts,start_time,r_frame_rate,nb_frames", "-of", "csv=p=0", str(path)],
                          capture_output=True, text=True).stdout.strip()


def _rgba(path, t, crop):
    """Mean R, G, B, A of a cropped region of the frame at time t."""
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                          "-vf", f"format=rgba,crop={crop},scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         capture_output=True, check=True).stdout
    assert len(out) == 4
    return tuple(out)


def _composite(skill_dir, workspace, manifest):
    """The layers over the clean video, in the manifest's order, each with ffmpeg-skill/overlay at 0,0 (how an NLE stacks them).
    Returns every step's file: step i is the clean video with layers 0..i on it."""
    skill = FfmpegSkill(skill_dir)
    # the clean video is the untagged fixture; the programme read it as BT.709 (ffmpeg-skill labels an untagged source so, tags only), and
    # the layers say BT.709: the clean video is labelled the same way first (a stream copy), as a delivered clean programme would be
    base, steps = workspace / "clean.mp4", []
    skill.run_tool("color", [str(workspace / "video.mp4"), "--retag", "bt709", "-o", str(base), "--overwrite"])
    for i, layer in enumerate(manifest["layers"]):
        out = workspace / f"comp{i}.mp4"
        skill.run_tool("overlay", [str(base), "--video", str(workspace / "layers" / layer["file"]), "--position", "top-left", "--margin", "0",
                                   "-o", str(out), "--overwrite"])
        steps.append(out)
        base = out
    return steps


def test_layers_composited_over_the_clean_video_give_the_programme_back(skill_dir, workspace):
    """Roadmap step 8's check: each element alone on transparent, the same timing, one file each and a manifest; the layers laid over the
    clean programme equal the burned programme within MIN_PSNR_DB."""
    elements = [title_element("t1", start=0.0, end=2.0, title="Layers"), lower_third_element("lt1", start=0.5, end=3.5),
                text_overlay_element("txt1", start=1.0, end=4.0, text="Hello", position="bottom-right"),
                image_overlay_element("img1", start=2.0, end=5.0, position="top-left", margin=8),
                shape_element("box1", start=3.0, end=5.5, position="top-right", margin=10)]
    elements[2]["animation"] = {"kind": "fade", "parameters": {"duration": 0.4}}
    doc = request_doc(elements, options=_options())
    if not _supported(skill_dir):
        with pytest.raises(MotionGraphicsError) as e:
            _executor(skill_dir, workspace).response(doc)
        assert e.value.code == "TOOL_ERROR" and e.value.details["reason"] == "ffmpeg_skill_lacks_flag"
        assert not (workspace / "out" / "out.mp4").exists() and not (workspace / "layers").exists()  # refused before anything rendered
        return
    plan = Executor(PathPolicy(str(workspace)), _executor(skill_dir, workspace).skill, dry_run=True).response(doc)
    assert [lay["file"] for lay in plan["layer_export"]["layers"]] == ["t1.mov", "lt1.mov", "txt1.mov", "img1.mov", "box1.mov"]
    assert not (workspace / "layers").exists()  # a plan writes nothing

    res = _executor(skill_dir, workspace).response(doc)
    le = res["layer_export"]
    assert le["verified"] is True and le["alpha_codec"] == "prores4444" and le["alpha_mode"] == "straight"
    assert le["canvas"]["tool"] == "ffmpeg-skill/background" and le["canvas"]["parameters"]["alpha_codec"] == CANVAS_ALPHA_CODEC
    manifest = json.loads((workspace / "layers" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == LAYERS_MANIFEST_SCHEMA and manifest["verified"] is True
    assert manifest["programme"]["sha256"] == res["output"]["sha256"]
    assert [(lay["id"], lay["type"], lay["start"], lay["end"]) for lay in manifest["layers"]] == [(e["id"], e["type"], e["start"], e["end"]) for e in
                                                                                                 sorted(elements, key=lambda e: (e["start"], e["id"]))]
    # the canvas got the programme's colour tags, and every layer drawn on it carries them (an untagged layer is read as BT.601 by a
    # compositor that negotiates colour, and the picture under it is converted)
    assert le["canvas"]["parameters"]["color_tags"] == "bt709" and le["canvas"]["retag"]["verified"] is True
    for lay in le["layers"]:
        assert _stream(workspace / "layers" / lay["file"]).split(",")[2:5] == ["bt709", "bt709", "bt709"], lay["file"]
    for lay in le["layers"]:
        assert lay["verified"] is True and lay["alpha"]["ok"] is True and lay["alpha"]["written"]["alpha_plane"] is True, lay
        assert lay["alpha_codec"] == "prores4444" and abs(lay["duration"] - 6.0) <= 0.25
        assert (workspace / "layers" / lay["file"]).is_file()
    boxes = {lay["id"]: lay for lay in manifest["layers"]}
    assert boxes["box1"]["box"] == {"x": 320 - 10 - 160, "y": 10, "width": 160, "height": 60} and boxes["box1"]["box_precision"] == "exact"
    assert boxes["img1"]["box"] == {"x": 8, "y": 8, "width": 64, "height": 64} and boxes["img1"]["box_precision"] == "exact"

    # a layer is transparent outside its element's window and where nothing is drawn, and carries the graphic inside it
    box_layer = workspace / "layers" / "box1.mov"
    assert _rgba(box_layer, 1.0, "40:20:200:20")[3] == 0               # before the shape's window
    r, g, b, a = _rgba(box_layer, 4.0, "40:20:200:20")
    assert a >= 250 and b > r + 60, (r, g, b, a)                       # navy, opaque, inside it
    assert _rgba(box_layer, 4.0, "40:20:20:120")[3] == 0               # away from the shape

    steps = _composite(skill_dir, workspace, manifest)
    burned = workspace / "out" / "out.mp4"
    with_layers, without = _psnr(steps[-1], burned), _psnr(workspace / "clean.mp4", burned)
    # each composite step against the programme stage that burned the same elements, so a failure names the layer that differs
    work = workspace / ".motion-graphics" / res["provenance"]["document_id"]
    stages = [work / f"{op['operation_id'][:16]}.mp4" for op in res["operations"][:-1]] + [burned]
    per_layer = {lay["id"]: _psnr(step, stage) for lay, step, stage in zip(manifest["layers"], steps, stages)}
    if not (with_layers >= MIN_PSNR_DB and with_layers > without + 5):
        pytest.fail(json.dumps({"with_layers": with_layers, "without": without, "per_layer": per_layer,
                                "streams": {lay["id"]: _stream(workspace / "layers" / lay["file"]) for lay in manifest["layers"]},
                                "clean": _stream(workspace / "clean.mp4"), "burned": _stream(burned),
                                "by_half_second": {lay["id"]: _psnr_by_half_second(step, stage) for lay, step, stage in zip(manifest["layers"], steps, stages)},
                                # what each pass changed where its own layer is transparent: composite step i-1 -> i, programme stage i-1 -> i
                                "composite_pass": [_psnr_by_half_second(a, b)[:1] for a, b in zip(steps, steps[1:])],
                                "programme_pass": [_psnr_by_half_second(a, b)[:1] for a, b in zip(stages, stages[1:])],
                                "step_streams": [_stream(x) for x in steps], "stage_streams": [_stream(x) for x in stages]}))

    # again with the layer overwrite switch on: the canvas is reused, the layers are written again and the manifest replaced
    res2 = _executor(skill_dir, workspace).response(request_doc(elements, overwrite=True, options=_options(overwrite=True)))
    assert res2["layer_export"]["canvas"]["status"] == "reused" and res2["layer_export"]["verified"] is True
    assert res2["layer_export"]["overwrite"] is True and res2["layer_export"]["manifest"]["sha256"] == sha256_file(str(workspace / "layers" / "manifest.json"))
    assert sorted(p.name for p in (workspace / "layers").iterdir()) == sorted(["manifest.json"] + [lay["file"] for lay in res2["layer_export"]["layers"]])
    for lay in res2["layer_export"]["layers"]:
        assert sha256_file(str(workspace / "layers" / lay["file"])) == lay["sha256"]
    # the acceptance cases against a real checkout: the switch off refuses a complete result before rendering, a failed element
    # leaves the complete result (and its manifest) alone, and the retry that replaces it succeeds whole.
    # One element failing after the others were drawn: the whole run is rolled back, the previous complete result (every layer and its
    # manifest, byte for byte) stays, and the failure is retryable. The layer call is wrapped only to fail one element deterministically.
    class _FailOne:
        def __init__(self, inner, fail_file):
            self.inner, self.fail_file = inner, fail_file

        def __getattr__(self, name):
            return getattr(self.inner, name)

        def run_tool(self, tool, argv, timeout=None, cwd=None):
            if tool in ("graphics", "overlay") and str(argv[argv.index("-o") + 1]).endswith(self.fail_file):
                Path(argv[argv.index("-o") + 1]).write_bytes(b"half-written by the tool before it failed")
                raise MotionGraphicsError("TOOL_ERROR", f"ffmpeg-skill/{tool} failed (exit 1): boom", {"reason": "tool_failed"})
            return self.inner.run_tool(tool, argv, timeout, cwd)

    broken = [title_element("ok1", start=0.0, end=1.0, title="Fine"), title_element("bad1", start=1.0, end=2.0, title="Bad")]
    # first a complete result of the broken document's own shape is committed, so the failure has a previous result to preserve
    (workspace / "out").mkdir(exist_ok=True)
    _executor(skill_dir, workspace).response(request_doc(broken, overwrite=True, options=_options(overwrite=True)))
    before = {p.name: p.read_bytes() for p in (workspace / "layers").iterdir()}
    out_before = (workspace / "out" / "out.mp4").read_bytes()
    real = _executor(skill_dir, workspace)
    failing = Executor(PathPolicy(str(workspace)), _FailOne(real.skill, "bad1.mov"), timeout=120.0)
    with pytest.raises(MotionGraphicsError) as e:
        failing.response(request_doc(broken, overwrite=True, options=_options(overwrite=True)))
    assert e.value.code == "TOOL_ERROR" and e.value.retryable is True and e.value.details["layer_export_rolled_back"] is True
    assert {p.name: p.read_bytes() for p in (workspace / "layers").iterdir()} == before  # the previous complete result, whole
    assert [lay["id"] for lay in json.loads((workspace / "layers" / "manifest.json").read_text(encoding="utf-8"))["layers"]] == ["ok1", "bad1"]
    assert (workspace / "out" / "out.mp4").read_bytes() == out_before
    # the retry (the same request, without the injected failure) succeeds and replaces the result whole
    retried = _executor(skill_dir, workspace).response(request_doc(broken, overwrite=True, options=_options(overwrite=True)))
    retried_manifest = json.loads((workspace / "layers" / "manifest.json").read_text(encoding="utf-8"))
    assert retried["layer_export"]["verified"] is True and [l["id"] for l in retried_manifest["layers"]] == ["ok1", "bad1"]
    assert sorted(p.name for p in (workspace / "layers").iterdir()) == ["bad1.mov", "manifest.json", "ok1.mov"]
    for lay in retried_manifest["layers"]:
        assert sha256_file(str(workspace / "layers" / lay["file"])) == lay["sha256"]


def test_a_lossless_layer_in_another_codec(skill_dir, workspace):
    doc = request_doc([text_overlay_element("cap", start=1.0, end=3.0, text="Lossless")], output="out/one.mp4",
                      options=_options(alpha_codec="qtrle", alpha_mode="premultiplied"))
    if not _supported(skill_dir):
        with pytest.raises(MotionGraphicsError) as e:
            _executor(skill_dir, workspace).response(doc)
        assert e.value.details["reason"] == "ffmpeg_skill_lacks_flag"
        return
    res = _executor(skill_dir, workspace).response(doc)
    lay = res["layer_export"]["layers"][0]
    assert lay["file"] == "cap.mov" and lay["alpha_codec"] == "qtrle" and lay["alpha_mode"] == "premultiplied" and lay["verified"] is True
    assert lay["alpha"]["written"]["codec"] == "qtrle"
    # an existing layer without overwrite is refused before anything renders
    (workspace / "out" / "one.mp4").unlink()
    with pytest.raises(MotionGraphicsError) as e:
        _executor(skill_dir, workspace).response(doc)
    assert e.value.details["reason"] == "exists" and not (workspace / "out" / "one.mp4").exists()
