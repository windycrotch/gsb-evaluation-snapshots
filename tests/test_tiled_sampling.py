"""Tiled HiRes sampling + per-image manifest save acceptance tests.

Covers:
- tiled blending: overlapping tiles accumulate with feathered weights and
  normalise — an identity sampler reproduces the input exactly (no seams),
  and a constant sampler yields a constant canvas (no zero-weight holes);
- latent ratio: tile sizes, padding and the width/height handed to the
  sampler follow the model's real latent downscale ratio (8 vs 16), and every
  tile's region_frame is a normalised [0, 1] range of the full image;
- failure isolation: a tile raising fails only that image (no half-saved
  manifest entry), completed images still land on disk; interrupts propagate
  untouched instead of being swallowed as ordinary failures;
- merged save: flush_batch_with_vae merges with the on-disk manifest —
  concurrent sessions' entries survive, favorited/rejected/note tags are
  preserved, ids stay unique, and entries pointing at missing files are
  pruned on re-run.
"""
import importlib.util
import json
import os
import random
import sys
import threading

import pytest

torch = pytest.importorskip("torch")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _ROOT)
_PKG = os.path.basename(_ROOT)


def _load_real(mod_name, file_name):
    spec = importlib.util.spec_from_file_location(f"{_PKG}.{mod_name}", os.path.join(_ROOT, file_name))
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = _PKG
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def mu():
    """Real manifest_utils, also injected into the package stub so that
    image_generation's `from .manifest_utils import ...` picks it up."""
    mod = _load_real("manifest_utils_real", "manifest_utils.py")
    stub = sys.modules.get(f"{_PKG}.manifest_utils")
    if stub is not None:
        for name in ("save_manifest_merged", "merge_manifest_with_disk",
                     "preserve_disk_comparisons", "_manifest_lock", "_item_file_path"):
            setattr(stub, name, getattr(mod, name))
    return mod


@pytest.fixture
def ig(mu):
    try:
        mod = _load_real("image_generation_real", "image_generation.py")
    except Exception as e:
        pytest.skip(f"image_generation.py not importable under the stubs: {e}")
    return mod


# --------------------------------------------------------------------------
# tiled_hires_sample
# --------------------------------------------------------------------------

def _run_tiled(ig, monkeypatch, fake_generate, ratio=8, shape=(1, 4, 8, 16),
               tile_w_px=64, tile_h_px=64, blur_px=8, pad_px=32, uniform=False):
    monkeypatch.setattr(ig, "_latent_ratio", lambda model: ratio)
    monkeypatch.setattr(ig, "generate_image", fake_generate)
    samples = torch.randn(*shape)
    out = ig.tiled_hires_sample(
        {"samples": samples}, object(), {"seed": 1, "cfg": 1.0, "sampler": "euler", "scheduler": "normal"},
        "pos", "neg", hires_steps=1, hires_denoise=0.5,
        tile_width=tile_w_px, tile_height=tile_h_px, mask_blur=blur_px,
        tile_padding=pad_px, force_uniform=uniform,
        pixel_width=shape[-1] * ratio, pixel_height=shape[-2] * ratio,
    )
    return out, samples


def test_tiled_identity_sampler_reproduces_input_no_seams(ig, monkeypatch):
    """Identity sampler: feather-weighted normalisation must return the input
    exactly — any weighting hole or double-count shows up as a seam."""
    def identity(*args, **kwargs):
        lat = args[8] if len(args) > 7 else kwargs["latent_input"]
        return {"samples": lat["samples"].clone()}, 0.1

    out, samples = _run_tiled(ig, monkeypatch, identity)
    assert torch.allclose(out["samples"], samples, atol=1e-5)


def test_tiled_constant_sampler_no_zero_weight_holes(ig, monkeypatch):
    """Constant sampler: every position must end up exactly 1.0 — a zero-weight
    cell (uncovered or unnormalised) would read as a black block."""
    def const(*args, **kwargs):
        lat = args[8] if len(args) > 7 else kwargs["latent_input"]
        return {"samples": torch.ones_like(lat["samples"])}, 0.1

    out, _ = _run_tiled(ig, monkeypatch, const, blur_px=16)
    assert torch.allclose(out["samples"], torch.ones_like(out["samples"]), atol=1e-5)


def test_tiled_ratio16_tile_geometry_and_region_frame(ig, monkeypatch):
    """Ratio-16 model (Flux.2 family): tile pixel sizes, padding and blur are
    converted with the REAL ratio, the sampler gets pixel dims in that ratio,
    and each tile's region_frame is a normalised [0, 1] window of the image."""
    calls = []

    def recorder(*args, **kwargs):
        calls.append(kwargs)
        lat = kwargs["latent_input"] if "latent_input" in kwargs else args[8]
        return {"samples": lat["samples"].clone()}, 0.1

    # latent 8x16 cells; tile 128px -> 8 cells at ratio 16 (would be 16 at ratio 8)
    _run_tiled(ig, monkeypatch, recorder, ratio=16, shape=(1, 128, 8, 16),
               tile_w_px=128, tile_h_px=128, pad_px=32)

    lat_h, lat_w = 8, 16
    assert len(calls) > 1, "expected the latent to be split into multiple tiles"
    for kw in calls:
        frame = kw["region_frame"]
        assert all(0.0 <= v <= 1.0 for v in frame), frame
        y0, x0, y1, x1 = frame
        # pixel dims handed to the sampler match the tile's latent span * ratio 16
        assert kw["width"] == round((x1 - x0) * lat_w) * 16
        assert kw["height"] == round((y1 - y0) * lat_h) * 16
    # tiles tile the full image exactly once along each axis
    xs = sorted({(c["region_frame"][1], c["region_frame"][3]) for c in calls})
    ys = sorted({(c["region_frame"][0], c["region_frame"][2]) for c in calls})
    assert xs[0][0] == 0.0 and xs[-1][1] == 1.0
    assert ys[0][0] == 0.0 and ys[-1][1] == 1.0


def test_tiled_ratio8_baseline_geometry(ig, monkeypatch):
    """SD/SDXL ratio 8: a 128px tile is 16 latent cells (the historical behaviour)."""
    calls = []

    def recorder(*args, **kwargs):
        calls.append(kwargs)
        lat = kwargs["latent_input"] if "latent_input" in kwargs else args[8]
        return {"samples": lat["samples"].clone()}, 0.1

    _run_tiled(ig, monkeypatch, recorder, ratio=8, shape=(1, 4, 16, 32),
               tile_w_px=128, tile_h_px=128, pad_px=32)
    for kw in calls:
        y0, x0, y1, x1 = kw["region_frame"]
        assert kw["width"] == round((x1 - x0) * 32) * 8
        assert kw["height"] == round((y1 - y0) * 16) * 8


def test_tiled_tile_failure_fails_whole_image(ig, monkeypatch):
    """A tile raising a normal error aborts THIS image (exception propagates to
    the caller, which writes no manifest entry for it); later tiles never run."""
    seen = []

    def fail_second(*args, **kwargs):
        seen.append(1)
        if len(seen) == 2:
            raise RuntimeError("simulated tile OOM")
        lat = kwargs["latent_input"] if "latent_input" in kwargs else args[8]
        return {"samples": lat["samples"].clone()}, 0.1

    with pytest.raises(RuntimeError, match="simulated tile OOM"):
        _run_tiled(ig, monkeypatch, fail_second)
    assert len(seen) == 2  # stopped at the failing tile, no further tiles sampled


def test_tiled_interrupt_not_swallowed(ig, monkeypatch):
    """InterruptProcessingException from a tile propagates as-is — it must never
    be converted into an ordinary per-image failure."""
    Interrupt = sys.modules["comfy.model_management"].InterruptProcessingException

    def interrupter(*args, **kwargs):
        raise Interrupt()

    with pytest.raises(Interrupt):
        _run_tiled(ig, monkeypatch, interrupter)


# --------------------------------------------------------------------------
# flush_batch_with_vae
# --------------------------------------------------------------------------

def _pil(size=(8, 8), color=128):
    from PIL import Image
    return Image.new("RGB", size, (color, color, color))


def _flush_env(tmp_path, monkeypatch, ig, decode):
    img_dir = tmp_path / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = str(tmp_path / "manifest.json")
    monkeypatch.setattr(ig, "decode_latent_with_vae", decode)
    return str(img_dir), manifest_path


def _read_manifest(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def test_flush_decode_failure_skips_image_others_saved(ig, monkeypatch, tmp_path):
    """One bad latent must not kill the batch: the failed image gets no manifest
    entry and no file; the healthy image is saved and listed."""
    calls = []

    def decode(vae, samples, metrics_sink=None, **kw):
        calls.append(samples)
        if len(calls) == 1:
            raise RuntimeError("decode blew up")
        return _pil()

    img_dir, manifest_path = _flush_env(tmp_path, monkeypatch, ig, decode)
    existing = {"items": []}
    batch = [("lat_bad", {"width": 8, "height": 8}), ("lat_ok", {"width": 8, "height": 8})]
    saved = ig.flush_batch_with_vae(batch, object(), img_dir, existing, "sess", manifest_path)

    assert saved == 1
    data = _read_manifest(manifest_path)
    assert len(data["items"]) == 1
    fname = data["items"][0]["file"].split("filename=")[1].split("&")[0]
    assert os.path.isfile(os.path.join(img_dir, fname))


def test_flush_interrupt_propagates(ig, monkeypatch, tmp_path):
    Interrupt = sys.modules["comfy.model_management"].InterruptProcessingException

    def decode(vae, samples, metrics_sink=None, **kw):
        raise Interrupt()

    img_dir, manifest_path = _flush_env(tmp_path, monkeypatch, ig, decode)
    with pytest.raises(Interrupt):
        ig.flush_batch_with_vae([("lat", {"width": 8, "height": 8})], object(),
                                img_dir, {"items": []}, "sess", manifest_path)
    # nothing half-written
    assert not os.path.exists(manifest_path) or not _read_manifest(manifest_path)["items"]


def test_flush_merges_disk_preserves_tags(ig, monkeypatch, tmp_path):
    """Saving merges with the on-disk manifest: user tags on shared ids survive,
    entries written by another session survive, ids stay unique."""
    img_dir, manifest_path = _flush_env(tmp_path, monkeypatch, ig,
                                        lambda v, s, metrics_sink=None, **kw: _pil())
    sub = "benchmarks/sess/images"
    # Item already on disk, tagged by the user after this run loaded its copy
    _pil().save(os.path.join(img_dir, "img_111.webp"))
    _pil().save(os.path.join(img_dir, "img_222.webp"))
    disk = {"items": [
        {"id": 111, "file": f"/view?filename=img_111.webp&type=output&subfolder={sub}",
         "favorited": True, "rejected": True, "note": "keep me"},
        {"id": 222, "file": f"/view?filename=img_222.webp&type=output&subfolder={sub}",
         "favorited": False, "rejected": False},
    ]}
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(disk, f)

    # The run's in-memory copy predates the user's tags
    existing = {"items": [{"id": 111, "file": f"/view?filename=img_111.webp&type=output&subfolder={sub}"}]}
    ig.flush_batch_with_vae([("lat", {"width": 8, "height": 8})], object(),
                            img_dir, existing, "sess", manifest_path)

    data = _read_manifest(manifest_path)
    ids = [i["id"] for i in data["items"]]
    assert len(ids) == len(set(ids)) == 3
    by_id = {i["id"]: i for i in data["items"]}
    assert by_id[111]["favorited"] is True
    assert by_id[111]["rejected"] is True
    assert by_id[111]["note"] == "keep me"
    assert 222 in by_id  # concurrent session's entry survived
    # every entry points at a file that exists
    for item in data["items"]:
        fname = item["file"].split("filename=")[1].split("&")[0]
        assert os.path.isfile(os.path.join(img_dir, fname))


def test_flush_prunes_entries_whose_files_are_gone(ig, monkeypatch, tmp_path):
    """Re-running a session after a failure must not leave entries that point
    at files which do not exist."""
    img_dir, manifest_path = _flush_env(tmp_path, monkeypatch, ig,
                                        lambda v, s, metrics_sink=None, **kw: _pil())
    sub = "benchmarks/sess/images"
    _pil().save(os.path.join(img_dir, "img_444.webp"))
    disk = {"items": [
        {"id": 333, "file": f"/view?filename=img_333.webp&type=output&subfolder={sub}"},  # file missing
        {"id": 444, "file": f"/view?filename=img_444.webp&type=output&subfolder={sub}"},
    ]}
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(disk, f)

    existing = {"items": []}
    ig.flush_batch_with_vae([("lat", {"width": 8, "height": 8})], object(),
                            img_dir, existing, "sess", manifest_path)

    data = _read_manifest(manifest_path)
    ids = [i["id"] for i in data["items"]]
    assert 333 not in ids            # stale entry pruned
    assert 444 in ids                # entry with a real file kept
    assert len(ids) == len(set(ids)) == 2
    for item in data["items"]:
        fname = item["file"].split("filename=")[1].split("&")[0]
        assert os.path.isfile(os.path.join(img_dir, fname))


def test_concurrent_sessions_flush_without_overwriting(ig, monkeypatch, tmp_path):
    """Two sessions flushing to the same manifest concurrently: every image
    lands on disk and every entry survives — no lost updates, no duplicate ids."""
    img_dir, manifest_path = _flush_env(tmp_path, monkeypatch, ig,
                                        lambda v, s, metrics_sink=None, **kw: _pil())

    # Deterministic unique id suffixes across threads
    counter = {"n": 0}
    lock = threading.Lock()
    real_randint = random.randint

    def unique_randint(a, b):
        with lock:
            counter["n"] += 1
            return a + (counter["n"] % (b - a + 1))

    monkeypatch.setattr(random, "randint", unique_randint)
    try:
        errors = []

        def worker(tag):
            try:
                existing = {"items": []}
                batch = [(f"lat_{tag}_{i}", {"width": 8, "height": 8}) for i in range(5)]
                ig.flush_batch_with_vae(batch, object(), img_dir, existing, "sess", manifest_path)
            except Exception as e:  # pragma: no cover - failure path
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(t,)) for t in ("A", "B")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    finally:
        monkeypatch.setattr(random, "randint", real_randint)

    assert not errors
    data = _read_manifest(manifest_path)
    ids = [i["id"] for i in data["items"]]
    assert len(ids) == 10
    assert len(set(ids)) == 10
    for item in data["items"]:
        fname = item["file"].split("filename=")[1].split("&")[0]
        assert os.path.isfile(os.path.join(img_dir, fname))
