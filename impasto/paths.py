"""Shared paths (server and printer module)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DATA = Path(os.environ.get("IMPASTO_DATA") or os.environ.get("NPG_DATA") or ROOT / "data")
