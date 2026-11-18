# SPDX-FileCopyrightText: 2014-2026 tinytag Contributors
# SPDX-License-Identifier: MIT

"""Audio file metadata reader."""

__version__ = '2.3.2'

from .tinytag import (
    TinyTag, TagReadResult, Image, Images, OtherFields, OtherImages,
    TinyTagException, ParseError, UnsupportedFormatError
)
__all__ = (
    "TinyTag", "TagReadResult", "Image", "Images", "OtherFields",
    "OtherImages", "TinyTagException", "ParseError",
    "UnsupportedFormatError"
)
