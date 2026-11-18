"""
Unit tests for image processing service, including large image handling.
"""
import base64
from io import BytesIO

import numpy as np
import pytest
from PIL import Image

from config.settings import settings
from services.image_processor import (
    MAX_PROCESSING_DIMENSION,
    build_simulated_print_preview,
    build_vector_simulated_preview,
    merge_small_pixels_to_neighbors,
    process_image,
    resample_to_model_grid,
)
from tests.label_maps import labels_from_blocks

PNG_PREFIX = "data:image/png;base64,"
PALETTE_ENTRY_KEYS = {
    "code", "rgb", "hex", "sourceRgb", "sourceHex", "pixelCount", "pixelPercent",
}


def _create_image_bytes(width, height, color=(255, 0, 0), fmt='PNG'):
    """Create an image of given size and return as bytes."""
    img = Image.new('RGB', (width, height), color)
    buf = BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def _decode_data_url_image(data_url: str) -> np.ndarray:
    """Decode a PNG data URL into an RGB numpy array."""
    encoded = data_url.split(",", 1)[1]
    image_bytes = base64.b64decode(encoded)
    return np.array(Image.open(BytesIO(image_bytes)).convert("RGB"))


class TestModelGrid:
    """The model grid resolution policy (resample_to_model_grid)."""

    def test_image_within_the_limits_keeps_its_pitch(self):
        img = Image.new('RGB', (100, 100))
        result, pitch = resample_to_model_grid(img, 0.05, 0.42)
        assert result.size == (100, 100)
        assert pitch == 0.05

    def test_cell_budget_bounds_the_grid(self, monkeypatch):
        monkeypatch.setattr(settings, "max_model_cells", 10_000)
        img = Image.new('RGB', (400, 300))
        result, pitch = resample_to_model_grid(img, 1.0, None)
        assert result.size[0] * result.size[1] <= 10_000
        assert max(result.size) * pitch == pytest.approx(400.0)

    def test_side_length_is_capped(self):
        img = Image.new('RGB', (MAX_PROCESSING_DIMENSION + 500, 10))
        result, _ = resample_to_model_grid(img, 1.0, None)
        assert max(result.size) <= MAX_PROCESSING_DIMENSION

    def test_forced_pitch_below_one_detail_snaps_to_the_detail(self, monkeypatch):
        # The cell budget alone would give 0.3 mm cells; with 0.42 mm detail
        # the grid uses whole detail-width cells instead.
        monkeypatch.setattr(settings, "max_model_cells", 10_000)
        img = Image.new('RGB', (300, 300))
        result, pitch = resample_to_model_grid(img, 0.1, 0.42)
        assert pitch >= 0.42
        assert result.size == (71, 71)

    def test_native_pixel_art_is_not_resampled(self):
        # 0.3 mm pixels with 0.42 mm detail stay crisp when no limit forces resampling.
        img = Image.new('RGB', (64, 64))
        result, pitch = resample_to_model_grid(img, 0.3, 0.42)
        assert result.size == (64, 64)
        assert pitch == 0.3

    def test_resampled_grid_passes_through_unchanged(self, monkeypatch):
        monkeypatch.setattr(settings, "max_model_cells", 100_000)
        img = Image.new('RGB', (2000, 1500))
        once, pitch = resample_to_model_grid(img, 0.05, 0.42)
        twice, again = resample_to_model_grid(once, pitch, 0.42)
        assert twice.size == once.size
        assert again == pitch

    @pytest.mark.parametrize("size", [(1, 10000), (10000, 1)])
    def test_extreme_aspect_ratio_keeps_every_side(self, size):
        result, _ = resample_to_model_grid(Image.new('RGB', size), 1.0, None)
        assert min(result.size) >= 1


class TestProcessImageLargeHandling:
    """Tests for process_image with large images."""

    def test_small_image_processes(self):
        """Small image processes correctly."""
        img_bytes = _create_image_bytes(4, 4, color=(255, 0, 0))
        result = process_image(img_bytes)
        assert result['imageDimensions']['width'] == 4
        assert result['imageDimensions']['height'] == 4
        assert len(result['colorBlocks']) > 0

    def test_large_image_auto_downscaled(self):
        """Large image is automatically downscaled."""
        # Create an image larger than MAX_PROCESSING_DIMENSION
        large_dim = MAX_PROCESSING_DIMENSION + 500
        img_bytes = _create_image_bytes(large_dim, large_dim, color=(0, 255, 0))
        result = process_image(img_bytes)

        # Dimensions should be <= MAX_PROCESSING_DIMENSION
        assert result['imageDimensions']['width'] <= MAX_PROCESSING_DIMENSION
        assert result['imageDimensions']['height'] <= MAX_PROCESSING_DIMENSION

    def test_process_returns_valid_preview(self):
        """Process returns a valid base64 PNG preview."""
        img_bytes = _create_image_bytes(8, 8, color=(0, 0, 255))
        result = process_image(img_bytes)
        assert result['processedImage'].startswith('data:image/png;base64,')
        assert result['segmentationImage'].startswith('data:image/png;base64,')
        assert isinstance(result['mappedBlockColors'], list)
        assert isinstance(result['mappedBlendPalette'], list)
        assert len(result['mappedBlendPalette']) > 0

    def test_process_with_multiple_colors(self):
        """Process handles image with multiple colors."""
        img = Image.new('RGB', (4, 4))
        pixels = img.load()
        pixels[0, 0] = (255, 0, 0)
        pixels[1, 0] = (0, 255, 0)
        pixels[2, 0] = (0, 0, 255)
        pixels[3, 0] = (255, 255, 255)
        for y in range(1, 4):
            for x in range(4):
                pixels[x, y] = pixels[x, 0]

        buf = BytesIO()
        img.save(buf, format='PNG')

        result = process_image(buf.getvalue(), max_colors=4)
        assert len(result['colorBlocks']) <= 4
        assert len(result['mappedBlockColors']) == len(result['colorBlocks'])
        assert len(result['mappedBlendPalette']) == len(result['colorBlocks'])

    def test_simulated_preview_palette_counts_match_pixels(self):
        """Mapped blend palette accounts for every pixel in the image."""
        color_blocks = [
            {
                'r': 255,
                'g': 0,
                'b': 0,
                'hex': '#ff0000',
                'count': 3,
                'cells': [(0, 0), (1, 0), (0, 1)],
            },
            {
                'r': 0,
                'g': 0,
                'b': 255,
                'hex': '#0000ff',
                'count': 1,
                'cells': [(1, 1)],
            },
        ]

        result = build_simulated_print_preview(
            color_blocks=color_blocks,
            labels=labels_from_blocks(color_blocks, 2, 2),
            white_backing_layers=0,
        )

        assert result['processedImage'].startswith('data:image/png;base64,')
        assert len(result['mappedBlockColors']) == len(color_blocks)
        assert sum(entry['pixelCount'] for entry in result['mappedBlendPalette']) == 4
        assert result['mappedBlendPalette'][0]['pixelPercent'] >= result['mappedBlendPalette'][1]['pixelPercent']
        assert result['printStack']['whiteBackingLayers'] == 0
        assert result['printStack']['totalLayerCount'] == 4

    def test_vector_simulated_preview_returns_palette_and_image(self):
        """SVG preview uses printable blends and reports palette coverage."""
        quantized = np.array(
            [
                [[255, 0, 0], [255, 0, 0]],
                [[0, 0, 255], [0, 0, 255]],
            ],
            dtype=np.uint8,
        )
        vector_results = [
            {
                "color": (255, 0, 0),
                "regions": [{"outer": [(0, 0), (1, 0), (1, 1), (0, 1)], "holes": []}],
                "pixel_count": 2,
                "polygon_points": 4,
            },
            {
                "color": (0, 0, 255),
                "regions": [{"outer": [(0, 1), (1, 1), (1, 2), (0, 2)], "holes": []}],
                "pixel_count": 2,
                "polygon_points": 4,
            },
        ]

        result = build_vector_simulated_preview(
            quantized_image=quantized,
            vector_results=vector_results,
            pixel_size=0.42,
            detail_size=None,
            white_backing_layers=0,
        )

        assert result['processedImage'].startswith('data:image/png;base64,')
        assert len(result['mappedBlendPalette']) == 2
        assert sum(entry['pixelCount'] for entry in result['mappedBlendPalette']) == 4
        assert result['printStack']['whiteBackingLayers'] == 0

    def test_vector_simulated_preview_uses_final_geometry_not_quantized_pixels(self):
        """The preview fills vector gaps using the final printable partition."""
        quantized = np.array(
            [
                [[0, 255, 0], [0, 255, 0], [0, 255, 0]],
                [[0, 255, 0], [0, 255, 0], [0, 255, 0]],
                [[0, 255, 0], [0, 255, 0], [0, 255, 0]],
            ],
            dtype=np.uint8,
        )
        vector_results = [
            {
                "color": (255, 0, 0),
                "regions": [{
                    "outer": [(0, 0), (2, 0), (2, 2), (0, 2)],
                    "holes": [[(1, 1), (2, 1), (2, 2), (1, 2)]],
                }],
                "pixel_count": 8,
                "polygon_points": 8,
            }
        ]

        result = build_vector_simulated_preview(
            quantized_image=quantized,
            vector_results=vector_results,
            pixel_size=0.42,
            detail_size=None,
            white_backing_layers=0,
        )

        preview = _decode_data_url_image(result['processedImage'])
        hole_pixel = tuple(int(v) for v in preview[1, 1])
        # Quantized green deliberately disagrees with the red printable
        # region. A gap must use the exported region's blend, not the
        # quantized-image background blend.
        assert hole_pixel == tuple(int(v) for v in preview[0, 0])

    def test_vector_preview_omits_regions_removed_by_print_cleanup(self):
        """The response palette contains only material regions still printed."""
        quantized = np.zeros((20, 20, 3), dtype=np.uint8)
        vector_results = [
            {
                'color': (0, 0, 255),
                'regions': [{'outer': [(0, 0), (19, 0), (19, 19), (0, 19)], 'holes': []}],
            },
            {
                'color': (255, 0, 0),
                'regions': [{'outer': [(9, 9), (10, 9), (10, 10), (9, 10)], 'holes': []}],
            },
        ]
        result = build_vector_simulated_preview(
            quantized_image=quantized,
            vector_results=vector_results,
            pixel_size=0.1,
            detail_size=0.9,
            white_backing_layers=0,
        )

        palette = result['mappedBlendPalette']
        assert len(palette) == 1
        assert palette[0]['pixelCount'] == 400
        assert _decode_data_url_image(result['processedImage']).shape == (20, 20, 3)

    def test_small_components_merge_without_global_scaling(self):
        """detail_size merges local components instead of enlarging the full image."""
        color_blocks = [
            {'r': 255, 'g': 0, 'b': 0, 'hex': '#ff0000', 'count': 1, 'cells': [(0, 0)]},
            {'r': 250, 'g': 10, 'b': 10, 'hex': '#fa0a0a', 'count': 1, 'cells': [(1, 0)]},
            {
                'r': 0, 'g': 0, 'b': 255, 'hex': '#0000ff', 'count': 10,
                'cells': ([(x, 0) for x in range(2, 6)]
                           + [(x, 1) for x in range(6)]),
            },
        ]

        merged, labels = merge_small_pixels_to_neighbors(
            color_blocks=color_blocks,
            labels=labels_from_blocks(color_blocks, 6, 2),
            pixel_size=0.2,
            detail_size=0.4,
        )

        assert len(merged) == 1
        assert int((labels == 0).sum()) == 12

    def test_single_component_image_is_preserved(self):
        """A single-region image has no valid merge target and remains unchanged."""
        color_blocks = [
            {
                'r': 255, 'g': 0, 'b': 0, 'hex': '#ff0000', 'count': 4,
                'cells': [(x, y) for y in range(2) for x in range(2)],
            },
        ]

        merged, labels = merge_small_pixels_to_neighbors(
            color_blocks=color_blocks,
            labels=labels_from_blocks(color_blocks, 2, 2),
            pixel_size=0.2,
            detail_size=0.4,
        )

        assert len(merged) == 1
        assert int((labels == 0).sum()) == 4

    def test_process_image_widens_a_connector_between_large_regions(self):
        pixels = np.full((40, 50, 3), 255, dtype=np.uint8)
        pixels[10:30, 2:17] = 0
        pixels[10:30, 22:37] = 0
        pixels[20, 17:22] = 0
        image_bytes = BytesIO()
        Image.fromarray(pixels).save(image_bytes, format='PNG')

        result = process_image(
            image_bytes.getvalue(), max_colors=2, color_threshold=0,
            pixel_size=0.1, detail_size=0.42,
        )
        black = next(block for block in result['colorBlocks'] if block['r'] == 0)
        black_index = result['colorBlocks'].index(black)
        assert all(
            result['labels'][y, x] == black_index
            for y in range(18, 23) for x in range(17, 22)
        )
        assert result['imageDimensions'] == {'width': 50, 'height': 40}

    def test_tiny_hole_disappears(self):
        """A sub-threshold hole is absorbed into the surrounding region."""
        color_blocks = [
            {
                'r': 255, 'g': 0, 'b': 0, 'hex': '#ff0000', 'count': 8,
                'cells': [
                    (0, 0), (1, 0), (2, 0),
                    (0, 1), (2, 1),
                    (0, 2), (1, 2), (2, 2),
                ],
            },
            {
                'r': 0, 'g': 0, 'b': 255, 'hex': '#0000ff', 'count': 1,
                'cells': [(1, 1)],
            },
        ]

        merged, labels = merge_small_pixels_to_neighbors(
            color_blocks=color_blocks,
            labels=labels_from_blocks(color_blocks, 3, 3),
            pixel_size=0.2,
            detail_size=0.4,
        )

        assert len(merged) == 1
        assert int((labels == 0).sum()) == 9


def _stained_glass_bytes(width=240, height=180):
    """Colored panes separated by thin diagonal and curved lead lines."""
    from PIL import ImageDraw

    image = Image.new('RGB', (width, height), (200, 30, 30))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width // 2, height), fill=(40, 70, 200))
    draw.polygon([(width // 2, 0), (width, 0), (width, height // 2)], fill=(230, 200, 40))
    for offset in range(-height, width, 23):
        draw.line((offset, 0, offset + height, height), fill=(10, 10, 10), width=1)
    for offset in range(0, width + height, 31):
        draw.line((offset, 0, offset - height, height), fill=(15, 15, 15), width=2)
    draw.ellipse((60, 40, 180, 140), outline=(5, 5, 5), width=2)
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


@pytest.mark.parametrize('pixel_size', [200 / 1270, 0.1])
def test_every_exported_pixel_region_holds_the_detail_width(pixel_size):
    """Thin diagonal lines must leave no sub-detail material in the export grid."""
    from services.raster_cleanup import unprintable_pixels

    result = process_image(
        _stained_glass_bytes(), max_colors=6, color_threshold=30,
        pixel_size=pixel_size, layer_count=4, layer_height=0.08, detail_size=0.42,
    )
    width = result['imageDimensions']['width']
    height = result['imageDimensions']['height']
    labels = result['labels'].astype(np.int32)

    assert np.all(labels >= 0)
    assert unprintable_pixels(labels, 0.42 / pixel_size / 2).sum() <= 0.001 * labels.size
    dark = [index for index, block in enumerate(result['colorBlocks']) if block['r'] + block['g'] + block['b'] < 150]
    assert dark and np.isin(labels, dark).sum() > 0.05 * labels.size


def test_exports_reuse_the_mapping_processing_computed(monkeypatch):
    """The same sources against the same reference matrix map once; the cached
    result goes away with its matrix."""
    import gc

    import services.image_processor as image_processor
    from core.blend_color import Colors
    from core.color_config import get_preset
    from core.color_materials import Color
    from services.stl_generator import map_color_blocks_to_blend_results

    from services.stl_generator import compute_reference_matrices

    colors = Colors.from_configs(get_preset("bambu_cmywk"))
    blocks = [{'r': 200, 'g': 40, 'b': 60}, {'r': 20, 'g': 90, 'b': 180}]
    sources = [(b['r'], b['g'], b['b']) for b in blocks]
    compute_reference_matrices(4, 0.08, colors, n_targets=2, backing_layers=3)  # runs the one-time cost probe
    calls = []
    original = Color.map_to_nearest_color
    monkeypatch.setattr(Color, "map_to_nearest_color", staticmethod(lambda *a: calls.append(1) or original(*a)))

    first = image_processor._map_source_colors_to_blends(sources, colors, 4, 0.08, backing_layers=3)
    second = map_color_blocks_to_blend_results(blocks, 0.08, 4, colors, backing_layers=3)
    assert first == second
    assert len(calls) == 1

    image_processor._mapping_cache.clear()  # entries also leave with their matrix:
    matrix, _ = compute_reference_matrices(4, 0.08, colors, n_targets=2, backing_layers=3)
    image_processor._matrix_mappings(matrix)
    assert id(matrix) in image_processor._mapping_cache
    matrix_id = id(matrix)
    from services.matrix_cache import clear_cache
    clear_cache()
    del matrix
    gc.collect()
    assert matrix_id not in image_processor._mapping_cache


def _rgba_png(pixels: np.ndarray) -> bytes:
    """PNG bytes of an RGBA uint8 array (height, width, 4)."""
    buffer = BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


def _rgb_png(pixels: np.ndarray) -> bytes:
    """PNG bytes of an RGB uint8 array (height, width, 3)."""
    buffer = BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


def _decode_png_data_url(data_url: str) -> np.ndarray:
    assert data_url.startswith(PNG_PREFIX)
    raw = base64.b64decode(data_url[len(PNG_PREFIX):])
    # Image.open raises on a malformed payload; the prefix check confirms PNG.
    with Image.open(BytesIO(raw)) as decoded:
        assert decoded.format == "PNG"
        return np.array(decoded.convert("RGB"))


class TestProcessImageColorInvariants:
    """The post-truncation contract: the three color lists stay one-to-one,
    only occupied colors survive, and the palette pixels conserve the grid."""

    def _assert_invariants(self, result: dict):
        blocks = result["colorBlocks"]
        mapped = result["mappedBlockColors"]
        palette = result["mappedBlendPalette"]
        width = result["imageDimensions"]["width"]
        height = result["imageDimensions"]["height"]
        total_cells = width * height

        # The lists share length and index correspondence.
        assert len(blocks) >= 1
        assert len(blocks) == len(mapped) == len(palette)

        # Every kept block actually occupies at least one grid cell.
        assert all(int(block["count"]) > 0 for block in blocks)

        # Palette entries carry the full required schema.
        for entry in palette:
            assert set(entry.keys()) == PALETTE_ENTRY_KEYS
            assert len(entry["rgb"]) == 3 and len(entry["sourceRgb"]) == 3
            assert entry["hex"][0] == "#" and entry["sourceHex"][0] == "#"
            assert entry["pixelCount"] >= 1
            assert 0 <= entry["pixelPercent"] <= 100

        # Same order, index by index: block -> mapped color -> palette entry.
        for block, mapped_color, entry in zip(blocks, mapped, palette, strict=True):
            source_rgb = [int(block["r"]), int(block["g"]), int(block["b"])]
            assert entry["sourceRgb"] == source_rgb
            assert entry["sourceHex"].lower() == block["hex"].lower()
            assert entry["pixelCount"] == int(block["count"])
            assert mapped_color["code"] == entry["code"]
            assert mapped_color["rgb"] == entry["rgb"]
            assert mapped_color["hex"] == entry["hex"]

        # Pixel conservation: the palette accounts for every grid cell once.
        assert sum(entry["pixelCount"] for entry in palette) == total_cells
        assert sum(block["count"] for block in blocks) == total_cells
        assert sum(entry["pixelPercent"] for entry in palette) == pytest.approx(100.0, abs=0.01)

        # The entries are pixelCount-descending (blocks follow the same order).
        counts = [entry["pixelCount"] for entry in palette]
        assert counts == sorted(counts, reverse=True)

        # Both preview images are valid PNG data URLs at the reported size.
        for key in ("processedImage", "segmentationImage"):
            assert result[key].startswith(PNG_PREFIX)
            decoded = _decode_png_data_url(result[key])
            assert decoded.shape == (height, width, 3)

        # The label map assigns every cell a kept block index.
        labels = result["labels"]
        assert labels.shape == (height, width)
        assert int(labels.min()) >= 0 and int(labels.max()) < len(blocks)
        assert set(np.unique(labels).tolist()) == set(range(len(blocks)))

    def test_fully_transparent_image_becomes_one_white_block(self):
        """A fully transparent image composites onto the white substrate: the
        transparency never becomes a color of its own."""
        pixels = np.zeros((4, 5, 4), dtype=np.uint8)  # alpha 0 everywhere
        result = process_image(_rgba_png(pixels), max_colors=4)

        self._assert_invariants(result)
        assert result["imageDimensions"] == {"width": 5, "height": 4}
        assert len(result["colorBlocks"]) == 1
        block = result["colorBlocks"][0]
        assert (block["r"], block["g"], block["b"]) == (255, 255, 255)
        assert block["count"] == 20
        entry = result["mappedBlendPalette"][0]
        assert entry["sourceRgb"] == [255, 255, 255]
        assert entry["pixelCount"] == 20 and entry["pixelPercent"] == 100.0

    def test_transparent_and_opaque_mix_treats_transparency_as_white(self):
        """Transparent cells join the white substrate instead of clustering."""
        pixels = np.zeros((6, 4, 4), dtype=np.uint8)
        pixels[3:, :] = (255, 0, 0, 255)  # bottom half opaque red, top half transparent

        result = process_image(_rgba_png(pixels), max_colors=4)
        self._assert_invariants(result)

        by_rgb = {
            (block["r"], block["g"], block["b"]): block["count"]
            for block in result["colorBlocks"]
        }
        assert by_rgb == {(255, 0, 0): 12, (255, 255, 255): 12}

        segmentation = _decode_png_data_url(result["segmentationImage"])
        # The transparent top half renders as the white substrate.
        assert np.all(segmentation[:3] == 255)
        assert np.all(segmentation[3:] == [255, 0, 0])

    def test_palette_transparency_index_composites_over_white(self):
        """A palette PNG's transparency index is white, not the palette entry."""
        image = Image.new("P", (4, 4), 0)
        image.info["transparency"] = 0  # palette index 0 is fully transparent
        buffer = BytesIO()
        image.save(buffer, format="PNG")

        result = process_image(buffer.getvalue(), max_colors=4)
        self._assert_invariants(result)
        assert len(result["colorBlocks"]) == 1
        assert (result["colorBlocks"][0]["r"], result["colorBlocks"][0]["g"],
                result["colorBlocks"][0]["b"]) == (255, 255, 255)

    def test_partial_alpha_blends_into_the_white_substrate(self):
        """Semi-transparent pixels are alpha-composited, not dropped."""
        pixels = np.zeros((2, 2, 4), dtype=np.uint8)
        pixels[:] = (255, 0, 0, 128)  # red at 50% over white

        result = process_image(_rgba_png(pixels), max_colors=4)
        self._assert_invariants(result)
        block = result["colorBlocks"][0]
        assert block["count"] == 4
        # 0.5 * 255 red over white -> 255, ~127, ~127; never a separate color.
        assert block["r"] == 255 and 110 <= block["g"] <= 145 and 110 <= block["b"] <= 145

    @pytest.mark.parametrize("size", [(1, 200), (200, 1), (1, 1)])
    def test_extreme_aspect_ratio_keeps_aspect_and_minimum_side(self, size):
        """Resampling keeps both sides >= 1 px and the original aspect ratio."""
        width, height = size
        pixels = np.zeros((height, width, 3), dtype=np.uint8)
        pixels[..., 0] = 40  # dark red, distinct from white
        result = process_image(_rgb_png(pixels), max_colors=2)
        self._assert_invariants(result)

        out_w = result["imageDimensions"]["width"]
        out_h = result["imageDimensions"]["height"]
        assert out_w >= 1 and out_h >= 1
        assert max(out_w, out_h) <= MAX_PROCESSING_DIMENSION
        # The grid is a downscaled version of the original, never transposed.
        assert (out_w == width and out_h <= height) or (out_h == height and out_w <= width)
        assert pytest.approx(out_w / out_h, rel=0.02) == width / height

    def test_long_side_is_capped_for_a_gigantic_strip(self):
        width, height = 1, MAX_PROCESSING_DIMENSION + 500
        pixels = np.full((height, width, 3), (10, 20, 30), dtype=np.uint8)
        result = process_image(_rgb_png(pixels), max_colors=2)
        self._assert_invariants(result)
        assert result["imageDimensions"]["width"] == 1
        assert result["imageDimensions"]["height"] <= MAX_PROCESSING_DIMENSION

    def test_max_colors_below_the_real_color_count_truncates_and_conserves(self):
        """Four distinct colors truncated to two: exactly two blocks, all
        pixels reassigned, counts still summing to the whole grid."""
        columns = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0)]
        pixels = np.zeros((4, 4, 3), dtype=np.uint8)
        for x, color in enumerate(columns):
            pixels[:, x] = color

        result = process_image(_rgb_png(pixels), max_colors=2, color_threshold=0)
        self._assert_invariants(result)
        assert len(result["colorBlocks"]) == 2
        # The truncated-away colors were folded into the surviving main
        # colors, so every palette source is one of the image's own colors and
        # no pixel was lost.
        assert sum(block["count"] for block in result["colorBlocks"]) == 16
        assert all(
            tuple(entry["sourceRgb"]) in set(columns)
            for entry in result["mappedBlendPalette"]
        )

    def test_single_color_image(self):
        """A flat image yields one block covering the whole grid."""
        pixels = np.full((3, 3, 3), (0, 0, 255), dtype=np.uint8)
        result = process_image(_rgb_png(pixels), max_colors=10)
        self._assert_invariants(result)

        assert len(result["colorBlocks"]) == 1
        block = result["colorBlocks"][0]
        assert (block["r"], block["g"], block["b"]) == (0, 0, 255)
        assert block["count"] == 9
        entry = result["mappedBlendPalette"][0]
        assert entry["sourceRgb"] == [0, 0, 255]
        assert entry["sourceHex"] == "#0000FF"
        assert entry["pixelCount"] == 9 and entry["pixelPercent"] == 100.0
        assert len(entry["code"]) >= 1 and len(entry["rgb"]) == 3

    def test_blocks_are_largest_first_under_unequal_counts(self):
        """The canonical descending order survives even when the truncation
        step would otherwise leave blocks in a non-frequency order."""
        # 8 red cells, 2 green, 2 blue -> blocks must arrive largest first.
        pixels = np.full((2, 6, 3), (255, 0, 0), dtype=np.uint8)
        pixels[:, 4] = (0, 255, 0)
        pixels[:, 5] = (0, 0, 255)

        result = process_image(_rgb_png(pixels), max_colors=3, color_threshold=0)
        self._assert_invariants(result)
        assert [block["count"] for block in result["colorBlocks"]] == [8, 2, 2]
        assert [entry["pixelCount"] for entry in result["mappedBlendPalette"]] == [8, 2, 2]

