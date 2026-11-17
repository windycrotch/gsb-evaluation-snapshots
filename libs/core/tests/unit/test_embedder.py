"""Tests for SmartEmbedder with auto-fallback."""

from pathlib import Path

from genblaze_core.media.embedder import SmartEmbedder
from genblaze_core.models import Manifest, Run, Step
from genblaze_core.models.enums import PromptVisibility
from genblaze_core.models.policy import EmbedPolicy
from PIL import Image


def _make_manifest() -> Manifest:
    step = Step(provider="test", model="test-model", prompt="hello", seed=42)
    run = Run(steps=[step])
    m = Manifest(run=run)
    m.compute_hash()
    return m


def test_embed_png_inline(tmp_path: Path) -> None:
    """SmartEmbedder should use inline embed for PNG."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    embedder = SmartEmbedder()
    result = embedder.embed(png, _make_manifest())
    assert result.method == "inline"
    assert result.sidecar_path is None


def test_embed_unknown_format_sidecar(tmp_path: Path) -> None:
    """SmartEmbedder should fallback to sidecar for unknown formats."""
    src = tmp_path / "test.mp4"
    src.write_bytes(b"fake video data")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()


def test_embed_accepts_str_output_override(tmp_path: Path) -> None:
    """EmbedResult.path=output or source used to leak a raw str when
    output= was passed as a str with no override handling — every branch
    (inline, sidecar, none, pointer) must return a real Path."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    out = tmp_path / "renamed.png"

    embedder = SmartEmbedder()
    result = embedder.embed(png, _make_manifest(), output=str(out))
    assert result.method == "inline"
    assert isinstance(result.path, Path)
    assert result.path == out


def test_embed_unknown_format_sidecar_accepts_str_source(tmp_path: Path) -> None:
    """guess_mime()'s extension-fallback branch (magic bytes unrecognized)
    used to call path.suffix.lower() directly on a raw str source, raising
    AttributeError instead of correctly falling back to sidecar (#225 —
    same bug class as Mp4Handler, reachable via SmartEmbedder.embed())."""
    src = tmp_path / "test.mp4"
    src.write_bytes(b"fake video data")

    embedder = SmartEmbedder()
    result = embedder.embed(str(src), _make_manifest())
    assert result.method == "sidecar"
    assert isinstance(result.path, Path), "EmbedResult.path must stay Path-typed for str input"


def test_embed_none_policy(tmp_path: Path) -> None:
    """embed_mode=none should skip embedding entirely."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="none")
    result = embedder.embed(png, _make_manifest(), policy=policy)
    assert result.method == "none"


def test_embed_jpeg_inline(tmp_path: Path) -> None:
    """SmartEmbedder should use inline embed for JPEG."""
    jpg = tmp_path / "test.jpg"
    Image.new("RGB", (10, 10)).save(jpg, "JPEG")

    embedder = SmartEmbedder()
    result = embedder.embed(jpg, _make_manifest())
    assert result.method == "inline"


def test_embed_truly_unknown_extension_sidecar(tmp_path: Path) -> None:
    """Truly unknown extension (no handler) should go directly to sidecar."""
    src = tmp_path / "test.xyz"
    src.write_bytes(b"unknown format data")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()


def test_embed_full_mode_private_prompt_raises(tmp_path: Path) -> None:
    """SmartEmbedder must surface ManifestError when the caller requests
    redaction without switching to pointer mode.

    Previously, the embedder would silently write a manifest whose
    canonical_hash did not match its embedded (redacted) payload. The
    correct UX is to push the caller to pointer mode, which preserves
    verifiability.
    """
    import pytest
    from genblaze_core.exceptions import ManifestError

    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    embedder = SmartEmbedder()
    policy = EmbedPolicy(prompt_visibility=PromptVisibility.PRIVATE)
    with pytest.raises(ManifestError, match="embed_mode='pointer'"):
        embedder.embed(png, _make_manifest(), policy=policy)


def test_embed_pointer_mode_preserves_verifiability(tmp_path: Path) -> None:
    """The escape hatch: redact via embed_mode='pointer' so the embedded
    pointer's hash still verifies against the server-held full manifest."""
    import json

    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    manifest = _make_manifest()
    manifest.manifest_uri = "https://example.com/manifests/abc.json"

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="pointer", prompt_visibility=PromptVisibility.PRIVATE)
    result = embedder.embed(png, manifest, policy=policy)
    assert result.method == "pointer"
    assert result.sidecar_path is not None

    pointer = json.loads(result.sidecar_path.read_text(encoding="utf-8"))
    assert pointer["canonical_hash"] == manifest.canonical_hash
    # Server-held full manifest still verifies.
    assert manifest.verify()


def test_embed_pointer_mode_distinct_output_creates_media(tmp_path: Path) -> None:
    """Regression for #238: pointer mode + output= pointing at a distinct
    path used to report EmbedResult.path as if the media existed there,
    when only the pointer sidecar was ever written."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    out = tmp_path / "redacted.png"

    manifest = _make_manifest()
    manifest.manifest_uri = "https://example.com/manifests/abc.json"

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="pointer")
    result = embedder.embed(png, manifest, output=out, policy=policy)

    assert result.method == "pointer"
    assert result.path == out
    assert result.path.exists(), "EmbedResult.path must point at real media"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()


def test_embed_pointer_mode_source_only_path_exists(tmp_path: Path) -> None:
    """Source-only pointer calls (no output=) must also report an existing
    path — the degenerate case of the #238 contract."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    manifest = _make_manifest()
    manifest.manifest_uri = "https://example.com/manifests/abc.json"

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="pointer")
    result = embedder.embed(png, manifest, policy=policy)

    assert result.path == png
    assert result.path.exists()


def test_embed_sidecar_fallback_distinct_output_creates_media(tmp_path: Path) -> None:
    """The non-pointer sidecar fallback (no format handler, or a failed
    inline embed) shares the same underlying SidecarHandler — it has the
    same #238 exposure for a distinct output= and must also materialize
    real media there."""
    src = tmp_path / "test.mp4"
    src.write_bytes(b"fake video data")
    out = tmp_path / "renamed.mp4"

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest(), output=out)

    assert result.method == "sidecar"
    assert result.path == out
    assert result.path.exists()
    assert result.path.read_bytes() == src.read_bytes()


def test_sniff_mime_routes_misnamed_file(tmp_path: Path) -> None:
    """A PNG-named file containing JPEG bytes should dispatch to JpegHandler."""
    from genblaze_core.media.embedder import guess_mime, sniff_mime

    misnamed = tmp_path / "looks_like.png"
    Image.new("RGB", (8, 8)).save(misnamed, "JPEG")  # JPEG bytes, .png suffix

    assert sniff_mime(misnamed) == "image/jpeg"
    assert guess_mime(misnamed) == "image/jpeg"  # content wins over extension


def test_sniff_mime_falls_back_to_extension(tmp_path: Path) -> None:
    """Unknown content but known extension still resolves via extension."""
    from genblaze_core.media.embedder import guess_mime, sniff_mime

    src = tmp_path / "raw.mp4"
    src.write_bytes(b"\x00\x00\x00\x10not really an mp4")
    assert sniff_mime(src) is None
    assert guess_mime(src) == "video/mp4"


def test_sniff_mime_signatures(tmp_path: Path) -> None:
    """Each supported magic-byte signature is recognized."""
    from genblaze_core.media.embedder import sniff_mime

    cases = {
        "png": (b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "image/png"),
        "jpg": (b"\xff\xd8\xff\xe0" + b"\x00" * 12, "image/jpeg"),
        "webp": (b"RIFF\x00\x00\x00\x10WEBP" + b"\x00" * 4, "image/webp"),
        "wav": (b"RIFF\x00\x00\x00\x10WAVE" + b"\x00" * 4, "audio/wav"),
        "flac": (b"fLaC" + b"\x00" * 12, "audio/flac"),
        "mp3_id3": (b"ID3\x03" + b"\x00" * 12, "audio/mpeg"),
        "mp3_raw": (b"\xff\xfb" + b"\x00" * 14, "audio/mpeg"),
    }
    for name, (head, expected) in cases.items():
        f = tmp_path / name
        f.write_bytes(head)
        assert sniff_mime(f) == expected, f"sniff failed for {name}"


def test_embed_inline_success_has_no_error(tmp_path: Path) -> None:
    """A successful inline embed must report embed_error=None."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    embedder = SmartEmbedder()
    result = embedder.embed(png, _make_manifest())
    assert result.method == "inline"
    assert result.embed_error is None


def test_embed_fallback_surfaces_error(tmp_path: Path) -> None:
    """Sidecar fallback after a failed inline embed must populate embed_error."""
    # .mp4 extension routes to Mp4Handler, which will reject 'fake video data'
    # as not-a-valid-MP4 — exercising the inline failure path.
    src = tmp_path / "broken.mp4"
    src.write_bytes(b"fake video data")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.sidecar_path is not None
    assert result.embed_error is not None
    assert "EmbeddingError" in result.embed_error or "Mp4" in result.embed_error


def test_embed_unknown_extension_no_error(tmp_path: Path) -> None:
    """An extension with no handler goes straight to sidecar — not a failure, no error."""
    src = tmp_path / "test.xyz"
    src.write_bytes(b"unknown format data")
    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.embed_error is None  # unknown != failure


def test_embed_pointer_mode_writes_sidecar(tmp_path: Path) -> None:
    """embed_mode=pointer should write pointer JSON to sidecar, not leak full manifest."""
    import json

    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    manifest = _make_manifest()
    manifest.manifest_uri = "https://example.com/manifests/abc.json"

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="pointer")
    result = embedder.embed(png, manifest, policy=policy)

    assert result.method == "pointer"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()
    assert result.manifest_uri == "https://example.com/manifests/abc.json"

    # Verify sidecar contains only pointer data (no run/steps)
    pointer_data = json.loads(result.sidecar_path.read_text(encoding="utf-8"))
    assert "canonical_hash" in pointer_data
    assert "manifest_uri" in pointer_data
    assert "run" not in pointer_data


# --- MIME dispatch priority -------------------------------------------------


def test_explicit_mime_conflict_with_magic_prefers_magic(tmp_path: Path) -> None:
    """Explicit mime_type that contradicts the magic bytes loses: the file
    content identifies a different known type, so dispatch follows the sniff
    and resolved_mime records what was actually used."""
    jpg = tmp_path / "actual.jpg"
    Image.new("RGB", (8, 8)).save(jpg, "JPEG")

    embedder = SmartEmbedder()
    result = embedder.embed(jpg, _make_manifest(), mime_type="image/png")
    assert result.method == "inline"  # JpegHandler, not PngHandler
    assert result.resolved_mime == "image/jpeg"


def test_explicit_mime_matching_magic_is_used(tmp_path: Path) -> None:
    """Explicit mime_type consistent with the magic bytes is used as-is."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    embedder = SmartEmbedder()
    result = embedder.embed(png, _make_manifest(), mime_type="image/png")
    assert result.method == "inline"
    assert result.resolved_mime == "image/png"


def test_explicit_mime_wins_when_magic_unrecognized(tmp_path: Path) -> None:
    """When the magic bytes are not a known signature, the explicit mime_type
    is authoritative — here it routes fake bytes to Mp4Handler, which rejects
    them, exercising the inline-failure → sidecar fallback."""
    src = tmp_path / "blob.bin"
    src.write_bytes(b"not a known signature")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest(), mime_type="video/mp4")
    assert result.method == "sidecar"
    assert result.resolved_mime == "video/mp4"
    assert result.embed_error is not None


def test_magic_conflict_with_extension_prefers_magic(tmp_path: Path) -> None:
    """No explicit mime_type: JPEG bytes in a .png-named file dispatch to the
    JPEG handler, and resolved_mime records the sniffed type."""
    misnamed = tmp_path / "looks_like.png"
    Image.new("RGB", (8, 8)).save(misnamed, "JPEG")  # JPEG bytes, .png suffix

    embedder = SmartEmbedder()
    result = embedder.embed(misnamed, _make_manifest())
    assert result.method == "inline"
    assert result.resolved_mime == "image/jpeg"


def test_extension_fallback_resolved_mime(tmp_path: Path) -> None:
    """Unknown content + known extension: resolved_mime comes from the
    extension map (here routing to the failing Mp4Handler → sidecar)."""
    src = tmp_path / "raw.mp4"
    src.write_bytes(b"\x00\x00\x00\x10not really an mp4")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.resolved_mime == "video/mp4"


# --- Result-field semantics per mode ----------------------------------------


def test_inline_success_fields(tmp_path: Path) -> None:
    """Inline success: method=inline, sidecar_path=None, embed_error=None,
    resolved_mime set."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)

    embedder = SmartEmbedder()
    result = embedder.embed(png, _make_manifest())
    assert result.method == "inline"
    assert result.sidecar_path is None
    assert result.embed_error is None
    assert result.resolved_mime == "image/png"


def test_inline_failure_fallback_fields(tmp_path: Path) -> None:
    """Inline failure → sidecar: method=sidecar, sidecar_path non-empty,
    embed_error carries the exception type and message."""
    src = tmp_path / "broken.mp4"
    src.write_bytes(b"fake video data")

    embedder = SmartEmbedder()
    result = embedder.embed(src, _make_manifest())
    assert result.method == "sidecar"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()
    assert result.embed_error is not None
    # "ExceptionType: message" — both halves present.
    exc_type, _, exc_msg = result.embed_error.partition(": ")
    assert exc_type and exc_msg
    assert "Error" in exc_type  # EmbeddingError or a handler-specific subclass


def test_none_mode_writes_nothing_and_skips_validation(tmp_path: Path) -> None:
    """embed_mode=none writes no files and performs no hash/policy validation:
    a policy combination that would raise ManifestError in full mode is
    inert here, and no sidecar appears."""
    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    before = png.read_bytes()

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="none", prompt_visibility=PromptVisibility.PRIVATE)
    result = embedder.embed(png, _make_manifest(), policy=policy)

    assert result.method == "none"
    assert result.sidecar_path is None
    assert result.manifest_uri is None
    assert result.resolved_mime is None
    assert result.embed_error is None
    assert png.read_bytes() == before
    assert not png.with_suffix(png.suffix + ".genblaze.json").exists()


def test_pointer_mode_writes_only_pointer_json(tmp_path: Path) -> None:
    """embed_mode=pointer writes only the pointer JSON sidecar and returns
    its path plus manifest_uri; the media bytes are untouched."""
    import json

    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    before = png.read_bytes()

    manifest = _make_manifest()
    manifest.manifest_uri = "https://example.com/manifests/abc.json"

    embedder = SmartEmbedder()
    policy = EmbedPolicy(embed_mode="pointer", prompt_visibility=PromptVisibility.PRIVATE)
    result = embedder.embed(png, manifest, policy=policy)

    assert result.method == "pointer"
    assert result.sidecar_path is not None
    assert result.sidecar_path.exists()
    assert result.manifest_uri == "https://example.com/manifests/abc.json"
    assert result.path == png
    assert png.read_bytes() == before

    pointer = json.loads(result.sidecar_path.read_text(encoding="utf-8"))
    assert pointer["manifest_uri"] == "https://example.com/manifests/abc.json"
    assert pointer["canonical_hash"] == manifest.canonical_hash
    assert "run" not in pointer


# --- Hash/payload consistency guard -----------------------------------------


def test_hash_mismatch_policy_leaves_output_untouched(tmp_path: Path) -> None:
    """A policy that would desynchronize hash and payload (full mode +
    redaction) must raise ManifestError BEFORE any write: a pre-existing
    output file keeps its exact bytes and no sidecar is created."""
    import pytest
    from genblaze_core.exceptions import ManifestError

    png = tmp_path / "test.png"
    Image.new("RGBA", (1, 1)).save(png)
    src_before = png.read_bytes()

    out = tmp_path / "out.png"
    sentinel = b"pre-existing output - must survive"
    out.write_bytes(sentinel)

    embedder = SmartEmbedder()
    policy = EmbedPolicy(prompt_visibility=PromptVisibility.PRIVATE)
    with pytest.raises(ManifestError, match="embed_mode='pointer'"):
        embedder.embed(png, _make_manifest(), output=out, policy=policy)

    assert out.read_bytes() == sentinel
    assert png.read_bytes() == src_before
    assert not out.with_suffix(out.suffix + ".genblaze.json").exists()
    assert not png.with_suffix(png.suffix + ".genblaze.json").exists()


def test_hash_mismatch_policy_source_only_creates_nothing(tmp_path: Path) -> None:
    """Same guard without output=: the source is unmodified and no sidecar
    file appears next to it."""
    import pytest
    from genblaze_core.exceptions import ManifestError

    src = tmp_path / "test.mp4"
    src.write_bytes(b"fake video data")
    before = src.read_bytes()

    embedder = SmartEmbedder()
    policy = EmbedPolicy(include_seed=False)
    with pytest.raises(ManifestError):
        embedder.embed(src, _make_manifest(), policy=policy)

    assert src.read_bytes() == before
    assert not src.with_suffix(src.suffix + ".genblaze.json").exists()
