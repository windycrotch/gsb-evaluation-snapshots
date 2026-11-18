"""Label maps: the model grid as one byte per cell, row-major, holding the
index of the color block printed there (EMPTY where none is).

Export and preview requests carry the map base64-encoded instead of per-pixel
coordinate lists: 2M cells arrive as ~2.7 MB decoded straight into a numpy
array, where coordinate lists cost ~45 MB of JSON and gigabytes of Python
objects to parse.
"""
import base64
import binascii

import numpy as np

EMPTY = 255
# Block indices 0..254; EMPTY marks cells no block covers.
MAX_BLOCKS = EMPTY


def decode_label_map(encoded: str, width: int, height: int, block_count: int) -> np.ndarray:
    """The (height, width) uint8 label map of a request; ValueError if malformed."""
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("labelMap is not valid base64") from exc
    if len(raw) != width * height:
        raise ValueError(
            f"labelMap has {len(raw):,} cells; a {width}x{height} model has {width * height:,}"
        )
    labels = np.frombuffer(raw, dtype=np.uint8).reshape(height, width)
    used = labels[labels != EMPTY]
    if used.size == 0:
        raise ValueError("labelMap covers no cells")
    if int(used.max()) >= block_count:
        raise ValueError(f"labelMap refers to block {int(used.max())}; there are {block_count} blocks")
    return labels


def block_cell_counts(labels: np.ndarray, block_count: int) -> np.ndarray:
    """Cells per block index."""
    return np.bincount(labels.ravel(), minlength=EMPTY + 1)[:block_count]


def encode_label_map(labels: np.ndarray) -> str:
    """Base64 of a label map's row-major uint8 bytes (decode_label_map's inverse)."""
    return base64.b64encode(np.ascontiguousarray(labels, dtype=np.uint8).tobytes()).decode('ascii')
