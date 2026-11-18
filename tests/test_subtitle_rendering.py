"""Tests for subtitle timing selection and multi-line subtitle rendering."""
import pytest
from PIL import Image, ImageDraw, ImageFont

from audiogram_generator.rendering.compositor import (
    _render_subtitle_lines,
    _strip_punctuation,
)
from audiogram_generator.rendering.layouts import (
    LAYOUT_CONFIGS,
    SUBTITLE_Y_OFFSET_DEFAULTS,
    _precompute_transcript,
    _select_transcript_chunk,
)

FONT = ImageFont.load_default(size=20)

BACKGROUND = (200, 200, 200)
BOX = (0, 0, 0, 255)

COLORS = {
    'text': (255, 255, 255),
    'transcript_bg': (0, 0, 0),
}

FORMATS = {'vertical': (1080, 1920), 'square': (1080, 1080), 'horizontal': (1920, 1080)}


def _style(**overrides):
    style = {
        'text_color': (255, 255, 255),
        'bg_color': BOX,
        'padding': 6,
        'radius': 4,
        'line_spacing': 1.4,
        'shadow': False,
        'shadow_offset': (0, 0),
        'shadow_blur': 0,
        'max_lines': 5,
        'width_ratio': 0.9,
    }
    style.update(overrides)
    return style


def _draw_lines(text, max_width=200, style=None, width=320, height=400, start_y=20):
    img = Image.new('RGB', (width, height), BACKGROUND)
    draw = ImageDraw.Draw(img)
    img, total_height = _render_subtitle_lines(
        img, draw, text, FONT, start_y, max_width, style or _style()
    )
    return img, total_height


def _bands(img, background=None, threshold=60):
    """Return [(top, bottom, left, right)] for each contiguous non-background band."""
    background = background or BACKGROUND
    pixels = img.convert('RGB').load()

    def is_fg(x, y):
        pixel = pixels[x, y]
        distance = sum(abs(pixel[i] - background[i]) for i in range(3))
        return distance > threshold

    rows = []
    for y in range(img.height):
        cols = [x for x in range(img.width) if is_fg(x, y)]
        if cols:
            rows.append((y, min(cols), max(cols)))

    bands = []
    for y, left, right in rows:
        if bands and bands[-1][1] == y - 1:
            top, _, band_left, band_right = bands[-1]
            bands[-1] = (top, y, min(band_left, left), max(band_right, right))
        else:
            bands.append((y, y, left, right))
    return bands


# ---------------------------------------------------------------- timing


def _chunks():
    return [
        {'start': 0.0, 'end': 2.0, 'text': 'first'},
        {'start': 2.0, 'end': 4.0, 'text': 'second'},
        {'start': 4.0, 'end': 6.0, 'text': 'third'},
    ]


@pytest.mark.parametrize("time, expected", [
    (1.999, 'first'),
    (2.0, 'second'),      # boundary frame goes to the later chunk
    (2.001, 'second'),
    (3.999, 'second'),
    (4.0, 'third'),
    (5.5, 'third'),
])
def test_contiguous_boundary_belongs_to_later_chunk(time, expected):
    chunk = _select_transcript_chunk(_chunks(), time)
    assert chunk is not None
    assert chunk['text'] == expected


def test_no_chunk_outside_intervals():
    assert _select_transcript_chunk(_chunks(), -0.5) is None
    assert _select_transcript_chunk(_chunks(), 6.0) is None


def test_gap_between_non_contiguous_chunks_is_blank():
    chunks = [
        {'start': 0.0, 'end': 1.0, 'text': 'first'},
        {'start': 2.0, 'end': 3.0, 'text': 'second'},
    ]
    assert _select_transcript_chunk(chunks, 1.0) is None
    assert _select_transcript_chunk(chunks, 1.5) is None
    assert _select_transcript_chunk(chunks, 2.0)['text'] == 'second'


def test_selection_is_unique_when_chunks_overlap():
    chunks = [
        {'start': 0.0, 'end': 3.0, 'text': 'early'},
        {'start': 2.0, 'end': 4.0, 'text': 'late'},
    ]
    # Exactly one chunk is returned even though both intervals cover 2.5s.
    assert _select_transcript_chunk(chunks, 2.5)['text'] == 'late'


def test_rounding_noise_at_boundary_is_snapped():
    chunks = [
        {'start': 0.0, 'end': 2.0000001, 'text': 'first'},
        {'start': 2.0, 'end': 4.0, 'text': 'second'},
    ]
    # Without snapping both intervals would match; the later chunk still wins.
    assert _select_transcript_chunk(chunks, 2.0)['text'] == 'second'
    # And the frame just before the boundary is not blank.
    assert _select_transcript_chunk(chunks, 1.9999999)['text'] == 'first'


def test_selection_does_not_depend_on_input_order():
    chunks = list(reversed(_chunks()))
    assert _select_transcript_chunk(chunks, 2.0)['text'] == 'second'


# ---------------------------------------------------------- line limiting


def test_lines_are_capped_by_max_lines():
    style = _style(max_lines=2)
    img, _ = _draw_lines("one two three four five six seven eight nine ten", style=style)
    bands = _bands(img)
    assert len(bands) == 2


def test_max_lines_is_at_least_one():
    img, _ = _draw_lines("just one line", style=_style(max_lines=0))
    assert len(_bands(img)) == 1


# ------------------------------------------------------- background boxes


def test_multi_line_boxes_share_width_and_centre():
    img, _ = _draw_lines("alpha beta gamma delta epsilon zeta eta theta")
    bands = _bands(img)
    assert len(bands) >= 2

    # Middle row of each band has the full box width (away from rounded corners).
    extents = []
    for top, bottom, left, right in bands:
        mid = (top + bottom) // 2
        pixels = img.convert('RGB').load()
        dark = [x for x in range(img.width) if pixels[x, mid] == (0, 0, 0)]
        extents.append((min(dark), max(dark)))

    lefts = {left for left, _ in extents}
    rights = {right for _, right in extents}
    assert len(lefts) == 1
    assert len(rights) == 1


def test_multi_line_boxes_do_not_overlap():
    img, _ = _draw_lines("alpha beta gamma delta epsilon zeta eta theta iota kappa")
    bands = _bands(img)
    assert len(bands) >= 2
    for (top1, bottom1, _, _), (top2, _, _, _) in zip(bands, bands[1:]):
        assert top2 > bottom1


def test_block_stays_inside_band_bounds():
    style = _style(min_y=10, max_y=150)
    img, _ = _draw_lines(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu",
        style=style,
        start_y=140,
    )
    bands = _bands(img)
    assert bands
    assert bands[0][0] >= 10
    assert bands[-1][1] <= 150


def test_block_is_shifted_up_when_it_would_cross_bottom():
    style = _style(min_y=10, max_y=150)
    img, _ = _draw_lines(
        "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        style=style,
        start_y=80,
    )
    bands = _bands(img)
    assert bands[-1][1] <= 150


def test_single_line_box_matches_previous_behaviour():
    text = "hello world"
    style = _style()
    img, _ = _draw_lines(text, width=320, height=120, start_y=40, style=style)
    bands = _bands(img)
    assert len(bands) == 1

    tmp = Image.new('RGB', (10, 10))
    draw = ImageDraw.Draw(tmp)
    bbox = draw.textbbox((0, 0), text, font=FONT)
    lw = bbox[2] - bbox[0]
    lh = bbox[3] - bbox[1]
    padding = style['padding']

    top, bottom, left, right = bands[0]
    assert abs((right - left + 1) - (lw + 2 * padding)) <= 2
    assert abs((bottom - top + 1) - (lh + 2 * padding)) <= 2


# ------------------------------------------------------------ text cleanup


def test_punctuation_removed_and_whitespace_collapsed():
    assert _strip_punctuation("Hello,   world!  It’s  fine…") == "Hello world It s fine"


# ------------------------------------------------- per-format integration


LONG_TEXT = (
    "Questo e un sottotitolo molto lungo che dovrebbe andare a capo piu volte "
    "per verificare che il blocco resti dentro la fascia centrale e che le righe "
    "siano allineate sullo stesso centro con la stessa larghezza di sfondo"
)


def _render_format(fmt, text=LONG_TEXT, layout=None):
    """Render one subtitle line-set and return (image, boxes, band bounds).

    ``boxes`` are the background rectangles exactly as drawn, captured by
    wrapping ``_draw_rounded_box_with_shadow``.
    """
    from audiogram_generator.rendering import compositor
    from audiogram_generator.rendering.layouts import _render_transcript

    width, height = FORMATS[fmt]
    layout = layout or LAYOUT_CONFIGS[fmt]
    cache = _precompute_transcript(width, height, layout, COLORS)

    img = Image.new('RGB', (width, height), (235, 213, 197))
    draw = ImageDraw.Draw(img)
    central_top = int(height * layout['header_ratio'])
    central_height = int(height * layout['central_ratio'])

    boxes = []
    original = compositor._draw_rounded_box_with_shadow

    def capture(base, box, fill, **kwargs):
        boxes.append(tuple(box))
        return original(base, box, fill, **kwargs)

    compositor._draw_rounded_box_with_shadow = capture
    try:
        img, _ = _render_transcript(
            img, draw, width, height, central_top, central_height,
            central_top + central_height,
            [{'start': 0.0, 'end': 1.0, 'text': text}],
            0.5, layout, COLORS, transcript_cache=cache,
        )
    finally:
        compositor._draw_rounded_box_with_shadow = original

    return img, boxes, (central_top, central_top + central_height)


def test_format_defaults_are_unchanged():
    assert SUBTITLE_Y_OFFSET_DEFAULTS == {
        'vertical': 0.84, 'square': 0.15, 'horizontal': 0.12,
    }
    assert {fmt: LAYOUT_CONFIGS[fmt]['max_lines'] for fmt in FORMATS} == {
        'vertical': 5, 'square': 3, 'horizontal': 2,
    }
    for fmt, default in SUBTITLE_Y_OFFSET_DEFAULTS.items():
        assert LAYOUT_CONFIGS[fmt]['transcript_y_offset'] == default


@pytest.mark.parametrize("fmt", list(FORMATS))
def test_rendered_block_respects_max_lines_and_band(fmt):
    _, boxes, (band_top, band_bottom) = _render_format(fmt)

    assert 1 <= len(boxes) <= LAYOUT_CONFIGS[fmt]['max_lines']
    assert boxes[0][1] >= band_top
    assert boxes[-1][3] <= band_bottom


@pytest.mark.parametrize("fmt", list(FORMATS))
def test_rendered_rows_share_width_and_centre(fmt):
    _, boxes, _ = _render_format(fmt)
    assert len(boxes) >= 2

    assert len({box[0] for box in boxes}) == 1
    assert len({box[2] for box in boxes}) == 1
    for box, next_box in zip(boxes, boxes[1:]):
        assert next_box[1] >= box[3]


def test_offset_below_half_is_measured_from_band_bottom():
    layout = dict(LAYOUT_CONFIGS['square'], transcript_y_offset=0.10)
    width, height = FORMATS['square']
    cache = _precompute_transcript(width, height, layout, COLORS)
    central_top = int(height * layout['header_ratio'])
    central_height = int(height * layout['central_ratio'])
    expected = central_top + central_height - int(central_height * 0.10)
    assert cache['transcript_y'] == expected

    layout_top = dict(LAYOUT_CONFIGS['square'], transcript_y_offset=0.60)
    cache_top = _precompute_transcript(width, height, layout_top, COLORS)
    assert cache_top['transcript_y'] == central_top + int(central_height * 0.60)


def test_y_offset_at_extreme_is_clamped_inside_band():
    layout = dict(LAYOUT_CONFIGS['vertical'], transcript_y_offset=1.0)
    _, boxes, (band_top, band_bottom) = _render_format('vertical', layout=layout)
    assert boxes
    assert boxes[0][1] >= band_top
    assert boxes[-1][3] <= band_bottom


def test_offset_above_band_top_is_clamped_inside_band():
    # Offsets >= 0.5 are measured from the band top, so 1.0 aims at the very
    # bottom edge: a multi-line block must be pulled back up inside the band.
    layout = dict(LAYOUT_CONFIGS['horizontal'], transcript_y_offset=1.0)
    _, boxes, (band_top, band_bottom) = _render_format('horizontal', layout=layout)
    assert boxes
    assert boxes[0][1] >= band_top
    assert boxes[-1][3] <= band_bottom
