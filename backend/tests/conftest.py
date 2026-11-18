"""Test bootstrap.

`backend.app` imports Essentia at module scope because the real analyzer needs it.
Essentia is a heavy optional dependency that is not installed in every environment
(and never in CI containers), so when it is missing we register a tiny stand-in
whose `MusicExtractor` always fails. `extract_music_features` already treats a
failing extractor as "no features", which is exactly the fallback path these
tests want to exercise — no test asserts on Essentia output.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _install_essentia_stub() -> None:
    package = types.ModuleType("essentia")
    standard = types.ModuleType("essentia.standard")

    class MusicExtractor:  # pragma: no cover - only reached when Essentia is absent
        def __init__(self, *args, **kwargs):
            pass

        def __call__(self, *args, **kwargs):
            raise RuntimeError("essentia is not installed in this environment")

    standard.MusicExtractor = MusicExtractor
    package.standard = standard
    sys.modules.setdefault("essentia", package)
    sys.modules.setdefault("essentia.standard", standard)


try:  # pragma: no cover - presence depends on the environment
    import essentia.standard  # noqa: F401
except ImportError:  # pragma: no cover
    _install_essentia_stub()


@pytest.fixture(autouse=True)
def _isolated_analysis_cache(tmp_path):
    """Keep the on-disk analysis cache away from the developer's real ~/.cache.

    Function-scoped on purpose: the cache key is just the audio bytes + stems
    mode, so two tests analyzing the same synthetic file would otherwise serve
    each other's results and silently bypass the code path under test.
    """
    from backend import app as analyzer

    original = analyzer.CACHE_DIR
    analyzer.CACHE_DIR = tmp_path / "analysis-cache"
    yield
    analyzer.CACHE_DIR = original
